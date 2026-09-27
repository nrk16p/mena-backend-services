import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';

// Local inline helper (test/helpers/http.ts does not exist yet in this worktree; it belongs
// to a parallel task). Asserts the response status and returns the parsed JSON body.
type InjectResponse = Awaited<ReturnType<App['inject']>>;
function ok(res: InjectResponse, status = 200): any {
  expect(res.statusCode).toBe(status);
  return res.json();
}

describe('driver link hygiene', () => {
  let app: App;
  let admin: { authorization: string };
  const newDriver = async (code: string) =>
    (await app.db.collection(C.drivers).insertOne({ code, name: `Driver ${code}`, active: true })).insertedId.toHexString();
  const createUser = (username: string, body: object) =>
    app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload: { username, password: 'Passw0rd!', ...body } });
  const patchUser = (id: string, body: object) => app.inject({ method: 'PATCH', url: `/api/v1/users/${id}`, headers: admin, payload: body });

  beforeAll(async () => {
    app = await buildTestApp();
    admin = (await createUserAndLogin(app, ['admin'])).headers;
  });
  afterAll(async () => closeTestApp(app));

  it('releases the link when the driver role is removed, so the driver can be linked to a new account', async () => {
    const driverId = await newDriver('L100');
    const first = ok(await createUser('drv-a', { roles: ['driver'], driverId }), 201);
    const taken = await createUser('drv-b', { roles: ['driver'], driverId });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: 'DRIVER_ALREADY_LINKED', details: { username: 'drv-a' } });
    expect(ok(await patchUser(first.id, { roles: ['viewer'] }))).toMatchObject({ roles: ['viewer'], driverId: null });
    expect(ok(await createUser('drv-b', { roles: ['driver'], driverId }), 201).driverId).toBe(driverId);
  });

  it('releases the link when the account is deactivated and requires re-linking on reactivation', async () => {
    const driverId = await newDriver('L101');
    const user = ok(await createUser('drv-c', { roles: ['driver'], driverId }), 201);
    expect(ok(await patchUser(user.id, { active: false }))).toMatchObject({ active: false, driverId: null });
    expect(ok(await createUser('drv-d', { roles: ['driver'], driverId }), 201).driverId).toBe(driverId);
    expect((await patchUser(user.id, { active: true })).json().code).toBe('DRIVER_LINK_REQUIRED');
    const other = await newDriver('L102');
    expect(ok(await patchUser(user.id, { active: true, driverId: other }))).toMatchObject({ active: true, driverId: other });
  });

  it('refuses a driver link on a non-driver or inactive account', async () => {
    const driverId = await newDriver('L103');
    expect((await createUser('plan-x', { roles: ['planner'], driverId })).json().code).toBe('DRIVER_LINK_NOT_ALLOWED');
    const user = ok(await createUser('drv-e', { roles: ['driver'], driverId }), 201);
    expect((await patchUser(user.id, { active: false, driverId })).json().code).toBe('DRIVER_LINK_NOT_ALLOWED');
    expect((await patchUser(user.id, { roles: ['viewer'], driverId })).json().code).toBe('DRIVER_LINK_NOT_ALLOWED');
    expect(await app.db.collection(C.users).findOne({ username: 'drv-e' })).toMatchObject({ active: true, roles: ['driver'] });
  });
});
