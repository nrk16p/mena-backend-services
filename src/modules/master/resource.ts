import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Db, type Document } from 'mongodb';
import { z } from 'zod';
import { actorOf, writeAudit } from '../../lib/audit.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { objectIdString } from '../../lib/ids.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import { escapeRegex } from '../../lib/regex.js';
import { STAFF_ROLES, type Role } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';

export interface RefSpec {
  path: string;
  collection: string;
  many?: boolean;
}

export interface ParentSpec {
  param: string;
  field: string;
  collection: string;
}

type Obj = Record<string, unknown>;

export interface ResourceDef {
  name: string;
  path: string;
  collection: string;
  body: z.ZodObject<z.ZodRawShape>;
  item: z.ZodObject<z.ZodRawShape>;
  refs?: RefSpec[];
  parent?: ParentSpec;
  searchFields?: string[];
  filterFields?: { name: string; ref?: boolean; boolean?: boolean }[];
  toDb?: (body: Obj) => Obj;
  fromDb?: (apiDoc: Obj) => Obj;
  validate?: (merged: Obj, ctx: { db: Db; existing: Document | null }) => Promise<void>;
  writeRoles?: Role[];
}

function getPath(obj: Obj, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Obj)[k] : undefined), obj);
}

function setPath(obj: Obj, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: Obj = obj;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') return;
    cur = cur[k] as Obj;
  }
  cur[keys[keys.length - 1]!] = value;
}

async function convertRef(db: Db, doc: Obj, ref: RefSpec): Promise<void> {
  const raw = getPath(doc, ref.path);
  if (raw === undefined || raw === null) return;
  const hexes = ref.many ? (raw as string[]) : [raw as string];
  const ids = [...new Set(hexes)].map((h) => new ObjectId(h));
  if (ids.length > 0) {
    const found = await db.collection(ref.collection).find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray();
    const foundSet = new Set(found.map((d) => d._id.toHexString()));
    const missing = ids.map((i) => i.toHexString()).filter((h) => !foundSet.has(h));
    if (missing.length > 0) {
      throw unprocessable('INVALID_REFERENCE', `${ref.path} references unknown ${ref.collection}`, { field: ref.path, missing });
    }
  }
  setPath(doc, ref.path, ref.many ? hexes.map((h) => new ObjectId(h)) : new ObjectId(hexes[0]!));
}

export async function prepareDoc(
  def: ResourceDef,
  db: Db,
  body: Obj,
  existing: Document | null,
  parentFields: Obj = {},
): Promise<Obj> {
  const doc = def.toDb ? def.toDb({ ...body }) : { ...body };
  for (const ref of def.refs ?? []) await convertRef(db, doc, ref);
  if (def.validate) {
    const merged = { ...(existing ?? {}), ...parentFields, ...doc };
    await def.validate(merged, { db, existing });
  }
  return doc;
}

