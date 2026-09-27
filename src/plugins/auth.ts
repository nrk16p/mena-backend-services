import jwt from '@fastify/jwt';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { ObjectId } from 'mongodb';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { Principal, UserPrincipal } from '../lib/principal.js';
import type { Role } from '../lib/roles.js';
import { authenticateApiKey } from '../modules/api-keys/api-keys.service.js';
import { findUserById } from '../modules/users/users.repo.js';

export type AccessClaims = { sub: string; roles: Role[] };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyInstance {
    requireRoles: (...roles: Role[]) => preHandlerAsyncHookHandler;
    requireScope: (scope: string) => preHandlerAsyncHookHandler;
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

    app.decorate('requireScope', (scope: string): preHandlerAsyncHookHandler => {
      return async (req) => {
        const raw = req.headers['x-api-key'];
        if (typeof raw !== 'string' || raw.length === 0) throw unauthorized('API key required', 'API_KEY_REQUIRED');
        const principal = await authenticateApiKey(app.db, app.config.API_KEY_PEPPER, raw);
        if (!principal) throw unauthorized('Invalid API key', 'INVALID_API_KEY');
        if (!principal.scopes.includes(scope)) throw forbidden(`API key lacks scope ${scope}`);
        req.principal = principal;
      };
    });
  },
  { name: 'auth', dependencies: ['mongo'] },
);
