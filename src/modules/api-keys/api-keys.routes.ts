import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf, writeAudit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { IdParams } from '../../lib/ids.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import { toApi } from '../../lib/serialize.js';
import { withTransaction } from '../../lib/tx.js';
import { API_KEY_SCOPES, type ApiKeyDoc, createApiKey } from './api-keys.service.js';

const ApiKeyItem = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(z.enum(API_KEY_SCOPES)),
  active: z.boolean(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string(),
});

const publicKey = (d: ApiKeyDoc) => {
  const { keyHash: _hidden, ...rest } = d;
  return toApi(rest);
};

export const apiKeyRoutes: FastifyPluginAsyncZod = async (app) => {
  const admin = app.requireRoles('admin');

  app.get('/api-keys', { schema: { tags: ['api-keys'], querystring: PageQuery, response: { 200: pageResponse(ApiKeyItem) } }, preHandler: admin }, async (req) => {
    const page = await paginate(app.db.collection<ApiKeyDoc>(C.apiKeys), {}, req.query);
    return { items: page.items.map(publicKey), nextCursor: page.nextCursor };
  });

  app.post(
    '/api-keys',
    {
      schema: {
        tags: ['api-keys'],
        body: z.object({ name: z.string().trim().min(1).max(100), scopes: z.array(z.enum(API_KEY_SCOPES)).min(1) }),
        response: { 201: ApiKeyItem.extend({ key: z.string() }) },
      },
      preHandler: admin,
    },
    async (req, reply) => {
      const by = actorOf(req);
      const { doc, key } = await withTransaction(app.mongo, async (session) => {
        const created = await createApiKey(app.db, app.config.API_KEY_PEPPER, { ...req.body, createdBy: by }, { session });
        await writeAudit(app.db, { entity: 'apiKey', entityId: created.doc._id.toHexString(), action: 'create', by, after: publicKey(created.doc) }, { session });
        return created;
      });
      return reply.status(201).send({ ...publicKey(doc), key });
    },
  );

  app.delete('/api-keys/:id', { schema: { tags: ['api-keys'], params: IdParams, response: { 200: ApiKeyItem } }, preHandler: admin }, async (req) => {
    const updated = await withTransaction(app.mongo, async (session) => {
      const u = await app.db
        .collection<ApiKeyDoc>(C.apiKeys)
        .findOneAndUpdate({ _id: new ObjectId(req.params.id) }, { $set: { active: false } }, { returnDocument: 'after', session });
      if (!u) throw notFound('API key');
      await writeAudit(app.db, { entity: 'apiKey', entityId: req.params.id, action: 'revoke', by: actorOf(req) }, { session });
      return u;
    });
    return publicKey(updated);
  });
};
