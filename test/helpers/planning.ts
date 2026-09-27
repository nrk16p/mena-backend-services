import { ObjectId } from 'mongodb';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { seedBase } from '../../src/seed/seed.js';
import { createUserAndLogin } from './auth.js';

type H = { authorization: string };

export interface PlanningFixtures {
  admin: H;
  planner: H;
  viewer: H;
  driver1: H;
  driver2: H;
  ids: {
    scg: string; cpac: string; zCen: string; zNe: string;
    locA: string; locB: string; locC: string; locD: string;
    bulk: string; bag: string; single: string;
    trailerType: string; mixerType: string;
    h1: string; h2: string; t1: string; t2: string; m1: string;
    d1: string; d2: string; d3: string;
    bulkGroup: string;
  };
}

export async function setupPlanning(app: App): Promise<PlanningFixtures> {
  await seedBase(app.db);
  const admin = (await createUserAndLogin(app, ['admin'])).headers;
  const planner = (await createUserAndLogin(app, ['planner'])).headers;
  const viewer = (await createUserAndLogin(app, ['viewer'])).headers;
  const post = async (url: string, payload: object): Promise<string> => {
    const res = await app.inject({ method: 'POST', url: `/api/v1${url}`, headers: admin, payload });
    if (res.statusCode !== 201) throw new Error(`${url} → ${res.statusCode} ${res.body}`);
    return res.json().id as string;
  };
  const typeId = async (code: string) => ((await app.db.collection(C.truckTypes).findOne({ code }))!._id as ObjectId).toHexString();
  const trailerType = await typeId('TRAILER');
  const mixerType = await typeId('MIXER');
  const scg = await post('/clients', { code: 'SCG', name: 'SCG' });
  const cpac = await post('/clients', { code: 'CPAC', name: 'CPAC' });
  const zCen = await post('/zones', { code: 'CEN', name: 'ภาคกลาง' });
  const zNe = await post('/zones', { code: 'NE', name: 'อีสาน' });
  const locA = await post('/locations', { code: 'A', name: 'Plant A', zoneId: zCen, isSite: true, lat: 14.53, lng: 100.91 });
  const locB = await post('/locations', { code: 'B', name: 'Site B', zoneId: zCen, lat: 13.75, lng: 100.5 });
  const locC = await post('/locations', { code: 'C', name: 'Shop C', zoneId: zNe, lat: 16.43, lng: 102.83 });
  const locD = await post('/locations', { code: 'D', name: 'Shop D', zoneId: zNe, lat: 15.24, lng: 104.85 });
  const bulk = await post('/materials', { code: 'BULK', name: 'ปูนผง', unit: 'ton' });
  const bag = await post('/materials', { code: 'BAG', name: 'ปูนถุง', unit: 'bag' });
  const single = await post('/service-types', { code: 'SINGLE', name: 'ส่งเที่ยวเดียว' });
  const h1 = await post('/vehicles', { plate: '70-1001', part: 'head', truckTypeId: trailerType });
  const h2 = await post('/vehicles', { plate: '70-1002', part: 'head', truckTypeId: trailerType });
  const t1 = await post('/vehicles', { plate: '71-2001', part: 'tail', truckTypeId: trailerType });
  const t2 = await post('/vehicles', { plate: '71-2002', part: 'tail', truckTypeId: trailerType });
  const m1 = await post('/vehicles', { plate: '80-3001', part: 'rigid', truckTypeId: mixerType });
  const d1 = await post('/drivers', { code: 'D1', name: 'Driver One', licenseExpiry: '2030-12-31' });
  const d2 = await post('/drivers', { code: 'D2', name: 'Driver Two', licenseExpiry: '2030-12-31' });
  const d3 = await post('/drivers', { code: 'D3', name: 'Driver Three', licenseExpiry: '2026-10-01', weeklyDaysOff: [0] });
  const driver1 = (await createUserAndLogin(app, ['driver'], { driverId: new ObjectId(d1) })).headers;
  const driver2 = (await createUserAndLogin(app, ['driver'], { driverId: new ObjectId(d2) })).headers;
  const bulkGroup = await post(`/clients/${scg}/job-groups`, {
    code: 'BULK-A', name: 'ปูนผงจาก A', criteria: { materialIds: [bulk], siteIds: [locA] },
  });
  return {
    admin, planner, viewer, driver1, driver2,
    ids: { scg, cpac, zCen, zNe, locA, locB, locC, locD, bulk, bag, single, trailerType, mixerType, h1, h2, t1, t2, m1, d1, d2, d3, bulkGroup },
  };
}

export async function createDo(app: App, f: PlanningFixtures, overrides: object = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/delivery-orders',
    headers: f.planner,
    payload: {
      clientId: f.ids.scg, serviceTypeId: f.ids.single, materialId: f.ids.bulk, qty: 30,
      originLocationId: f.ids.locA, destLocationId: f.ids.locB, ...overrides,
    },
  });
  if (res.statusCode !== 201) throw new Error(`createDo → ${res.statusCode} ${res.body}`);
  return res.json();
}

export async function validate(app: App, f: PlanningFixtures, payload: object) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/shipments/validate', headers: f.planner, payload });
  if (res.statusCode !== 200) throw new Error(`validate → ${res.statusCode} ${res.body}`);
  return res.json() as { errors: { code: string; details?: unknown }[]; warnings: { code: string; details?: unknown }[]; stops: unknown[]; legs: { doIds: string[]; loaded: boolean }[] };
}

export const codes = (issues: { code: string }[]) => issues.map((i) => i.code).sort();

export async function postShipment(app: App, f: PlanningFixtures, payload: object) {
  return app.inject({ method: 'POST', url: '/api/v1/shipments', headers: f.planner, payload });
}
