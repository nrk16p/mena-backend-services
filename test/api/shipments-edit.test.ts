import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { type PlanningFixtures, createDo, postShipment, setupPlanning } from '../helpers/planning.js';

describe('edit, plan and cancel shipments', () => {
  let app: App;
  let f: PlanningFixtures;
  const day = (d: number, h: number) => `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00+07:00`;
  const patch = (id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/v1/shipments/${id}`, headers: f.planner, payload });
  const action = (id: string, name: string, payload: object) => app.inject({ method: 'POST', url: `/api/v1/shipments/${id}/${name}`, headers: f.planner, payload });

  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('rejects a stale version and removes DOs from the shipment', async () => {
    const a = await createDo(app, f);
    const b = await createDo(app, f, { destLocationId: f.ids.locC });
    const sh = (await postShipment(app, f, { plannedStart: day(5, 6), plannedEnd: day(5, 18), head: { vehicleId: f.ids.m1, driverId: f.ids.d1 }, doIds: [a.id, b.id] })).json();
    const edited = await patch(sh.id, { version: 1, doIds: [a.id] });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ version: 2, status: 'DRAFT' });
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: b.doNo })).toMatchObject({ status: 'UNASSIGNED', shipmentId: null });
    const stale = await patch(sh.id, { version: 1, note: 'from another tab' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('VERSION_CONFLICT');
  });

  it('requires completeness to plan, then keeps edits in PLANNED', async () => {
    const d = await createDo(app, f);
    const sh = (await postShipment(app, f, { plannedStart: day(6, 6), plannedEnd: day(6, 18), head: { vehicleId: f.ids.h1, driverId: null }, doIds: [d.id] })).json();
    const early = await action(sh.id, 'plan', { version: 1 });
    expect(early.statusCode).toBe(422);
    expect(early.json().details.errors.map((e: { code: string }) => e.code).sort()).toEqual(['HEAD_DRIVER_REQUIRED', 'TAIL_REQUIRED']);
    const fixed = await patch(sh.id, { version: 1, head: { vehicleId: f.ids.h1, driverId: f.ids.d1 }, tail: { vehicleId: f.ids.t1, driverId: f.ids.d1 } });
    const planned = await action(sh.id, 'plan', { version: fixed.json().version });
    expect(planned.json()).toMatchObject({ status: 'PLANNED', version: 3 });
    const moved = await patch(sh.id, { version: 3, plannedEnd: day(6, 20) });
    expect(moved.json()).toMatchObject({ status: 'PLANNED', version: 4 });
    const broken = await patch(sh.id, { version: 4, tail: null });
    expect(broken.json().details.errors.map((e: { code: string }) => e.code)).toEqual(['TAIL_REQUIRED']);
  });

  it('refuses edits that would double-book', async () => {
    const d1 = await createDo(app, f);
    const d2 = await createDo(app, f);
    await postShipment(app, f, { plannedStart: day(8, 6), plannedEnd: day(8, 18), head: { vehicleId: f.ids.m1, driverId: f.ids.d2 }, doIds: [d1.id] });
    const sh = (await postShipment(app, f, { plannedStart: day(8, 6), plannedEnd: day(8, 18), head: { vehicleId: f.ids.h2, driverId: f.ids.d3 }, tail: { vehicleId: f.ids.t2, driverId: f.ids.d3 }, doIds: [d2.id] })).json();
    const clash = await patch(sh.id, { version: 1, head: { vehicleId: f.ids.m1, driverId: f.ids.d3 }, tail: null });
    expect(clash.json().details.errors.map((e: { code: string }) => e.code)).toContain('VEHICLE_DOUBLE_BOOKED');
  });

  it('cancels a shipment, releases its DOs and then refuses edits', async () => {
    const d = await createDo(app, f);
    const sh = (await postShipment(app, f, { plannedStart: day(10, 6), plannedEnd: day(10, 18), head: { vehicleId: f.ids.m1, driverId: f.ids.d1 }, doIds: [d.id] })).json();
    const cancelled = await action(sh.id, 'cancel', { version: 1, reason: 'ลูกค้าเลื่อน' });
    expect(cancelled.json()).toMatchObject({ status: 'CANCELLED', cancelReason: 'ลูกค้าเลื่อน', version: 2 });
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: d.doNo })).toMatchObject({ status: 'UNASSIGNED', shipmentId: null });
    const edit = await patch(sh.id, { version: 2, note: 'x' });
    expect(edit.json().code).toBe('SHIPMENT_NOT_EDITABLE');
    expect(await app.db.collection(C.auditLog).countDocuments({ entity: 'shipment', entityId: sh.id, action: 'cancel' })).toBe(1);
  });

  it('serializes concurrent edits that both move onto the same vehicle/window (Ruling P2-R6)', async () => {
    const d1 = await createDo(app, f);
    const d2 = await createDo(app, f);
    const sh1 = (
      await postShipment(app, f, { plannedStart: day(20, 6), plannedEnd: day(20, 18), head: { vehicleId: f.ids.h1, driverId: f.ids.d1 }, tail: { vehicleId: f.ids.t1, driverId: f.ids.d1 }, doIds: [d1.id] })
    ).json();
    const sh2 = (
      await postShipment(app, f, { plannedStart: day(20, 6), plannedEnd: day(20, 18), head: { vehicleId: f.ids.h2, driverId: f.ids.d2 }, tail: { vehicleId: f.ids.t2, driverId: f.ids.d2 }, doIds: [d2.id] })
    ).json();
    const [a, b] = await Promise.all([
      patch(sh1.id, { version: 1, head: { vehicleId: f.ids.m1, driverId: f.ids.d1 }, tail: null }),
      patch(sh2.id, { version: 1, head: { vehicleId: f.ids.m1, driverId: f.ids.d2 }, tail: null }),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses[0]).toBe(200);
    expect([409, 422]).toContain(statuses[1]);
    const loser = a.statusCode === 200 ? b : a;
    if (loser.statusCode === 409) {
      expect(loser.json().code).toBe('RESOURCE_TAKEN');
    } else {
      expect(loser.json().code).toBe('SHIPMENT_INVALID');
      expect(loser.json().details.errors.map((e: { code: string }) => e.code)).toContain('VEHICLE_DOUBLE_BOOKED');
    }
    const count = await app.db.collection(C.shipments).countDocuments({
      'head.vehicleId': (await app.db.collection(C.vehicles).findOne({ plate: '80-3001' }))!._id,
      plannedStart: { $lt: new Date(day(20, 18)) },
      plannedEnd: { $gt: new Date(day(20, 6)) },
    });
    expect(count).toBe(1);
  });
});
