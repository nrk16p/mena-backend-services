import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { AppError, unauthorized } from '../../lib/errors.js';
import { dummyHash, verifyPassword } from '../../lib/passwords.js';
import { UserOutSchema, findUserById, findUserByUsername, userOut } from '../users/users.repo.js';
import { TokenResponseSchema, issueTokens } from './auth.service.js';

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
};
