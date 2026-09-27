import type { Role } from './roles.js';

export type UserPrincipal = { kind: 'user'; userId: string; username: string; roles: Role[]; driverId: string | null };
export type ApiKeyPrincipal = { kind: 'apiKey'; keyId: string; name: string; scopes: string[] };
export type Principal = UserPrincipal | ApiKeyPrincipal;
