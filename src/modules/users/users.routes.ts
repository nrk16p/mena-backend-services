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
import { withTransaction } from '../../lib/tx.js';
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
  password: z.string().min(8).max(128).describe('Initial password (min 8 characters); stored only as a hash.'),
  roles: z.array(z.enum(ROLES)).min(1).describe('At least one of admin/planner/driver/viewer. Including "driver" requires `driverId`.'),
  driverId: objectIdString.nullable().default(null).describe('Driver this account is linked to. Required and only allowed when `roles` includes "driver" and the account is active; the driver must not already be linked to another user (409 `DRIVER_ALREADY_LINKED`).'),
});

const PatchUserBody = z.object({
  password: z.string().min(8).max(128).optional().describe('New password; changing it revokes all of this user\'s existing sessions.'),
  roles: z.array(z.enum(ROLES)).min(1).optional(),
  driverId: objectIdString.nullable().optional(),
  active: z.boolean().optional().describe('Deactivating a user revokes all of their sessions and releases any linked `driverId`.'),
});

/** Lock document every user PATCH writes first, so concurrent ones serialise (LAST_ADMIN). */
const ADMIN_LOCK = 'lock:admins';

const safeUser = (u: UserDoc) => {
  const { passwordHash: _hidden, tokensValidAfter: _internal, ...rest } = u;
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
    {
      schema: {
        tags: ['users'],
        summary: 'List users',
        description: 'Paginated (cursor-based) list of user accounts, optionally filtered by `q` (case-insensitive match on `username`). Requires the admin role.',
        querystring: PageQuery.extend({ q: z.string().optional().describe('Case-insensitive substring match on `username`.') }),
        response: { 200: pageResponse(UserItem) },
      },
      preHandler: admin,
    },
    async (req) => {
      const filter: Filter<UserDoc> = req.query.q ? { username: { $regex: escapeRegex(req.query.q), $options: 'i' } } : {};
      const page = await paginate(users(), filter, req.query);
      return { items: page.items.map(safeUser), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/users/:id',
    { schema: { tags: ['users'], summary: 'Get a user', description: 'Fetches one user account by id. Returns 404 `NOT_FOUND` if it does not exist. Requires the admin role.', params: IdParams, response: { 200: UserItem } },
    preHandler: admin,
  }, async (req) => {
    const u = await users().findOne({ _id: new ObjectId(req.params.id) });
    if (!u) throw notFound('User');
    return safeUser(u);
  });

  app.post(
    '/users',
    {
      schema: {
        tags: ['users'],
        summary: 'Create a user',
        description:
          'Creates a new active user account. If `roles` includes "driver", `driverId` is required and must point to a driver not already linked to another account (409 `DRIVER_ALREADY_LINKED`); ' +
          'a `driverId` without the "driver" role, or on an account that would be inactive, is rejected (422 `DRIVER_LINK_NOT_ALLOWED` / `DRIVER_LINK_REQUIRED`). Requires the admin role.',
        body: CreateUserBody,
        response: { 201: UserItem },
      },
      preHandler: admin,
    },
    async (req, reply) => {
    const driverId = req.body.driverId ? new ObjectId(req.body.driverId) : null;
    await assertDriverLink(app.db, req.body.roles, driverId, true, null);
    const by = actorOf(req);
    // Hash before the transaction: a retried transaction must not pay for (or differ in) the hash.
    const passwordHash = await hashPassword(req.body.password);
    const u = await withTransaction(app.mongo, async (session) => {
      const created = await createUser(app.db, { username: req.body.username, roles: req.body.roles, driverId, passwordHash }, { session });
      await writeAudit(app.db, { entity: 'user', entityId: created._id.toHexString(), action: 'create', by, after: safeUser(created) }, { session });
      return created;
    });
    return reply.status(201).send(safeUser(u));
  });

  app.patch(
    '/users/:id',
    {
      schema: {
        tags: ['users'],
        summary: 'Update a user',
        description:
          'Partially updates a user account; only fields present in the body are changed. Changing `password` or setting `active: false` revokes all of the user\'s sessions. ' +
          'Fails with 422 `LAST_ADMIN` if the change would leave zero active admins, or with the same driver-link rules as create (see `POST /users`). Returns 404 `NOT_FOUND` if the user does not exist. Requires the admin role.',
        params: IdParams,
        body: PatchUserBody,
        response: { 200: UserItem },
      },
      preHandler: admin,
    },
    async (req) => {
    const _id = new ObjectId(req.params.id);
    const existing = await users().findOne({ _id });
    if (!existing) throw notFound('User');
    const roles = req.body.roles ?? existing.roles;
    const willBeActive = req.body.active ?? existing.active;
    const requested = req.body.driverId === undefined ? undefined : req.body.driverId ? new ObjectId(req.body.driverId) : null;
    // Keep the link only on an active driver account; otherwise release it so the driver can be linked again.
    const driverId = requested !== undefined ? requested : roles.includes('driver') && willBeActive ? existing.driverId : null;
    await assertDriverLink(app.db, roles, driverId, willBeActive, _id);
    // Write only what the request changes: `existing` was read outside the transaction, so writing its
    // roles/active back could silently undo a concurrent change (e.g. a promotion to admin).
    const set: Partial<UserDoc> = { updatedAt: new Date() };
    if (req.body.roles !== undefined) set.roles = req.body.roles;
    if (req.body.active !== undefined) set.active = req.body.active;
    if (requested !== undefined) set.driverId = requested;
    else if (req.body.active === false || (req.body.roles !== undefined && !req.body.roles.includes('driver'))) set.driverId = null;
    if (req.body.password) set.passwordHash = await hashPassword(req.body.password);
    const by = actorOf(req);
    const locks = app.db.collection<{ _id: string; seq: number }>(C.counters);
    // Create the lock document outside the transaction: an upsert inside two concurrent transactions
    // would race on the insert instead of conflicting on one existing document.
    await locks.updateOne({ _id: ADMIN_LOCK }, { $setOnInsert: { seq: 0 } }, { upsert: true });
    const updated = await withTransaction(app.mongo, async (session) => {
      // Every PATCH writes the same lock document first, so concurrent ones conflict and MongoDB retries
      // the loser, which then counts the winner's change. This does not trust `existing`: any PATCH may
      // be the one that removes the last active admin.
      await locks.updateOne({ _id: ADMIN_LOCK }, { $inc: { seq: 1 } }, { session });
      const u = await users().findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after', session });
      if (!u) throw notFound('User');
      if ((await users().countDocuments({ active: true, roles: 'admin' }, { session, limit: 1 })) === 0) {
        throw unprocessable('LAST_ADMIN', 'Cannot deactivate or demote the last active admin');
      }
      if (req.body.password || req.body.active === false) await revokeAllForUser(app.db, _id, session);
      await writeAudit(app.db, { entity: 'user', entityId: req.params.id, action: 'update', by, before: safeUser(existing), after: safeUser(u) }, { session });
      return u;
    });
    return safeUser(updated);
  });
};
