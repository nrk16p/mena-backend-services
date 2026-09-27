import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { createUser } from '../../src/modules/users/users.repo.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { TEST_PASSWORD, createUserAndLogin } from '../helpers/auth.js';

describe('login and /me', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => closeTestApp(app));

  it('logs in, returns a 1-hour access token and records lastLogin', async () => {
    await createUser(app.db, { username: 'planner1', password: TEST_PASSWORD, roles: ['planner'] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'planner1', password: TEST_PASSWORD, lat: 13.75, lng: 100.5 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ tokenType: 'Bearer', expiresIn: 3600, user: { username: 'planner1', roles: ['planner'], driverId: null } });
    expect(body.refreshToken).toMatch(/^[a-f0-9]{24}\./);
    const claims = app.jwt.decode<{ iat: number; exp: number; sub: string }>(body.accessToken)!;
    expect(claims.exp - claims.iat).toBe(3600);
    const user = await app.db.collection(C.users).findOne({ username: 'planner1' });
    expect(user?.lastLogin).toMatchObject({ lat: 13.75, lng: 100.5 });
  });

  it('rejects a wrong password and an unknown user with the same error', async () => {
    const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'planner1', password: 'nope' } });
    const unknown = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'ghost', password: 'nope' } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.json().code).toBe('INVALID_CREDENTIALS');
  });

  it('returns the current user on /me', async () => {
    const { headers, user } = await createUserAndLogin(app, ['viewer']);
    const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: user._id.toHexString(), username: user.username, roles: ['viewer'], driverId: null });
    expect(res.json()).not.toHaveProperty('passwordHash');
  });

  it('requires a token on /me', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a deactivated user immediately, even with a valid token', async () => {
    const { headers, user } = await createUserAndLogin(app, ['planner']);
    await app.db.collection(C.users).updateOne({ _id: user._id }, { $set: { active: false } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers });
    expect(res.statusCode).toBe(401);
  });

  it('rejects login for an inactive user', async () => {
    await createUser(app.db, { username: 'gone', password: TEST_PASSWORD, roles: ['viewer'] });
    await app.db.collection(C.users).updateOne({ username: 'gone' }, { $set: { active: false } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'gone', password: TEST_PASSWORD } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an overlong password with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'planner1', password: 'a'.repeat(129) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('login rate limit', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildTestApp({ LOGIN_RATE_LIMIT_PER_MIN: '2' });
  });
  afterAll(async () => closeTestApp(app));

  it('returns 429 RATE_LIMITED after the limit', async () => {
    const attempt = () => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'x', password: 'y' } });
    await attempt();
    await attempt();
    const third = await attempt();
    expect(third.statusCode).toBe(429);
    expect(third.json().code).toBe('RATE_LIMITED');
  });

  it('keys the limit by ip+username, not ip alone: distinct (case-insensitive) usernames get separate budgets', async () => {
    const attempt = (username: string) => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: 'y' } });
    expect((await attempt('alice')).statusCode).not.toBe(429);
    expect((await attempt('alice')).statusCode).not.toBe(429);
    expect((await attempt('bob')).statusCode).not.toBe(429);
    expect((await attempt('bob')).statusCode).not.toBe(429);
    const aliceThird = await attempt('  Alice  ');
    expect(aliceThird.statusCode).toBe(429);
    expect(aliceThird.json().code).toBe('RATE_LIMITED');
    const bobThird = await attempt('BOB');
    expect(bobThird.statusCode).toBe(429);
  });
});
