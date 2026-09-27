import jwt from '@fastify/jwt';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { ObjectId } from 'mongodb';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { Principal, UserPrincipal } from '../lib/principal.js';
import type { Role } from '../lib/roles.js';
import { findUserById } from '../modules/users/users.repo.js';

export type AccessClaims = { sub: string; roles: Role[] };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyInstance {
    requireRoles: (...roles: Role[]) => preHandlerAsyncHookHandler;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessClaims;
    user: AccessClaims;
  }
}

export default fp(
  async (app) => {
    await app.register(jwt, {
      secret: app.config.JWT_SECRET,
      sign: { expiresIn: `${app.config.ACCESS_TOKEN_TTL_SEC}s` },
    });
    app.decorateRequest('principal', null);

    async function loadUserPrincipal(req: FastifyRequest): Promise<UserPrincipal> {
      if (!req.headers.authorization?.startsWith('Bearer ')) throw unauthorized();
      let claims: AccessClaims;
      try {
        claims = await req.jwtVerify<AccessClaims>();
      } catch {
        throw unauthorized('Invalid or expired token', 'INVALID_TOKEN');
      }
      if (!ObjectId.isValid(claims.sub)) throw unauthorized('Invalid or expired token', 'INVALID_TOKEN');
      const user = await findUserById(app.db, new ObjectId(claims.sub));
      if (!user || !user.active) throw unauthorized('User is inactive', 'USER_INACTIVE');
      return {
        kind: 'user',
        userId: user._id.toHexString(),
        username: user.username,
        roles: user.roles,
        driverId: user.driverId?.toHexString() ?? null,
      };
    }

    app.decorate('requireRoles', (...roles: Role[]): preHandlerAsyncHookHandler => {
      return async (req) => {
        const principal = await loadUserPrincipal(req);
        if (roles.length > 0 && !principal.roles.some((r) => roles.includes(r))) throw forbidden();
        req.principal = principal;
      };
    });
  },
  { name: 'auth', dependencies: ['mongo'] },
);
