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
  scopes: z.array(z.enum(API_KEY_SCOPES)).describe('Permissions granted to this key, e.g. `gps:write` to post GPS positions via the API-key-authenticated endpoints.'),
  active: z.boolean().describe('Whether the key can still authenticate; revoking a key sets this to false permanently.'),
  lastUsedAt: z.string().nullable().describe('UTC ISO timestamp of the key\'s last successful use, or null if never used.'),
  createdAt: z.string(),
  createdBy: z.string(),
});

const publicKey = (d: ApiKeyDoc) => {
  const { keyHash: _hidden, ...rest } = d;
  return toApi(rest);
};

export const apiKeyRoutes: FastifyPluginAsyncZod = async (app) => {
  const admin = app.requireRoles('admin');

  app.get(
    '/api-keys',
    {
      schema: {
        tags: ['api-keys'],
        summary: 'List API keys',
        description: 'Paginated (cursor-based) list of API keys, including revoked ones. The key secret itself is never returned — only metadata. Requires the admin role.',
        querystring: PageQuery,
        response: { 200: pageResponse(ApiKeyItem) },
      },
      preHandler: admin,
    },
    async (req) => {
      const page = await paginate(app.db.collection<ApiKeyDoc>(C.apiKeys), {}, req.query);
      return { items: page.items.map(publicKey), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/api-keys',
    {
      schema: {
        tags: ['api-keys'],
        summary: 'Create an API key',
        description:
          'Creates a new API key for machine-to-machine access (e.g. GPS vendor integrations) and returns its secret exactly once — it is not stored and cannot be retrieved again. ' +
          'Callers authenticate with it via the `x-api-key` header, scoped by `scopes`. Requires the admin role.',
        body: z.object({
          name: z.string().trim().min(1).max(100).describe('Human-readable label for this key, e.g. the integration or vendor it is for.'),
          scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).describe('Permission scopes to grant, e.g. `gps:write`.'),
        }),
        response: { 201: ApiKeyItem.extend({ key: z.string().describe('The API key secret; shown only in this response, pass it as the `x-api-key` header thereafter.') }) },
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

  app.delete(
    '/api-keys/:id',
    {
      schema: {
        tags: ['api-keys'],
        summary: 'Revoke an API key',
        description: 'Permanently deactivates an API key (sets `active` to false); it can no longer authenticate. Returns 404 `NOT_FOUND` if it does not exist. Requires the admin role.',
        params: IdParams,
        response: { 200: ApiKeyItem },
      },
      preHandler: admin,
    },
    async (req) => {
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
