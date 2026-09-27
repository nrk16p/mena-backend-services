import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf, writeAudit } from '../../lib/audit.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { IdParams, objectIdString } from '../../lib/ids.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import { CreatePodTemplateBody, PatchPodTemplateBody, PodTemplateItem } from './pod-templates.schemas.js';
import type { PodTemplateDoc } from './pod-templates.service.js';

const published = () => unprocessable('TEMPLATE_PUBLISHED', 'Published templates cannot be changed; clone it to make a new draft');

export const podTemplateRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = app.requireRoles(...STAFF_ROLES);
  const write = app.requireRoles('admin', 'planner');
  const coll = () => app.db.collection<PodTemplateDoc>(C.podTemplates);

  const load = async (id: string) => {
    const doc = await coll().findOne({ _id: new ObjectId(id) });
    if (!doc) throw notFound('POD template');
    return doc;
  };

  app.get(
    '/pod-templates',
    {
      schema: {
        tags: ['pod-templates'],
        querystring: PageQuery.extend({ clientId: objectIdString.optional(), jobGroupId: objectIdString.optional(), status: z.enum(['draft', 'published']).optional() }),
        response: { 200: pageResponse(PodTemplateItem) },
      },
      preHandler: read,
    },
    async (req) => {
      const f: Filter<PodTemplateDoc> = {};
      if (req.query.clientId) f.clientId = new ObjectId(req.query.clientId);
      if (req.query.jobGroupId) f.jobGroupId = new ObjectId(req.query.jobGroupId);
      if (req.query.status) f.status = req.query.status;
      const page = await paginate(coll(), f, req.query);
      return { items: page.items.map(toApi), nextCursor: page.nextCursor };
    },
  );

  app.get('/pod-templates/:id', { schema: { tags: ['pod-templates'], params: IdParams, response: { 200: PodTemplateItem } }, preHandler: read }, async (req) =>
    toApi(await load(req.params.id)),
  );

  app.post('/pod-templates', { schema: { tags: ['pod-templates'], body: CreatePodTemplateBody, response: { 201: PodTemplateItem } }, preHandler: write }, async (req, reply) => {
    const clientId = new ObjectId(req.body.clientId);
    if (!(await app.db.collection(C.clients).countDocuments({ _id: clientId }, { limit: 1 }))) {
      throw unprocessable('INVALID_REFERENCE', 'clientId does not exist', { field: 'clientId' });
    }
    const jobGroupId = req.body.jobGroupId ? new ObjectId(req.body.jobGroupId) : null;
    if (jobGroupId) {
      const jg = await app.db.collection(C.jobGroups).findOne({ _id: jobGroupId });
      if (!jg) throw unprocessable('INVALID_REFERENCE', 'jobGroupId does not exist', { field: 'jobGroupId' });
      if (!(jg.clientId as ObjectId).equals(clientId)) throw unprocessable('JOB_GROUP_CLIENT_MISMATCH', 'Job group belongs to a different client');
    }
    const now = new Date();
    const by = actorOf(req);
    const doc: Omit<PodTemplateDoc, '_id'> = {
      clientId, jobGroupId, name: req.body.name, status: 'draft', version: null,
      extraSteps: req.body.extraSteps, fields: req.body.fields,
      publishedAt: null, publishedBy: null, createdAt: now, updatedAt: now, createdBy: by,
    };
    const res = await coll().insertOne(doc as PodTemplateDoc);
    const saved = { ...doc, _id: res.insertedId };
    await writeAudit(app.db, { entity: 'podTemplate', entityId: res.insertedId.toHexString(), action: 'create', by, after: toApi(saved) });
    return reply.status(201).send(toApi(saved));
  });

  app.patch('/pod-templates/:id', { schema: { tags: ['pod-templates'], params: IdParams, body: PatchPodTemplateBody, response: { 200: PodTemplateItem } }, preHandler: write }, async (req) => {
    const existing = await load(req.params.id);
    if (existing.status === 'published') throw published();
    const updated = await coll().findOneAndUpdate(
      { _id: existing._id, status: 'draft' },
      { $set: { ...req.body, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!updated) throw published();
    await writeAudit(app.db, { entity: 'podTemplate', entityId: req.params.id, action: 'update', by: actorOf(req), before: toApi(existing), after: toApi(updated) });
    return toApi(updated);
  });

  app.post('/pod-templates/:id/publish', { schema: { tags: ['pod-templates'], params: IdParams, response: { 200: PodTemplateItem } }, preHandler: write }, async (req) => {
    const draft = await load(req.params.id);
    if (draft.status === 'published') throw published();
    const last = await coll()
      .find({ clientId: draft.clientId, jobGroupId: draft.jobGroupId, status: 'published' })
      .sort({ version: -1 })
      .limit(1)
      .next();
    const by = actorOf(req);
    const updated = await coll().findOneAndUpdate(
      { _id: draft._id, status: 'draft' },
      { $set: { status: 'published', version: (last?.version ?? 0) + 1, publishedAt: new Date(), publishedBy: by, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!updated) throw published();
    await writeAudit(app.db, { entity: 'podTemplate', entityId: req.params.id, action: 'publish', by, after: toApi(updated) });
    return toApi(updated);
  });

  app.post('/pod-templates/:id/clone', { schema: { tags: ['pod-templates'], params: IdParams, response: { 201: PodTemplateItem } }, preHandler: write }, async (req, reply) => {
    const src = await load(req.params.id);
    const now = new Date();
    const by = actorOf(req);
    const { _id: _src, ...rest } = src;
    const doc: Omit<PodTemplateDoc, '_id'> = {
      ...rest, status: 'draft', version: null, publishedAt: null, publishedBy: null, createdAt: now, updatedAt: now, createdBy: by,
    };
    const res = await coll().insertOne(doc as PodTemplateDoc);
    const saved = { ...doc, _id: res.insertedId };
    await writeAudit(app.db, { entity: 'podTemplate', entityId: res.insertedId.toHexString(), action: 'clone', by, after: { from: req.params.id } });
    return reply.status(201).send(toApi(saved));
  });
};
