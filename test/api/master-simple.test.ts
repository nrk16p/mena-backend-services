import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';

describe('simple master data', () => {
  let app: App;
  let planner: { authorization: string };
  let viewer: { authorization: string };
  let driver: { authorization: string };

  beforeAll(async () => {
    app = await buildTestApp();
    planner = (await createUserAndLogin(app, ['planner'])).headers;
    viewer = (await createUserAndLogin(app, ['viewer'])).headers;
    driver = (await createUserAndLogin(app, ['driver'])).headers;
  });
  afterAll(async () => closeTestApp(app));

  const post = (url: string, payload: object, headers = planner) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers, payload });
  const get = (url: string, headers = planner) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers });

  it('creates, reads, updates and deactivates a zone with audit', async () => {
    const created = await post('/zones', { code: 'BKK', name: 'กรุงเทพ' });
    expect(created.statusCode).toBe(201);
    const zone = created.json();
    expect(zone).toMatchObject({ code: 'BKK', name: 'กรุงเทพ', active: true });
    expect((await get(`/zones/${zone.id}`, viewer)).json().name).toBe('กรุงเทพ');
    const patched = await app.inject({ method: 'PATCH', url: `/api/v1/zones/${zone.id}`, headers: planner, payload: { name: 'Bangkok' } });
    expect(patched.json().name).toBe('Bangkok');
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/zones/${zone.id}`, headers: planner });
    expect(del.json().active).toBe(false);
    expect((await get('/zones')).json().items.find((z: { id: string }) => z.id === zone.id)).toBeUndefined();
    expect((await get('/zones?active=all')).json().items.find((z: { id: string }) => z.id === zone.id)).toBeDefined();
    const actions = await app.db
      .collection(C.auditLog)
      .find({ entity: 'zone', entityId: zone.id })
      .sort({ _id: 1 })
      .map((a) => a.action)
      .toArray();
    expect(actions).toEqual(['create', 'update', 'deactivate']);
  });

  it('enforces roles: viewer cannot write, driver cannot read master data', async () => {
    expect((await post('/clients', { code: 'X', name: 'X' }, viewer)).statusCode).toBe(403);
    expect((await get('/clients', driver)).statusCode).toBe(403);
  });

  it('returns 409 on duplicate code, 400 on bad id, 404 on unknown id', async () => {
    await post('/clients', { code: 'SCG', name: 'SCG' });
    expect((await post('/clients', { code: 'SCG', name: 'again' })).statusCode).toBe(409);
    expect((await get('/clients/not-an-id')).json().code).toBe('VALIDATION_ERROR');
    expect((await get('/clients/0123456789abcdef01234567')).statusCode).toBe(404);
  });

  it('paginates and searches', async () => {
    for (const code of ['M1', 'M2', 'M3']) await post('/materials', { code, name: `ปูน ${code}`, unit: 'ton' });
    const p1 = (await get('/materials?limit=2')).json();
    expect(p1.items).toHaveLength(2);
    const p2 = (await get(`/materials?limit=2&cursor=${p1.nextCursor}`)).json();
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect((await get('/materials?q=m2')).json().items.map((m: { code: string }) => m.code)).toEqual(['M2']);
  });

  it('validates truck type category and service types', async () => {
    expect((await post('/truck-types', { code: 'MIXER', name: 'Mixer', category: 'rigid' })).statusCode).toBe(201);
    expect((await post('/truck-types', { code: 'BAD', name: 'Bad', category: 'boat' })).statusCode).toBe(400);
    expect((await post('/service-types', { code: 'DAILY', name: 'เหมาวัน' })).statusCode).toBe(201);
  });

  it('restricts pallet movement type writes to admin', async () => {
    expect((await post('/pallet-movement-types', { code: 'RETURN_IN', name: 'รับคืน', sign: 1 })).statusCode).toBe(403);
    const admin = (await createUserAndLogin(app, ['admin'])).headers;
    expect((await post('/pallet-movement-types', { code: 'RETURN_IN', name: 'รับคืน', sign: 1 }, admin)).statusCode).toBe(201);
    expect((await post('/pallet-movement-types', { code: 'X', name: 'x', sign: 2 }, admin)).statusCode).toBe(400);
  });
});
