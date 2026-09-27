import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';

describe('job groups', () => {
  let app: App;
  let h: { authorization: string };
  const ids: Record<string, string> = {};
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });

  beforeAll(async () => {
    app = await buildTestApp();
    h = (await createUserAndLogin(app, ['planner'])).headers;
    ids.scg = (await post('/clients', { code: 'SCG', name: 'SCG' })).json().id;
    ids.cpac = (await post('/clients', { code: 'CPAC', name: 'CPAC' })).json().id;
    ids.zCen = (await post('/zones', { code: 'CEN', name: 'Central' })).json().id;
    ids.zNe = (await post('/zones', { code: 'NE', name: 'Northeast' })).json().id;
    ids.bulk = (await post('/materials', { code: 'BULK', name: 'ปูนผง', unit: 'ton' })).json().id;
    ids.bag = (await post('/materials', { code: 'BAG', name: 'ปูนถุง', unit: 'bag' })).json().id;
    ids.single = (await post('/service-types', { code: 'SINGLE', name: 'Single' })).json().id;
    ids.trailer = (await post('/truck-types', { code: 'TRAILER', name: 'Trailer', category: 'tractor' })).json().id;
    ids.plant = (await post('/locations', { code: 'SRB', name: 'Saraburi plant', zoneId: ids.zCen, isSite: true, lat: 14.5, lng: 100.9 })).json().id;
    ids.shop = (await post('/locations', { code: 'KKN', name: 'Khon Kaen shop', zoneId: ids.zNe, lat: 16.4, lng: 102.8 })).json().id;
  });
  afterAll(async () => closeTestApp(app));

  it('creates job groups scoped to a client with validated criteria', async () => {
    const res = await post(`/clients/${ids.scg}/job-groups`, {
      code: 'BULK-SRB', name: 'ปูนผง-สระบุรี-หัวลาก',
      criteria: { materialIds: [ids.bulk], siteIds: [ids.plant], truckTypeIds: [ids.trailer] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ clientId: ids.scg, criteria: { materialIds: [ids.bulk], serviceTypeIds: [] } });
    const same = await post(`/clients/${ids.cpac}/job-groups`, { code: 'BULK-SRB', name: 'same code, other client', criteria: {} });
    expect(same.statusCode).toBe(201);
    expect((await post(`/clients/${ids.scg}/job-groups`, { code: 'BULK-SRB', name: 'dupe', criteria: {} })).statusCode).toBe(409);
    const list = await app.inject({ method: 'GET', url: `/api/v1/clients/${ids.scg}/job-groups`, headers: h });
    expect(list.json().items).toHaveLength(1);
  });

  it('rejects unknown refs, non-site sites and unknown clients', async () => {
    expect((await post(`/clients/${ids.scg}/job-groups`, { code: 'A', name: 'A', criteria: { materialIds: ['0123456789abcdef01234567'] } })).json().code).toBe('INVALID_REFERENCE');
    expect((await post(`/clients/${ids.scg}/job-groups`, { code: 'B', name: 'B', criteria: { siteIds: [ids.shop] } })).json().code).toBe('NOT_A_SITE');
    expect((await post('/clients/0123456789abcdef01234567/job-groups', { code: 'C', name: 'C', criteria: {} })).statusCode).toBe(404);
  });

  it('previews matching for DO fields', async () => {
    await post(`/clients/${ids.scg}/job-groups`, { code: 'BAG-NE', name: 'ปูนถุง-อีสาน', criteria: { materialIds: [ids.bag], destZoneIds: [ids.zNe] } });
    const match = (payload: object) => post(`/clients/${ids.scg}/job-groups/match`, payload);
    const auto = await match({ truckTypeId: ids.trailer, serviceTypeId: ids.single, materialId: ids.bulk, originLocationId: ids.plant, destLocationId: ids.shop });
    expect(auto.json()).toMatchObject({ status: 'auto' });
    const noTruck = await match({ truckTypeId: null, serviceTypeId: ids.single, materialId: ids.bulk, originLocationId: ids.plant, destLocationId: ids.shop });
    expect(noTruck.json().status).toBe('none');
    const bag = await match({ truckTypeId: null, serviceTypeId: ids.single, materialId: ids.bag, originLocationId: ids.plant, destLocationId: ids.shop });
    expect(bag.json().status).toBe('auto');
  });
});
