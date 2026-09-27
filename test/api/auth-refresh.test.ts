import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { issueRefreshToken, revokeAllForUser } from '../../src/modules/auth/refresh-tokens.js';
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

  it('tolerates several concurrent refreshes of the same token (race bounded by the grace window)', async () => {
    const { refreshToken } = await createUserAndLogin(app, ['planner']);
    const results = await Promise.all(Array.from({ length: 5 }, () => refresh(app, refreshToken)));
    for (const res of results) expect(res.statusCode).toBe(200);
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

  it('rejects a replay once replacedAt is older than the reuse grace window, and revokes the whole family', async () => {
    const { refreshToken } = await createUserAndLogin(app, ['planner']);
    const rotated = await refresh(app, refreshToken);
    expect(rotated.statusCode).toBe(200);
    const newerToken = rotated.json().refreshToken as string;

    // Backdate the used token's replacedAt beyond the default 30 s grace, simulating
    // a very late/stale retry rather than a quick client-side double-send.
    const usedId = new ObjectId(refreshToken.split('.')[0]);
    const backdated = new Date(Date.now() - 31_000);
    await app.db.collection(C.refreshTokens).updateOne({ _id: usedId }, { $set: { replacedAt: backdated } });

    const replay = await refresh(app, refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('REFRESH_TOKEN_REUSED');

    // The whole family, including the newer token issued by the rotation above, must
    // now be revoked.
    expect((await refresh(app, newerToken)).statusCode).toBe(401);
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

    // Login, the failed refresh checks, and the password change itself must be the
    // ONLY audit-worthy thing here: exactly one auditLog doc for this user, period.
    const allEntriesForUser = await app.db.collection(C.auditLog).find({ entityId: user._id.toHexString() }).toArray();
    expect(allEntriesForUser).toHaveLength(1);
    expect(allEntriesForUser[0].by).toBe(user.username);
  });
});

describe('refresh re-checks the user', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => closeTestApp(app));

  it('rejects a family issued before the last revoke-all even if its tokens escaped the revoke (phantom family)', async () => {
    const { user } = await createUserAndLogin(app, ['planner']);
    await revokeAllForUser(app.db, user._id);
    const cutoff = (await app.db.collection(C.users).findOne({ _id: user._id }))?.tokensValidAfter as Date;
    expect(cutoff).toBeInstanceOf(Date);
    // A login that raced the revoke: its family was created before the cutoff but committed after it,
    // so the revoke's snapshot never saw it and its token is still live.
    const phantom = await issueRefreshToken(app.db, user._id, 1);
    const familyId = (await app.db.collection(C.refreshTokens).findOne({ _id: new ObjectId(phantom.split('.')[0]) }))!.familyId;
    await app.db.collection(C.refreshFamilies).updateOne({ _id: familyId }, { $set: { createdAt: new Date(cutoff.getTime() - 5) } });
    const res = await refresh(app, phantom);
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('accepts a family issued after the last revoke-all', async () => {
    const { user } = await createUserAndLogin(app, ['planner']);
    await revokeAllForUser(app.db, user._id);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: user.username, password: TEST_PASSWORD } });
    expect((await refresh(app, login.json().refreshToken)).statusCode).toBe(200);
  });

  it('rejects a refresh for a deactivated user', async () => {
    const { user, refreshToken } = await createUserAndLogin(app, ['planner']);
    await app.db.collection(C.users).updateOne({ _id: user._id }, { $set: { active: false } });
    expect((await refresh(app, refreshToken)).statusCode).toBe(401);
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

  it('bounds a concurrent refresh race: at most one wins, and the family ends up revoked', async () => {
    const { refreshToken } = await createUserAndLogin(app, ['planner']);
    const results = await Promise.all(Array.from({ length: 5 }, () => refresh(app, refreshToken)));
    const successes = results.filter((r) => r.statusCode === 200);
    expect(successes.length).toBeLessThanOrEqual(1);
    for (const res of successes) {
      const nextToken = res.json().refreshToken as string;
      expect((await refresh(app, nextToken)).statusCode).toBe(401);
    }
  });
});
