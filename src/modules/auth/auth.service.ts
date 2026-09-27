import type { FastifyInstance } from 'fastify';
import type { ObjectId } from 'mongodb';
import { z } from 'zod';
import { type UserDoc, UserOutSchema, userOut } from '../users/users.repo.js';
import { issueRefreshToken } from './refresh-tokens.js';

export const TokenResponseSchema = z.object({
  accessToken: z.string().describe('JWT access token; send it as `Authorization: Bearer <accessToken>` on subsequent requests.'),
  refreshToken: z.string().describe('Opaque refresh token, as `<id>.<secret>`; exchange it at `POST /auth/refresh` for a new pair before/after `accessToken` expires. Single-use: exchanging it invalidates it.'),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().describe('Seconds until `accessToken` expires.'),
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
