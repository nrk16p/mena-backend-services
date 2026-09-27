import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf, writeAudit } from '../../lib/audit.js';
import { AppError, unauthorized } from '../../lib/errors.js';
import { dummyHash, hashPassword, verifyPassword } from '../../lib/passwords.js';
import { withTransaction } from '../../lib/tx.js';
import { UserOutSchema, findUserById, findUserByUsername, userOut } from '../users/users.repo.js';
import { TokenResponseSchema, issueTokens } from './auth.service.js';
import { assertFamilyCurrent, revokeAllForUser, revokeRefreshToken, rotateRefreshToken } from './refresh-tokens.js';

const LoginBody = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1).max(128),
  lat: z.number().min(-90).max(90).optional().describe('Optional device latitude recorded on `lastLogin`, e.g. from a driver\'s phone.'),
  lng: z.number().min(-180).max(180).optional().describe('Optional device longitude recorded on `lastLogin`.'),
});

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/auth/login',
    {
      schema: {
        tags: ['auth'],
        summary: 'Log in and get tokens',
        description:
          'Verifies username/password and returns an access token (JWT, short-lived) plus a refresh token. No role is required to call this — it is the entry point for every principal kind. ' +
          'Fails with 401 `INVALID_CREDENTIALS` for a wrong username/password or an inactive user. Rate-limited per IP+username to slow down credential stuffing.',
        body: LoginBody,
        response: { 200: TokenResponseSchema },
      },
      config: {
        rateLimit: {
          max: app.config.LOGIN_RATE_LIMIT_PER_MIN,
          timeWindow: '1 minute',
          // Run after body parsing/validation so the (already-validated) username is
          // available here, and key per IP+username instead of per IP alone — otherwise
          // every login behind a shared proxy IP (e.g. Render) draws from one bucket,
          // and one user's failed attempts lock out everyone else on that IP.
          hook: 'preHandler',
          keyGenerator: (req) => {
            const body = req.body as { username?: unknown } | undefined;
            const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : undefined;
            return username ? `${req.ip}|${username}` : req.ip;
          },
        },
      },
    },
    async (req) => {
      const user = await findUserByUsername(app.db, req.body.username);
      const ok = user ? await verifyPassword(user.passwordHash, req.body.password) : await verifyPassword(await dummyHash(), req.body.password).then(() => false);
      if (!user || !ok || !user.active) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
      }
      await app.db.collection(C.users).updateOne(
        { _id: user._id },
        { $set: { lastLogin: { at: new Date(), lat: req.body.lat ?? null, lng: req.body.lng ?? null } } },
      );
      return issueTokens(app, user);
    },
  );

  app.get(
    '/me',
    {
      schema: {
        tags: ['auth'],
        summary: 'Get the current user',
        description: 'Returns the profile of the user identified by the bearer access token. Requires any authenticated user (no specific role); fails with 401 if the token is missing, invalid/expired, or the user is inactive.',
        response: { 200: UserOutSchema },
      },
      preHandler: app.requireRoles(),
    },
    async (req) => {
      if (req.principal?.kind !== 'user') throw unauthorized();
      const user = await findUserById(app.db, new ObjectId(req.principal.userId));
      if (!user) throw unauthorized();
      return userOut(user);
    },
  );

  const RefreshBody = z.object({ refreshToken: z.string().min(1).describe('Refresh token previously issued by login or a prior refresh, as `<id>.<secret>`.') });

  app.post(
    '/auth/refresh',
    {
      schema: {
        tags: ['auth'],
        summary: 'Rotate a refresh token for a new access token',
        description:
          'Exchanges a still-valid refresh token for a new access/refresh token pair (rotation: the old refresh token is consumed). No role required, since the caller is not yet holding an access token. ' +
          'Fails with 401 `INVALID_REFRESH_TOKEN` if unknown/expired, `USER_INACTIVE` if the user was deactivated, or `REFRESH_TOKEN_REUSED` if a token already consumed (outside its short reuse-grace window) is replayed — that also revokes the whole token family, forcing a fresh login.',
        body: RefreshBody,
        response: { 200: TokenResponseSchema },
      },
    },
    async (req) => {
      const { userId, familyId } = await rotateRefreshToken(app.db, req.body.refreshToken, app.config.REFRESH_REUSE_GRACE_SEC);
      const user = await findUserById(app.db, userId);
      if (!user || !user.active) throw new AppError(401, 'USER_INACTIVE', 'User is inactive');
      await assertFamilyCurrent(app.db, userId, familyId, user.tokensValidAfter);
      return issueTokens(app, user, familyId);
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Log out (revoke a refresh token)',
        description: 'Revokes the given refresh token and its whole rotation family, so it (and any token rotated from it) can no longer be used. Always returns 204, even if the token was already invalid. No role required.',
        body: RefreshBody,
      },
    },
    async (req, reply) => {
    await revokeRefreshToken(app.db, req.body.refreshToken);
    return reply.status(204).send();
  });

  app.post(
    '/me/password',
    {
      schema: {
        tags: ['auth'],
        summary: 'Change the current user\'s password',
        description:
          'Changes the caller\'s own password after verifying `currentPassword`, and revokes every refresh token/session for this user (the caller must log in again on other devices). ' +
          'Requires any authenticated user. Fails with 422 `INVALID_CURRENT_PASSWORD` if `currentPassword` is wrong.',
        body: z.object({
          currentPassword: z.string().min(1).describe('The user\'s existing password, for verification.'),
          newPassword: z.string().min(8).max(128).describe('The new password to set (min 8 characters).'),
        }),
      },
      preHandler: app.requireRoles(),
    },
    async (req, reply) => {
      if (req.principal?.kind !== 'user') throw unauthorized();
      const user = await findUserById(app.db, new ObjectId(req.principal.userId));
      if (!user) throw unauthorized();
      if (!(await verifyPassword(user.passwordHash, req.body.currentPassword))) {
        throw new AppError(422, 'INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
      }
      const passwordHash = await hashPassword(req.body.newPassword);
      await withTransaction(app.mongo, async (session) => {
        await app.db.collection(C.users).updateOne({ _id: user._id }, { $set: { passwordHash, updatedAt: new Date() } }, { session });
        await revokeAllForUser(app.db, user._id, session);
        await writeAudit(app.db, { entity: 'user', entityId: user._id.toHexString(), action: 'password-change', by: actorOf(req) }, { session });
      });
      return reply.status(204).send();
    },
  );
};
