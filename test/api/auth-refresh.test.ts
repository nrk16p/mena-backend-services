import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { TEST_PASSWORD, createUserAndLogin } from '../helpers/auth.js';

const refresh = (app: App, refreshToken: string) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken } });

describe('refresh tokens (default 30 s reuse grace)', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => closeTestApp(app));

  it('rotates: returns a new pair', async () => {
    const { refreshToken } = await createUserAndLogin(app, ['planner']);
    const res = await refresh(app, refreshToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().refreshToken).not.toBe(refreshToken);
    expect(res.json().accessToken).toBeTruthy();
  });

  it('tolerates a quick retry of the same token (flaky network)', async () => {
    const { refreshToken } = await createUserAndLogin(app, ['driver'], { driverId: null });
    const a = await refresh(app, refreshToken);
    const b = await refresh(app, refreshToken);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
  });

  it('rejects garbage tokens', async () => {
    expect((await refresh(app, 'nope')).json().code).toBe('INVALID_REFRESH_TOKEN');
    expect((await refresh(app, `${'a'.repeat(24)}.xyz`)).statusCode).toBe(401);
  });

  it('logout revokes the token', async () => {
    const { refreshToken } = await createUserAndLogin(app, ['planner']);
    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', payload: { refreshToken } });
    expect(out.statusCode).toBe(204);
    expect((await refresh(app, refreshToken)).statusCode).toBe(401);
  });

  it('refuses refresh for a deactivated user', async () => {
    const { refreshToken, user } = await createUserAndLogin(app, ['planner']);
    await app.db.collection(C.users).updateOne({ _id: user._id }, { $set: { active: false } });
    expect((await refresh(app, refreshToken)).statusCode).toBe(401);
  });

  it('changes password, revokes sessions, and the new password works', async () => {
    const { headers, refreshToken, user } = await createUserAndLogin(app, ['viewer']);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/me/password', headers, payload: { currentPassword: 'wrong', newPassword: 'NewPassw0rd!' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('INVALID_CURRENT_PASSWORD');
    const ok = await app.inject({ method: 'POST', url: '/api/v1/me/password', headers, payload: { currentPassword: TEST_PASSWORD, newPassword: 'NewPassw0rd!' } });
    expect(ok.statusCode).toBe(204);
    expect((await refresh(app, refreshToken)).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: user.username, password: 'NewPassw0rd!' } });
    expect(login.statusCode).toBe(200);

    const entries = await app.db
      .collection(C.auditLog)
      .find({ entity: 'user', action: 'password-change', entityId: user._id.toHexString() })
      .toArray();
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0])).not.toContain('passwordHash');
  });
});

describe('refresh token reuse detection (no grace)', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildTestApp({ REFRESH_REUSE_GRACE_SEC: '0' });
  });
  afterAll(async () => closeTestApp(app));

  it('revokes the whole family when an old token is replayed', async () => {
    const { refreshToken } = await createUserAndLogin(app, ['planner']);
    const first = await refresh(app, refreshToken);
    expect(first.statusCode).toBe(200);
    const replay = await refresh(app, refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('REFRESH_TOKEN_REUSED');
    expect((await refresh(app, first.json().refreshToken)).statusCode).toBe(401);
  });
});
