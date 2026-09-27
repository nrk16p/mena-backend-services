import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { type PlanningFixtures, createDo, postShipment, setupPlanning } from '../helpers/planning.js';

describe('dispatch and driver response', () => {
  let app: App;
  let f: PlanningFixtures;
  const day = (d: number, h: number) => `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00+07:00`;
  const post = (url: string, headers: { authorization: string }, payload?: object) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers, payload });
  const driverList = (headers: { authorization: string }) => app.inject({ method: 'GET', url: '/api/v1/driver/shipments', headers });

  async function plannedShipment(d: number) {
    const o = await createDo(app, f);
    const sh = (await postShipment(app, f, { plannedStart: day(d, 6), plannedEnd: day(d, 18), head: { vehicleId: f.ids.h1, driverId: f.ids.d1 }, tail: { vehicleId: f.ids.t1, driverId: f.ids.d1 }, doIds: [o.id] })).json();
    return (await post(`/shipments/${sh.id}/plan`, f.planner, { version: 1 })).json();
  }

  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('dispatches, shows the job only to its driver, and records acceptance', async () => {
    const sh = await plannedShipment(5);
    const draftOnly = (await postShipment(app, f, { plannedStart: day(20, 6), plannedEnd: day(20, 8), mode: 'draft' })).json();
    expect((await post(`/shipments/${draftOnly.id}/dispatch`, f.planner, { version: 1 })).json().code).toBe('SHIPMENT_NOT_PLANNED');
    const dispatched = await post(`/shipments/${sh.id}/dispatch`, f.planner, { version: sh.version });
    expect(dispatched.json()).toMatchObject({ status: 'DISPATCHED', dispatch: { version: sh.version + 1 } });
    const mine = (await driverList(f.driver1)).json().items;
    expect(mine.map((s: { id: string }) => s.id)).toEqual([sh.id]);
    expect(mine[0].deliveryOrders).toHaveLength(1);
    expect(mine[0].locations.map((l: { code: string }) => l.code).sort()).toEqual(['A', 'B']);
    expect((await driverList(f.driver2)).json().items).toEqual([]);
    expect((await post(`/driver/shipments/${sh.id}/accept`, f.driver2)).statusCode).toBe(404);
    const accepted = await post(`/driver/shipments/${sh.id}/accept`, f.driver1);
    expect(accepted.json()).toMatchObject({ status: 'ACCEPTED', driverResponse: { status: 'ACCEPTED' } });
    expect((await post(`/driver/shipments/${sh.id}/accept`, f.driver1)).json().code).toBe('SHIPMENT_NOT_DISPATCHED');
  });

  it('returns a declined shipment to the planner with the reason', async () => {
    const sh = await plannedShipment(7);
    await post(`/shipments/${sh.id}/dispatch`, f.planner, { version: sh.version });
    const declined = await post(`/driver/shipments/${sh.id}/decline`, f.driver1, { reason: 'รถมีปัญหาเบรก' });
    expect(declined.json()).toMatchObject({ status: 'PLANNED', dispatch: null, driverResponse: { status: 'DECLINED', reason: 'รถมีปัญหาเบรก' } });
  });

  it('pulls an accepted shipment back to PLANNED when the planner edits it', async () => {
    const sh = await plannedShipment(9);
    const d = (await post(`/shipments/${sh.id}/dispatch`, f.planner, { version: sh.version })).json();
    const a = (await post(`/driver/shipments/${sh.id}/accept`, f.driver1)).json();
    expect(a.version).toBe(d.version + 1);
    const edited = await app.inject({ method: 'PATCH', url: `/api/v1/shipments/${sh.id}`, headers: f.planner, payload: { version: a.version, plannedEnd: day(9, 20) } });
    expect(edited.json()).toMatchObject({ status: 'PLANNED', dispatch: null, driverResponse: null });
    expect((await driverList(f.driver1)).json().items.map((s: { id: string }) => s.id)).not.toContain(sh.id);
  });

  it('rejects driver endpoints for staff and users without a driver link', async () => {
    expect((await driverList(f.planner)).statusCode).toBe(403);
  });
});
