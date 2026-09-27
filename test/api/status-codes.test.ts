import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';

describe('status codes, holidays, driver days off', () => {
  let app: App;
  let admin: { authorization: string };
  let planner: { authorization: string };
  beforeAll(async () => {
    app = await buildTestApp();
    admin = (await createUserAndLogin(app, ['admin'])).headers;
    planner = (await createUserAndLogin(app, ['planner'])).headers;
  });
  afterAll(async () => closeTestApp(app));

  it('lets only admins manage status codes and rejects blocking working codes', async () => {
    const payload = { code: 'PM', name: 'เข้า PM', level1: 'not_working', appliesTo: 'vehicle', blocksAssignment: true };
    expect((await app.inject({ method: 'POST', url: '/api/v1/status-codes', headers: planner, payload })).statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/status-codes', headers: admin, payload });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ code: 'PM', level1: 'not_working', blocksAssignment: true });
    const bad = await app.inject({
      method: 'POST', url: '/api/v1/status-codes', headers: admin,
      payload: { code: 'A', name: 'ทำงาน', level1: 'working', appliesTo: 'both', blocksAssignment: true },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('INVALID_STATUS_CODE');
    const list = await app.inject({ method: 'GET', url: '/api/v1/status-codes?level1=not_working', headers: planner });
    expect(list.json().items.map((s: { code: string }) => s.code)).toEqual(['PM']);
  });

  it('manages company holidays with a unique date', async () => {
    const payload = { date: '2026-10-13', name: 'วันนวมินทรมหาราช' };
    expect((await app.inject({ method: 'POST', url: '/api/v1/holidays', headers: planner, payload })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/v1/holidays', headers: planner, payload })).statusCode).toBe(409);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/holidays', headers: planner, payload: { date: '13/10/2026', name: 'x' } });
    expect(bad.statusCode).toBe(400);
  });

  it('stores driver weekly days off, defaulting to none', async () => {
    const d = await app.inject({ method: 'POST', url: '/api/v1/drivers', headers: planner, payload: { code: 'D1', name: 'Driver 1', weeklyDaysOff: [0, 6] } });
    expect(d.json().weeklyDaysOff).toEqual([0, 6]);
    const e = await app.inject({ method: 'POST', url: '/api/v1/drivers', headers: planner, payload: { code: 'D2', name: 'Driver 2' } });
    expect(e.json().weeklyDaysOff).toEqual([]);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/drivers', headers: planner, payload: { code: 'D3', name: 'x', weeklyDaysOff: [7] } });
    expect(bad.statusCode).toBe(400);
  });
});
