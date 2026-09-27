import { randomUUID } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import type { App } from '../../src/app.js';
import type { Role } from '../../src/lib/roles.js';
import { createUser, type UserDoc } from '../../src/modules/users/users.repo.js';

export const TEST_PASSWORD = 'Passw0rd!123';

export async function createUserAndLogin(
  app: App,
  roles: Role[],
  opts: { username?: string; driverId?: ObjectId | null } = {},
): Promise<{ user: UserDoc; token: string; refreshToken: string; headers: { authorization: string } }> {
  const username = opts.username ?? `u_${randomUUID().slice(0, 8)}`;
  const user = await createUser(app.db, { username, password: TEST_PASSWORD, roles, driverId: opts.driverId ?? null });
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  const body = res.json();
  return { user, token: body.accessToken, refreshToken: body.refreshToken, headers: { authorization: `Bearer ${body.accessToken}` } };
}
