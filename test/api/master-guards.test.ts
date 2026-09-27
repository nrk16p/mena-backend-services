import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';

describe('master-data guards', () => {
  let app: App;
  let h: { authorization: string };
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });
  const patch = (url: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/v1${url}`, headers: h, payload });

  beforeAll(async () => {
    app = await buildTestApp();
    h = (await createUserAndLogin(app, ['planner'])).headers;
  });
  afterAll(async () => closeTestApp(app));

  it('blocks changing a truck type category while vehicles use it', async () => {
    const used = (await post('/truck-types', { code: 'TRAILER', name: 'Trailer', category: 'tractor' })).json().id;
    const unused = (await post('/truck-types', { code: 'SPARE', name: 'Spare', category: 'tractor' })).json().id;
    await post('/vehicles', { plate: '70-1001', part: 'head', truckTypeId: used });
    const blocked = await patch(`/truck-types/${used}`, { category: 'rigid' });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().code).toBe('TRUCK_TYPE_IN_USE');
    expect((await patch(`/truck-types/${used}`, { name: 'Trailer 22 ล้อ' })).statusCode).toBe(200);
    expect((await patch(`/truck-types/${unused}`, { category: 'rigid' })).json().category).toBe('rigid');
  });

  it('blocks un-marking a site that a job group uses', async () => {
    const zone = (await post('/zones', { code: 'CEN', name: 'Central' })).json().id;
    const client = (await post('/clients', { code: 'SCG', name: 'SCG' })).json().id;
    const site = (await post('/locations', { code: 'PLANT', name: 'Plant', zoneId: zone, isSite: true, lat: 14.5, lng: 100.9 })).json().id;
    const other = (await post('/locations', { code: 'PLANT2', name: 'Plant 2', zoneId: zone, isSite: true, lat: 14.6, lng: 100.8 })).json().id;
    await post(`/clients/${client}/job-groups`, { code: 'G', name: 'G', criteria: { siteIds: [site] } });
    const blocked = await patch(`/locations/${site}`, { isSite: false });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().code).toBe('LOCATION_USED_AS_SITE');
    expect((await patch(`/locations/${site}`, { name: 'Plant renamed' })).statusCode).toBe(200);
    expect((await patch(`/locations/${other}`, { isSite: false })).json().isSite).toBe(false);
  });
});
