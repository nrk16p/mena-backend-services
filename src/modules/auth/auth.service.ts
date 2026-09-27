import type { FastifyInstance } from 'fastify';
import type { ObjectId } from 'mongodb';
import { z } from 'zod';
import { type UserDoc, UserOutSchema, userOut } from '../users/users.repo.js';
import { issueRefreshToken } from './refresh-tokens.js';

export const TokenResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number(),
  user: UserOutSchema,
});

export async function issueTokens(app: FastifyInstance, user: UserDoc, familyId?: ObjectId) {
  const accessToken = app.jwt.sign({ sub: user._id.toHexString(), roles: user.roles });
  const refreshToken = await issueRefreshToken(app.db, user._id, app.config.REFRESH_TOKEN_TTL_DAYS, familyId);
  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer' as const,
    expiresIn: app.config.ACCESS_TOKEN_TTL_SEC,
    user: userOut(user),
  };
}