export function resourceRoutes(def: ResourceDef): FastifyPluginAsyncZod {
  const writeRoles = def.writeRoles ?? (['admin', 'planner'] as Role[]);
  const itemSchema = def.item.extend({ id: z.string(), active: z.boolean(), createdAt: z.string(), updatedAt: z.string() });
  const parentParams = def.parent ? z.object({ [def.parent.param]: objectIdString }) : z.object({});
  const idParams = parentParams.extend({ id: objectIdString });
  const filterShape = Object.fromEntries(
    (def.filterFields ?? []).map((f) => [f.name, f.ref ? objectIdString.optional() : f.boolean ? z.enum(['true', 'false']).optional() : z.string().optional()]),
  );
  const listQuery = PageQuery.extend({ q: z.string().optional(), active: z.enum(['true', 'false', 'all']).default('true'), ...filterShape });
  const patchBody = def.body.partial().extend({ active: z.boolean().optional() });
  const out = (doc: Document) => {
    const api = toApi(doc) as Obj;
    return def.fromDb ? def.fromDb(api) : api;
  };

  return async (app) => {
    const coll = () => app.db.collection(def.collection);
    const readGuard = app.requireRoles(...STAFF_ROLES);
    const writeGuard = app.requireRoles(...writeRoles);

    const parentFilter = async (params: Obj): Promise<Obj> => {
      if (!def.parent) return {};
      const pid = new ObjectId(params[def.parent.param] as string);
      const exists = await app.db.collection(def.parent.collection).countDocuments({ _id: pid }, { limit: 1 });
      if (!exists) throw notFound(def.parent.collection);
      return { [def.parent.field]: pid };
    };

    app.get(def.path, { schema: { tags: [def.name], params: parentParams, querystring: listQuery, response: { 200: pageResponse(itemSchema) } }, preHandler: readGuard }, async (req) => {
      const q = req.query as Obj & { limit: number; cursor?: string; q?: string; active: string };
      const filter: Document = { ...(await parentFilter(req.params as Obj)) };
      if (q.active !== 'all') filter.active = q.active === 'true';
      if (q.q && def.searchFields?.length) {
        const rx = { $regex: escapeRegex(q.q), $options: 'i' };
        filter.$or = def.searchFields.map((f) => ({ [f]: rx }));
      }
      for (const f of def.filterFields ?? []) {
        const v = q[f.name];
        if (v === undefined) continue;
        filter[f.name] = f.ref ? new ObjectId(v as string) : f.boolean ? v === 'true' : v;
      }
      const page = await paginate(coll(), filter, { limit: q.limit, cursor: q.cursor });
      return { items: page.items.map(out), nextCursor: page.nextCursor };
    });

    app.get(`${def.path}/:id`, { schema: { tags: [def.name], params: idParams, response: { 200: itemSchema } }, preHandler: readGuard }, async (req) => {
      const params = req.params as Obj & { id: string };
      const doc = await coll().findOne({ _id: new ObjectId(params.id), ...(await parentFilter(params)) });
      if (!doc) throw notFound(def.name);
      return out(doc);
    });

    app.post(def.path, { schema: { tags: [def.name], params: parentParams, body: def.body, response: { 201: itemSchema } }, preHandler: writeGuard }, async (req, reply) => {
      const pf = await parentFilter(req.params as Obj);
      const prepared = await prepareDoc(def, app.db, req.body as Obj, null, pf);
      const now = new Date();
      const doc: Obj = { ...prepared, ...pf, active: true, createdAt: now, updatedAt: now };
      const res = await coll().insertOne(doc);
      const saved = { ...doc, _id: res.insertedId };
      await writeAudit(app.db, { entity: def.name, entityId: res.insertedId.toHexString(), action: 'create', by: actorOf(req), after: toApi(saved) });
      return reply.status(201).send(out(saved));
    });

    app.patch(`${def.path}/:id`, { schema: { tags: [def.name], params: idParams, body: patchBody, response: { 200: itemSchema } }, preHandler: writeGuard }, async (req) => {
      const params = req.params as Obj & { id: string };
      const pf = await parentFilter(params);
      const _id = new ObjectId(params.id);
      const existing = await coll().findOne({ _id, ...pf });
      if (!existing) throw notFound(def.name);
      const { active, ...fields } = req.body as Obj & { active?: boolean };
      const prepared = await prepareDoc(def, app.db, fields, existing, pf);
      const set: Obj = { ...prepared, updatedAt: new Date() };
      if (active !== undefined) set.active = active;
      const updated = await coll().findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after' });
      if (!updated) throw notFound(def.name);
      await writeAudit(app.db, { entity: def.name, entityId: params.id, action: 'update', by: actorOf(req), before: toApi(existing), after: toApi(updated) });
      return out(updated);
    });

    app.delete(`${def.path}/:id`, { schema: { tags: [def.name], params: idParams, response: { 200: itemSchema } }, preHandler: writeGuard }, async (req) => {
      const params = req.params as Obj & { id: string };
      const pf = await parentFilter(params);
      const updated = await coll().findOneAndUpdate(
        { _id: new ObjectId(params.id), ...pf },
        { $set: { active: false, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      if (!updated) throw notFound(def.name);
      await writeAudit(app.db, { entity: def.name, entityId: params.id, action: 'deactivate', by: actorOf(req) });
      return out(updated);
    });
  };
}
