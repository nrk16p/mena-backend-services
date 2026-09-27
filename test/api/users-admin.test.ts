import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';

describe('user administration', () => {
  let app: App;
  let admin: { authorization: string };
  let planner: { authorization: string };
  let driverId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    admin = (await createUserAndLogin(app, ['admin'])).headers;
    planner = (await createUserAndLogin(app, ['planner'])).headers;
    const d = await app.db.collection(C.drivers).insertOne({ code: 'D001', name: 'สมชาย', active: true });
    driverId = d.insertedId.toHexString();
  });
  afterAll(async () => closeTestApp(app));

  it('admin creates a user; response has no password hash; audit is written', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/users', headers: admin,
      payload: { username: 'planner2', password: 'Passw0rd!', roles: ['planner'] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ username: 'planner2', roles: ['planner'], active: true, driverId: null });
    expect(JSON.stringify(res.json())).not.toContain('passwordHash');
    const audit = await app.db.collection(C.auditLog).findOne({ entity: 'user', entityId: res.json().id });
    expect(audit?.action).toBe('create');
    expect(JSON.stringify(audit)).not.toContain('passwordHash');
  });

  it('forbids non-admins', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/users', headers: planner });
    expect(res.statusCode).toBe(403);
  });

  it('rejects duplicate usernames with 409', async () => {
    const payload = { username: 'dupe', password: 'Passw0rd!', roles: ['viewer'] };
    await app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload });
    const res = await app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload });
    expect(res.statusCode).toBe(409);
  });

  it('requires a driver link for the driver role and validates it', async () => {
    const noLink = await app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload: { username: 'drv0', password: 'Passw0rd!', roles: ['driver'] } });
    expect(noLink.json().code).toBe('DRIVER_LINK_REQUIRED');
    const badLink = await app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload: { username: 'drv1', password: 'Passw0rd!', roles: ['driver'], driverId: new ObjectId().toHexString() } });
    expect(badLink.json().code).toBe('INVALID_REFERENCE');
    const ok = await app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload: { username: 'drv2', password: 'Passw0rd!', roles: ['driver'], driverId } });
    expect(ok.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload: { username: 'drv3', password: 'Passw0rd!', roles: ['driver'], driverId } });
    expect(second.statusCode).toBe(409);
  });

  it('PATCH deactivates a user and resets a password (revoking sessions)', async () => {
    const target = await createUserAndLogin(app, ['viewer']);
    const id = target.user._id.toHexString();
    const reset = await app.inject({ method: 'PATCH', url: `/api/v1/users/${id}`, headers: admin, payload: { password: 'Brand-new-1' } });
    expect(reset.statusCode).toBe(200);
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: target.refreshToken } });
    expect(r.statusCode).toBe(401);
    const off = await app.inject({ method: 'PATCH', url: `/api/v1/users/${id}`, headers: admin, payload: { active: false } });
    expect(off.json().active).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: target.headers })).statusCode).toBe(401);
  });
});
