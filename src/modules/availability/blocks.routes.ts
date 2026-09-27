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

const iso = z.string().datetime({ offset: true }).describe('UTC ISO 8601 timestamp with offset, e.g. "2026-09-27T08:00:00Z".');

const BlockItem = z.object({
  id: z.string(),
  resourceType: z.enum(RESOURCE_TYPES),
  resourceId: z.string(),
  statusCode: z.string().describe('Status code (see /status-codes) that classifies this block; must be active and applicable to `resourceType`.'),
  level1: z.enum(LEVEL1).describe('Copied from the status code: "working" or "not_working".'),
  blocksAssignment: z.boolean().describe('Copied from the status code: whether this block prevents assigning the resource to a shipment during its period.'),
  from: z.string().describe('UTC ISO start of the block period.'),
  to: z.string().describe('UTC ISO end of the block period; must be after `from`.'),
  note: z.string().nullable(),
  source: z.enum(['manual', 'atms', 'hr']).describe('Who created this block: "manual" (a planner/admin via this API), "atms", or "hr" (synced from those external systems).'),
  cancelledAt: z.string().nullable().describe('UTC ISO time the block was cancelled, or null while still active. A cancelled block can no longer be changed.'),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
const BlockWithWarnings = BlockItem.extend({
  warnings: z.array(IssueSchema).describe('Non-fatal `SHIPMENT_CONFLICT` warnings: shipments that already use this resource during the block period and may now need reassignment.'),
});

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
        summary: 'Create a resource block',
        description:
          'Marks a vehicle or driver unavailable (or working under a special status) for a time period, using a status code (see /status-codes) to drive `level1`/`blocksAssignment`. ' +
          'Returns warnings (not errors) for any shipment already using this resource during the period. Fails with 422 `INVALID_RANGE` if `to` is not after `from`, `INVALID_REFERENCE` for an unknown/inactive resource, ' +
          '`INVALID_REFERENCE` for an unknown status code, or `STATUS_CODE_NOT_APPLICABLE` if the status code does not apply to this resource type. Requires role admin or planner.',
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
        summary: 'List resource blocks',
        description:
          'Paginated (cursor-based) list of vehicle/driver unavailability blocks, optionally filtered by resource and/or overlap with a `from`/`to` window. ' +
          'Excludes cancelled blocks unless `includeCancelled=true`. Requires role admin, planner, or viewer.',
        querystring: PageQuery.extend({
          resourceType: z.enum(RESOURCE_TYPES).optional(),
          resourceId: objectIdString.optional(),
          from: iso.optional().describe('Only return blocks whose period ends after this time.'),
          to: iso.optional().describe('Only return blocks whose period starts before this time.'),
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
        summary: 'Update a resource block',
        description:
          'Partially updates an active (not cancelled) resource block; only fields present in the body are changed, and validation/warnings are re-evaluated on the merged period and status code. ' +
          'Fails with 422 `BLOCK_CANCELLED` if the block was already cancelled, plus the same range/reference errors as create. Requires role admin or planner.',
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

  app.post(
    '/resource-blocks/:id/cancel',
    {
      schema: {
        tags: ['availability'],
        summary: 'Cancel a resource block',
        description: 'Marks a resource block as cancelled (setting `cancelledAt`) so the resource is no longer considered blocked for that period. Fails with 422 `BLOCK_CANCELLED` if already cancelled. Requires role admin or planner.',
        params: IdParams,
        response: { 200: BlockItem },
      },
      preHandler: write,
    },
    async (req) => {
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
