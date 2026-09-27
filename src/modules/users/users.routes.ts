import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Db, type Filter } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf, writeAudit } from '../../lib/audit.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { IdParams, objectIdString } from '../../lib/ids.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import { hashPassword } from '../../lib/passwords.js';
import { escapeRegex } from '../../lib/regex.js';
import { ROLES, type Role } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import { revokeAllForUser } from '../auth/refresh-tokens.js';
import { type UserDoc, createUser } from './users.repo.js';

const UserItem = z.object({
  id: z.string(),
  username: z.string(),
  roles: z.array(z.enum(ROLES)),
  driverId: z.string().nullable(),
  active: z.boolean(),
  lastLogin: z.object({ at: z.string(), lat: z.number().nullable(), lng: z.number().nullable() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CreateUserBody = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(8).max(128),
  roles: z.array(z.enum(ROLES)).min(1),
  driverId: objectIdString.nullable().default(null),
});

const PatchUserBody = z.object({
  password: z.string().min(8).max(128).optional(),
  roles: z.array(z.enum(ROLES)).min(1).optional(),
  driverId: objectIdString.nullable().optional(),
  active: z.boolean().optional(),
});

const safeUser = (u: UserDoc) => {
  const { passwordHash: _hidden, ...rest } = u;
  return toApi(rest);
};

/**
 * Only an active user with the driver role holds a driverId (roadmap carry-forward: a stale link on
 * a demoted or deactivated account would otherwise block linking the driver to a new account).
 */
async function assertDriverLink(db: Db, roles: Role[], driverId: ObjectId | null, active: boolean, userId: ObjectId | null): Promise<void> {
  const isDriver = roles.includes('driver');
  if (isDriver && active && !driverId) {
    throw unprocessable('DRIVER_LINK_REQUIRED', 'Users with the driver role must be linked to a driver');
  }
  if (!driverId) return;
  if (!isDriver || !active) {
    throw unprocessable('DRIVER_LINK_NOT_ALLOWED', 'Only an active user with the driver role can be linked to a driver');
  }
  if (!(await db.collection(C.drivers).countDocuments({ _id: driverId }, { limit: 1 }))) {
    throw unprocessable('INVALID_REFERENCE', 'driverId does not exist', { field: 'driverId' });
  }
  const holder = await db
    .collection<UserDoc>(C.users)
    .findOne({ driverId, ...(userId ? { _id: { $ne: userId } } : {}) }, { projection: { username: 1 } });
  if (holder) throw conflict('DRIVER_ALREADY_LINKED', `This driver is already linked to user ${holder.username}`, { username: holder.username });
}

export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  const admin = app.requireRoles('admin');
  const users = () => app.db.collection<UserDoc>(C.users);

  app.get(
    '/users',
    { schema: { tags: ['users'], querystring: PageQuery.extend({ q: z.string().optional() }), response: { 200: pageResponse(UserItem) } }, preHandler: admin },
    async (req) => {
      const filter: Filter<UserDoc> = req.query.q ? { username: { $regex: escapeRegex(req.query.q), $options: 'i' } } : {};
      const page = await paginate(users(), filter, req.query);
      return { items: page.items.map(safeUser), nextCursor: page.nextCursor };
    },
  );

  app.get('/users/:id', { schema: { tags: ['users'], params: IdParams, response: { 200: UserItem } }, preHandler: admin }, async (req) => {
    const u = await users().findOne({ _id: new ObjectId(req.params.id) });
    if (!u) throw notFound('User');
    return safeUser(u);
  });

  app.post('/users', { schema: { tags: ['users'], body: CreateUserBody, response: { 201: UserItem } }, preHandler: admin }, async (req, reply) => {
    const driverId = req.body.driverId ? new ObjectId(req.body.driverId) : null;
    await assertDriverLink(app.db, req.body.roles, driverId, true, null);
    const u = await createUser(app.db, { ...req.body, driverId });
    await writeAudit(app.db, { entity: 'user', entityId: u._id.toHexString(), action: 'create', by: actorOf(req), after: safeUser(u) });
    return reply.status(201).send(safeUser(u));
  });

  app.patch('/users/:id', { schema: { tags: ['users'], params: IdParams, body: PatchUserBody, response: { 200: UserItem } }, preHandler: admin }, async (req) => {
    const _id = new ObjectId(req.params.id);
    const existing = await users().findOne({ _id });
    if (!existing) throw notFound('User');
    const roles = req.body.roles ?? existing.roles;
    const willBeActive = req.body.active ?? existing.active;
    const requested = req.body.driverId === undefined ? undefined : req.body.driverId ? new ObjectId(req.body.driverId) : null;
    // Keep the link only on an active driver account; otherwise release it so the driver can be linked again.
    const driverId = requested !== undefined ? requested : roles.includes('driver') && willBeActive ? existing.driverId : null;
    await assertDriverLink(app.db, roles, driverId, willBeActive, _id);
    const willBeAdmin = roles.includes('admin');
    const wasActiveAdmin = existing.active && existing.roles.includes('admin');
    if (wasActiveAdmin && !(willBeActive && willBeAdmin)) {
      const otherActiveAdmins = await users().countDocuments({ _id: { $ne: _id }, active: true, roles: 'admin' }, { limit: 1 });
      if (otherActiveAdmins === 0) {
        throw unprocessable('LAST_ADMIN', 'Cannot deactivate or demote the last active admin');
      }
    }
    const set: Partial<UserDoc> = { roles, driverId, updatedAt: new Date() };
    if (req.body.active !== undefined) set.active = req.body.active;
    if (req.body.password) set.passwordHash = await hashPassword(req.body.password);
    const updated = await users().findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after' });
    if (!updated) throw notFound('User');
    if (req.body.password || req.body.active === false) await revokeAllForUser(app.db, _id);
    await writeAudit(app.db, { entity: 'user', entityId: req.params.id, action: 'update', by: actorOf(req), before: safeUser(existing), after: safeUser(updated) });
    return safeUser(updated);
  });
};
