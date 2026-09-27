import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { ok } from '../helpers/http.js';
import { createDo, type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

// Tasks 4/5/6 (driver events / stop context / PODs) are being built on another branch and are not
// in this worktree, so `acceptedShipment` and `gps` — which would normally live in
// `test/helpers/execution.ts` — are inlined here instead of creating that shared file. The
// production route only needs a geofence lookup (locations `geo`/`geofenceRadiusM`, same shape
// already used in `driver.routes.ts`), which is implemented locally in `pallets.routes.ts`.

/** Plans, dispatches and accepts a single-DO shipment (Plant A -> Site B) on the rigid mixer m1/driver d1. */
async function acceptedShipment(app: App, f: PlanningFixtures) {
  const o = await createDo(app, f, { originLocationId: f.ids.locA, destLocationId: f.ids.locB });
  const created = ok(
    await app.inject({
      method: 'POST',
      url: '/api/v1/shipments',
      headers: f.planner,
      payload: {
        plannedStart: '2026-10-05T06:00:00+07:00',
        plannedEnd: '2026-10-05T18:00:00+07:00',
        head: { vehicleId: f.ids.m1, driverId: f.ids.d1 },
        doIds: [o.id],
      },
    }),
    201,
  );
  const planned = ok(await app.inject({ method: 'POST', url: `/api/v1/shipments/${created.id}/plan`, headers: f.planner, payload: { version: created.version } }));
  const dispatched = ok(await app.inject({ method: 'POST', url: `/api/v1/shipments/${created.id}/dispatch`, headers: f.planner, payload: { version: planned.version } }));
  const shipment = ok(await app.inject({ method: 'POST', url: `/api/v1/driver/shipments/${created.id}/accept`, headers: f.driver1, payload: { version: dispatched.version } }));
  return { shipment };
}

/** GPS fields landing exactly on Plant A (locA, lat 14.53 / lng 100.91, default 300m geofence) with a fresh, accurate fix. */
function gps(overrides: object = {}) {
  return { lat: 14.53, lng: 100.91, accuracyM: 10, noGpsReason: null, deviceTime: new Date().toISOString(), ...overrides };
}

describe('pallets', () => {
  let app: App;
  let f: PlanningFixtures;
  let shipment: { id: string; stops: { stopId: string }[] };
  const move = (typeCode: string, qty: number, id = randomUUID(), extra: object = {}) => ({ clientEventId: id, shipmentId: shipment.id, typeCode, qty, ...gps(), ...extra });
  const send = (movements: object[]) => app.inject({ method: 'POST', url: '/api/v1/driver/pallet-movements', headers: f.driver1, payload: { movements } });
  const balances = async () => ok(await app.inject({ method: 'GET', url: `/api/v1/pallet-balances?tailVehicleId=${f.ids.m1}`, headers: f.viewer })).items;

  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
    shipment = (await acceptedShipment(app, f)).shipment;
  });
  afterAll(async () => closeTestApp(app));

  it('keeps a running balance per vehicle, records the stop, and is idempotent', async () => {
    const id = randomUUID();
    const res = ok(await send([move('RETURN_IN', 10, id, { stopId: shipment.stops[0].stopId }), move('DEPOSIT', 3)])).results;
    expect(res.map((r: { balanceAfter: number }) => r.balanceAfter)).toEqual([10, 7]);
    expect(ok(await send([move('RETURN_IN', 10, id)])).results[0].status).toBe('duplicate');
    expect(ok(await send([move('NOPE', 1)])).results[0].code).toBe('INVALID_REFERENCE');
    expect(ok(await send([move('DEPOSIT', 1, randomUUID(), { stopId: new ObjectId().toHexString() })])).results[0]).toMatchObject({ status: 'rejected', code: 'INVALID_REFERENCE' });
    expect(await balances()).toEqual([expect.objectContaining({ tailVehicleId: f.ids.m1, plate: '80-3001', balance: 7 })]);
    const first = (await app.db.collection(C.palletMovements).findOne({ clientEventId: id }))!;
    expect(first.tailVehicleId.toHexString()).toBe(f.ids.m1); // rigid mixer: no tail, so the head vehicle carries the pallets
    expect(first.stopId.toHexString()).toBe(shipment.stops[0].stopId);
    expect(first.locationId).toBeInstanceOf(ObjectId);
    expect(first.flags).toEqual([]); // tapped inside plant A's geofence
  });

  it('serialises concurrent movements on the same vehicle', async () => {
    const before = (await balances())[0].balance;
    const results = await Promise.all(Array.from({ length: 5 }, () => send([move('RETURN_IN', 2)])));
    const afters = results.map((r) => ok(r).results[0].balanceAfter).sort((a: number, b: number) => a - b);
    expect(afters).toEqual([before + 2, before + 4, before + 6, before + 8, before + 10]);
  });

  it('lets an admin correct the balance with one audit entry, and lets drivers read only their own movements', async () => {
    const correction = { tailVehicleId: f.ids.m1, typeCode: 'DEPOSIT', qty: 1, remark: 'นับสต็อกจริง' };
    expect((await app.inject({ method: 'POST', url: '/api/v1/pallet-movements', headers: f.planner, payload: correction })).statusCode).toBe(403);
    const res = ok(await app.inject({ method: 'POST', url: '/api/v1/pallet-movements', headers: f.admin, payload: correction }), 201);
    expect(res).toMatchObject({ source: 'admin', remark: 'นับสต็อกจริง', driverId: null });
    expect(await app.db.collection(C.auditLog).countDocuments({ entity: 'palletMovement', entityId: res.id })).toBe(1);
    const all = ok(await app.inject({ method: 'GET', url: `/api/v1/pallet-movements?tailVehicleId=${f.ids.m1}`, headers: f.viewer }));
    expect(all.items).toHaveLength(8); // 2 + 5 driver movements + 1 correction
    const mine = ok(await app.inject({ method: 'GET', url: '/api/v1/pallet-movements', headers: f.driver1 }));
    expect(mine.items).toHaveLength(7);
    expect(mine.items.every((m: { driverId: string }) => m.driverId === f.ids.d1)).toBe(true);
    expect(ok(await app.inject({ method: 'GET', url: `/api/v1/pallet-movements?driverId=${f.ids.d1}`, headers: f.driver2 })).items).toEqual([]);
  });
});
