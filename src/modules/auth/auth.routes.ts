import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf, writeAudit } from '../../lib/audit.js';
import { AppError, unauthorized } from '../../lib/errors.js';
import { dummyHash, hashPassword, verifyPassword } from '../../lib/passwords.js';
import { UserOutSchema, findUserById, findUserByUsername, userOut } from '../users/users.repo.js';
import { TokenResponseSchema, issueTokens } from './auth.service.js';
import { revokeAllForUser, revokeRefreshToken, rotateRefreshToken } from './refresh-tokens.js';

const LoginBody = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/auth/login',
    {
      schema: { tags: ['auth'], body: LoginBody, response: { 200: TokenResponseSchema } },
      config: { rateLimit: { max: app.config.LOGIN_RATE_LIMIT_PER_MIN, timeWindow: '1 minute' } },
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
    { schema: { tags: ['auth'], response: { 200: UserOutSchema } }, preHandler: app.requireRoles() },
    async (req) => {
      if (req.principal?.kind !== 'user') throw unauthorized();
      const user = await findUserById(app.db, new ObjectId(req.principal.userId));
      if (!user) throw unauthorized();
      return userOut(user);
    },
  );

  const RefreshBody = z.object({ refreshToken: z.string().min(1) });

  app.post(
    '/auth/refresh',
    { schema: { tags: ['auth'], body: RefreshBody, response: { 200: TokenResponseSchema } } },
    async (req) => {
      const { userId, familyId } = await rotateRefreshToken(app.db, req.body.refreshToken, app.config.REFRESH_REUSE_GRACE_SEC);
      const user = await findUserById(app.db, userId);
      if (!user || !user.active) throw new AppError(401, 'USER_INACTIVE', 'User is inactive');
      return issueTokens(app, user, familyId);
    },
  );

  app.post('/auth/logout', { schema: { tags: ['auth'], body: RefreshBody } }, async (req, reply) => {
    await revokeRefreshToken(app.db, req.body.refreshToken);
    return reply.status(204).send();
  });

  app.post(
    '/me/password',
    {
      schema: {
        tags: ['auth'],
        body: z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(128) }),
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
      await app.db
        .collection(C.users)
        .updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(req.body.newPassword), updatedAt: new Date() } });
      await revokeAllForUser(app.db, user._id);
      await writeAudit(app.db, {
        entity: 'user',
        entityId: user._id.toHexString(),
        action: 'password-change',
        by: actorOf(req),
      });
      return reply.status(204).send();
    },
  );
};
