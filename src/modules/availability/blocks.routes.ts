import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf, writeAudit } from '../../lib/audit.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { IdParams, objectIdString } from '../../lib/ids.js';
import { IssueSchema } from '../../lib/issues.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import { withTransaction } from '../../lib/tx.js';
import { type BlockDoc, RESOURCE_TYPES, prepareBlock } from './blocks.service.js';
import { LEVEL1 } from './status-codes.js';

const iso = z.string().datetime({ offset: true });

const BlockItem = z.object({
  id: z.string(),
  resourceType: z.enum(RESOURCE_TYPES),
  resourceId: z.string(),
  statusCode: z.string(),
  level1: z.enum(LEVEL1),
  blocksAssignment: z.boolean(),
  from: z.string(),
  to: z.string(),
  note: z.string().nullable(),
  source: z.enum(['manual', 'atms', 'hr']),
  cancelledAt: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
const BlockWithWarnings = BlockItem.extend({ warnings: z.array(IssueSchema) });

export const blockRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = app.requireRoles(...STAFF_ROLES);
  const write = app.requireRoles('admin', 'planner');
  const coll = () => app.db.collection<BlockDoc>(C.resourceBlocks);
  const load = async (id: string) => {
    const b = await coll().findOne({ _id: new ObjectId(id) });
    if (!b) throw notFound('Resource block');
    return b;
  };

  app.post(
    '/resource-blocks',
    {
      schema: {
        tags: ['availability'],
        body: z.object({
          resourceType: z.enum(RESOURCE_TYPES),
          resourceId: objectIdString,
          statusCode: z.string().trim().min(1).max(20),
          from: iso,
          to: iso,
          note: z.string().trim().max(500).nullable().default(null),
        }),
        response: { 201: BlockWithWarnings },
      },
      preHandler: write,
    },
    async (req, reply) => {
      const b = { ...req.body, resourceId: new ObjectId(req.body.resourceId), from: new Date(req.body.from), to: new Date(req.body.to) };
      const { level1, blocksAssignment, warnings } = await prepareBlock(app.db, b);
      const by = actorOf(req);
      const now = new Date();
      const doc: BlockDoc = {
        _id: new ObjectId(), ...b, level1, blocksAssignment, source: 'manual', cancelledAt: null,
        createdBy: by, createdAt: now, updatedBy: by, updatedAt: now,
      };
      await withTransaction(app.mongo, async (session) => {
        await coll().insertOne(doc, { session });
        await writeAudit(app.db, { entity: 'resourceBlock', entityId: doc._id.toHexString(), action: 'create', by, after: toApi(doc) }, { session });
      });
      return reply.status(201).send({ ...toApi(doc), warnings });
    },
  );

  app.get(
    '/resource-blocks',
    {
      schema: {
        tags: ['availability'],
        querystring: PageQuery.extend({
          resourceType: z.enum(RESOURCE_TYPES).optional(),
          resourceId: objectIdString.optional(),
          from: iso.optional(),
          to: iso.optional(),
          includeCancelled: z.enum(['true', 'false']).default('false'),
        }),
        response: { 200: pageResponse(BlockItem) },
      },
      preHandler: read,
    },
    async (req) => {
      const q = req.query;
      const f: Filter<BlockDoc> = {};
      if (q.resourceType) f.resourceType = q.resourceType;
      if (q.resourceId) f.resourceId = new ObjectId(q.resourceId);
      if (q.includeCancelled !== 'true') f.cancelledAt = null;
      if (q.to) f.from = { $lt: new Date(q.to) };
      if (q.from) f.to = { $gt: new Date(q.from) };
      const page = await paginate(coll(), f, q);
      return { items: page.items.map(toApi), nextCursor: page.nextCursor };
    },
  );

  app.patch(
    '/resource-blocks/:id',
    {
      schema: {
        tags: ['availability'],
        params: IdParams,
        body: z.object({
          statusCode: z.string().trim().min(1).max(20).optional(),
          from: iso.optional(),
          to: iso.optional(),
          note: z.string().trim().max(500).nullable().optional(),
        }),
        response: { 200: BlockWithWarnings },
      },
      preHandler: write,
    },
    async (req) => {
      const existing = await load(req.params.id);
      if (existing.cancelledAt) throw unprocessable('BLOCK_CANCELLED', 'A cancelled block cannot be changed');
      const merged = {
        resourceType: existing.resourceType,
        resourceId: existing.resourceId,
        statusCode: req.body.statusCode ?? existing.statusCode,
        from: req.body.from ? new Date(req.body.from) : existing.from,
        to: req.body.to ? new Date(req.body.to) : existing.to,
      };
      const { level1, blocksAssignment, warnings } = await prepareBlock(app.db, merged);
      const by = actorOf(req);
      const set: Partial<BlockDoc> = { ...merged, level1, blocksAssignment, updatedBy: by, updatedAt: new Date() };
      if (req.body.note !== undefined) set.note = req.body.note;
      const updated = await withTransaction(app.mongo, async (session) => {
        const u = await coll().findOneAndUpdate({ _id: existing._id, cancelledAt: null }, { $set: set }, { returnDocument: 'after', session });
        if (!u) throw unprocessable('BLOCK_CANCELLED', 'A cancelled block cannot be changed');
        await writeAudit(app.db, { entity: 'resourceBlock', entityId: req.params.id, action: 'update', by, before: toApi(existing), after: toApi(u) }, { session });
        return u;
      });
      return { ...toApi(updated), warnings };
    },
  );

  app.post('/resource-blocks/:id/cancel', { schema: { tags: ['availability'], params: IdParams, response: { 200: BlockItem } }, preHandler: write }, async (req) => {
    const existing = await load(req.params.id);
    if (existing.cancelledAt) throw unprocessable('BLOCK_CANCELLED', 'The block is already cancelled');
    const by = actorOf(req);
    const updated = await withTransaction(app.mongo, async (session) => {
      const u = await coll().findOneAndUpdate(
        { _id: existing._id, cancelledAt: null },
        { $set: { cancelledAt: new Date(), updatedBy: by, updatedAt: new Date() } },
        { returnDocument: 'after', session },
      );
      if (!u) throw unprocessable('BLOCK_CANCELLED', 'The block is already cancelled');
      await writeAudit(app.db, { entity: 'resourceBlock', entityId: req.params.id, action: 'cancel', by, before: toApi(existing), after: toApi(u) }, { session });
      return u;
    });
    return toApi(updated);
  });
};
