import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { type PlanningFixtures, createDo, postShipment, setupPlanning } from '../helpers/planning.js';

describe('create and read shipments', () => {
  let app: App;
  let f: PlanningFixtures;
  const day = (d: number, h: number) => `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00+07:00`;
  const rig = () => ({ head: { vehicleId: f.ids.h1, driverId: f.ids.d1 }, tail: { vehicleId: f.ids.t1, driverId: f.ids.d1 } });

  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('creates a DRAFT shipment and moves its DOs out of the pool', async () => {
    const d1 = await createDo(app, f);
    const d2 = await createDo(app, f, { destLocationId: f.ids.locC });
    const res = await postShipment(app, f, { plannedStart: day(5, 6), plannedEnd: day(5, 18), ...rig(), doIds: [d1.id, d2.id] });
    expect(res.statusCode).toBe(201);
    const sh = res.json();
    expect(sh).toMatchObject({ status: 'DRAFT', version: 1 });
    expect(sh.shipmentNo).toMatch(/^SH-\d{4}-\d{5}$/);
    expect(sh.stops.map((s: { locationId: string }) => s.locationId)).toEqual([f.ids.locA, f.ids.locB, f.ids.locC]);
    expect(sh.legs.map((l: { doIds: string[] }) => l.doIds.length)).toEqual([2, 1]);
    const stored = await app.db.collection(C.deliveryOrders).findOne({ doNo: d1.doNo });
    expect(stored).toMatchObject({ status: 'PLANNED' });
    expect(stored?.shipmentId.toHexString()).toBe(sh.id);
    expect(stored?.pickupStopId.toHexString()).toBe(sh.stops[0].stopId);
    expect(stored?.dropStopId.toHexString()).toBe(sh.stops[1].stopId);
    const read = await app.inject({ method: 'GET', url: `/api/v1/shipments/${sh.id}`, headers: f.viewer });
    expect(read.json().deliveryOrders.map((d: { doNo: string }) => d.doNo).sort()).toEqual([d1.doNo, d2.doNo].sort());
    expect(await app.db.collection(C.auditLog).countDocuments({ entity: 'shipment', entityId: sh.id, action: 'create' })).toBe(1);
  });

  it('refuses a DO that is already in another shipment and double-booked vehicles', async () => {
    const d = await createDo(app, f);
    expect((await postShipment(app, f, { plannedStart: day(6, 6), plannedEnd: day(6, 18), ...rig(), doIds: [d.id] })).statusCode).toBe(201);
    const again = await postShipment(app, f, { plannedStart: day(7, 6), plannedEnd: day(7, 18), head: { vehicleId: f.ids.m1, driverId: f.ids.d2 }, doIds: [d.id] });
    expect(again.statusCode).toBe(422);
    expect(again.json().code).toBe('SHIPMENT_INVALID');
    expect(again.json().details.errors.map((e: { code: string }) => e.code)).toContain('DO_IN_OTHER_SHIPMENT');
    const other = await createDo(app, f);
    const clash = await postShipment(app, f, { plannedStart: day(6, 12), plannedEnd: day(6, 20), ...rig(), doIds: [other.id] });
    const clashCodes = clash.json().details.errors.map((e: { code: string }) => e.code);
    expect(clashCodes).toEqual(expect.arrayContaining(['VEHICLE_DOUBLE_BOOKED', 'DRIVER_DOUBLE_BOOKED']));
    const later = await postShipment(app, f, { plannedStart: day(6, 18), plannedEnd: day(6, 22), ...rig(), doIds: [other.id] });
    expect(later.statusCode).toBe(201);
  });

  it('lets exactly one of two simultaneous shipments take the same DO', async () => {
    const d = await createDo(app, f);
    const [a, b] = await Promise.all([
      postShipment(app, f, { plannedStart: day(9, 6), plannedEnd: day(9, 18), head: { vehicleId: f.ids.m1, driverId: f.ids.d2 }, doIds: [d.id] }),
      postShipment(app, f, { plannedStart: day(9, 6), plannedEnd: day(9, 18), head: { vehicleId: f.ids.h2, driverId: f.ids.d3 }, tail: { vehicleId: f.ids.t2, driverId: f.ids.d3 }, doIds: [d.id] }),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses[0]).toBe(201);
    expect([409, 422]).toContain(statuses[1]);
    expect(await app.db.collection(C.shipments).countDocuments({ 'stops.pickupDoIds': (await app.db.collection(C.deliveryOrders).findOne({ doNo: d.doNo }))!._id })).toBe(1);
  });

  it('serializes vehicle/driver booking so only one of two same-vehicle shipments commits', async () => {
    const d1 = await createDo(app, f);
    const d2 = await createDo(app, f);
    const [a, b] = await Promise.all([
      postShipment(app, f, { plannedStart: day(14, 6), plannedEnd: day(14, 18), head: { vehicleId: f.ids.m1, driverId: f.ids.d2 }, doIds: [d1.id] }),
      postShipment(app, f, { plannedStart: day(14, 6), plannedEnd: day(14, 18), head: { vehicleId: f.ids.m1, driverId: f.ids.d3 }, doIds: [d2.id] }),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses[0]).toBe(201);
    expect([409, 422]).toContain(statuses[1]);
    const loser = a.statusCode === 201 ? b : a;
    if (loser.statusCode === 409) {
      expect(loser.json().code).toBe('RESOURCE_TAKEN');
    } else {
      expect(loser.json().code).toBe('SHIPMENT_INVALID');
      expect(loser.json().details.errors.map((e: { code: string }) => e.code)).toContain('VEHICLE_DOUBLE_BOOKED');
    }
    const count = await app.db.collection(C.shipments).countDocuments({
      'head.vehicleId': new ObjectId(f.ids.m1),
      plannedStart: { $lt: new Date(day(14, 18)) },
      plannedEnd: { $gt: new Date(day(14, 6)) },
    });
    expect(count).toBe(1);
    // reserveResources' bookingLock is an internal write-conflict handle, not API surface.
    const vehicle = await app.inject({ method: 'GET', url: `/api/v1/vehicles/${f.ids.m1}`, headers: f.viewer });
    expect(vehicle.json()).not.toHaveProperty('bookingLock');
  });

  it('re-matches job groups with the assigned truck type', async () => {
    const g = await app.inject({
      method: 'POST', url: `/api/v1/clients/${f.ids.cpac}/job-groups`, headers: f.admin,
      payload: { code: 'MIX', name: 'Mixer jobs', criteria: { truckTypeIds: [f.ids.mixerType] } },
    });
    const d = await createDo(app, f, { clientId: f.ids.cpac, materialId: f.ids.bag });
    expect(d.jobGroupMatch.status).toBe('none');
    const sh = await postShipment(app, f, { plannedStart: day(12, 6), plannedEnd: day(12, 18), head: { vehicleId: f.ids.m1, driverId: f.ids.d2 }, doIds: [d.id] });
    expect(sh.statusCode).toBe(201);
    expect(sh.json().warnings.map((w: { code: string }) => w.code)).not.toContain('JOB_GROUP_NONE');
    const stored = await app.db.collection(C.deliveryOrders).findOne({ doNo: d.doNo });
    expect(stored?.jobGroupId.toHexString()).toBe(g.json().id);
  });

  it('lists shipments with filters', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/v1/shipments?vehicleId=${f.ids.h1}&status=DRAFT`, headers: f.viewer });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBeGreaterThanOrEqual(2);
    const byType = await app.inject({ method: 'GET', url: `/api/v1/shipments?truckTypeId=${f.ids.mixerType}`, headers: f.viewer });
    expect(byType.json().items.every((s: { head: { vehicleId: string } }) => s.head.vehicleId === f.ids.m1)).toBe(true);
    const ranged = await app.inject({ method: 'GET', url: `/api/v1/shipments?from=${encodeURIComponent(day(12, 0))}&to=${encodeURIComponent(day(13, 0))}`, headers: f.viewer });
    expect(ranged.json().items).toHaveLength(1);
  });
});
