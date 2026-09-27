import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { type PlanningFixtures, createDo, postShipment, setupPlanning } from '../helpers/planning.js';

describe('delivery orders', () => {
  let app: App;
  let f: PlanningFixtures;
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, headers: { authorization: string }, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, headers, payload });

  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('creates a DO with a server number, material unit and auto-matched job group', async () => {
    const d = await createDo(app, f, { clientRef: 'SO-123', pickupWindow: { from: '2026-10-05T06:00:00+07:00', to: '2026-10-05T10:00:00+07:00' } });
    expect(d.doNo).toMatch(/^DO-\d{4}-\d{5}$/);
    expect(d).toMatchObject({
      status: 'UNASSIGNED', unit: 'ton', jobGroupId: f.ids.bulkGroup, shipmentId: null, clientRef: 'SO-123',
      jobGroupMatch: { status: 'auto', candidates: [f.ids.bulkGroup] }, warnings: [],
      distance: { clientKm: null },
    });
    expect(d.pickupWindow.from).toBe('2026-10-04T23:00:00.000Z');
    const audit = await app.db.collection(C.auditLog).findOne({ entity: 'deliveryOrder', entityId: d.id });
    expect(audit?.action).toBe('create');
  });

  it('warns when no job group matches', async () => {
    const d = await createDo(app, f, { materialId: f.ids.bag, destLocationId: f.ids.locC });
    expect(d.jobGroupMatch.status).toBe('none');
    expect(d.warnings.map((w: { code: string }) => w.code)).toEqual(['JOB_GROUP_NONE']);
  });

  it('accepts a manual job group of the same client only', async () => {
    const other = await call('POST', `/clients/${f.ids.cpac}/job-groups`, f.admin, { code: 'X', name: 'X', criteria: {} });
    const bad = await call('POST', '/delivery-orders', f.planner, {
      clientId: f.ids.scg, serviceTypeId: f.ids.single, materialId: f.ids.bag, qty: 1,
      originLocationId: f.ids.locA, destLocationId: f.ids.locB, jobGroupId: other.json().id,
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('INVALID_JOB_GROUP');
    const manual = await createDo(app, f, { materialId: f.ids.bag, jobGroupId: f.ids.bulkGroup });
    expect(manual.jobGroupMatch).toEqual({ status: 'manual', candidates: [f.ids.bulkGroup] });
    const patched = await call('PATCH', `/delivery-orders/${manual.id}`, f.planner, { qty: 5 });
    expect(patched.json().jobGroupMatch.status).toBe('manual');
    const reverted = await call('PATCH', `/delivery-orders/${manual.id}`, f.planner, { jobGroupId: null });
    expect(reverted.json().jobGroupMatch.status).toBe('none');
  });

  it('rejects same origin/destination and deactivated references', async () => {
    const same = await call('POST', '/delivery-orders', f.planner, {
      clientId: f.ids.scg, serviceTypeId: f.ids.single, materialId: f.ids.bulk, qty: 1,
      originLocationId: f.ids.locA, destLocationId: f.ids.locA,
    });
    expect(same.json().code).toBe('SAME_ORIGIN_DEST');
    const tmp = await call('POST', '/materials', f.admin, { code: 'TMP', name: 'tmp', unit: 'kg' });
    await call('PATCH', `/materials/${tmp.json().id}`, f.admin, { active: false });
    const inactive = await call('POST', '/delivery-orders', f.planner, {
      clientId: f.ids.scg, serviceTypeId: f.ids.single, materialId: tmp.json().id, qty: 1,
      originLocationId: f.ids.locA, destLocationId: f.ids.locB,
    });
    expect(inactive.statusCode).toBe(422);
    expect(inactive.json().code).toBe('INACTIVE_REFERENCE');
  });

  it('lists with filters, cancels unassigned DOs and then refuses edits', async () => {
    const d = await createDo(app, f, { clientId: f.ids.cpac, materialId: f.ids.bag });
    const list = await call('GET', `/delivery-orders?clientId=${f.ids.cpac}&status=UNASSIGNED`, f.viewer);
    expect(list.json().items.map((x: { id: string }) => x.id)).toContain(d.id);
    const cancelled = await call('POST', `/delivery-orders/${d.id}/cancel`, f.planner, { reason: 'ลูกค้ายกเลิก' });
    expect(cancelled.json()).toMatchObject({ status: 'CANCELLED', cancelReason: 'ลูกค้ายกเลิก' });
    const edit = await call('PATCH', `/delivery-orders/${d.id}`, f.planner, { qty: 2 });
    expect(edit.json().code).toBe('DO_NOT_EDITABLE');
    const audit = await app.db.collection(C.auditLog).findOne({ entity: 'deliveryOrder', entityId: d.id, action: 'cancel' });
    expect(audit?.before).toMatchObject({ status: 'UNASSIGNED' });
    expect(audit?.after).toMatchObject({ status: 'CANCELLED', cancelReason: 'ลูกค้ายกเลิก' });
  });

  it('recomputes unit when materialId changes without an explicit unit, but keeps an explicit unit', async () => {
    const d = await createDo(app, f); // BULK → ton
    expect(d.unit).toBe('ton');
    const toBag = await call('PATCH', `/delivery-orders/${d.id}`, f.planner, { materialId: f.ids.bag });
    expect(toBag.json().unit).toBe('bag');
    const explicit = await call('PATCH', `/delivery-orders/${d.id}`, f.planner, { materialId: f.ids.bulk, unit: 'custom' });
    expect(explicit.json().unit).toBe('custom');
  });

  it('re-matches a DO patched while linked to a shipment using the shipment vehicle truck type, not just intendedTruckTypeId (spec §3.4)', async () => {
    // Client SCG (not CPAC, which an earlier test in this file gave a catch-all empty-criteria
    // job group): material 'bag' also keeps this DO clear of the client's other 'bulkGroup'
    // (materialIds: [bulk], siteIds: [locA]).
    const g = await call('POST', `/clients/${f.ids.scg}/job-groups`, f.admin, {
      code: 'MIXER-PATCH', name: 'Mixer only', criteria: { truckTypeIds: [f.ids.mixerType] },
    });
    const d = await createDo(app, f, { materialId: f.ids.bag });
    expect(d.jobGroupMatch.status).toBe('none'); // no truck type known yet (no intendedTruckTypeId, no shipment)
    await postShipment(app, f, {
      plannedStart: '2026-10-16T06:00:00+07:00', plannedEnd: '2026-10-16T18:00:00+07:00',
      head: { vehicleId: f.ids.m1, driverId: f.ids.d2 }, doIds: [d.id],
    });
    const linked = (await call('GET', `/delivery-orders/${d.id}`, f.viewer)).json();
    expect(linked.jobGroupMatch).toEqual({ status: 'auto', candidates: [g.json().id] }); // set by refreshJobGroups on create

    // Patch the DO while it's still linked: the fix must keep deriving the truck type from the
    // shipment's head vehicle (mixerType), not fall back to the DO's own (null) intendedTruckTypeId.
    const patched = await call('PATCH', `/delivery-orders/${d.id}`, f.planner, { qty: 7 });
    expect(patched.json().jobGroupMatch).toEqual({ status: 'auto', candidates: [g.json().id] });
    expect(patched.json().jobGroupId).toBe(g.json().id);
  });

  it('refuses to change client/route on a DO linked to a shipment (DO_LOCKED_BY_SHIPMENT)', async () => {
    const d = await createDo(app, f);
    await postShipment(app, f, { plannedStart: '2026-10-18T06:00:00+07:00', plannedEnd: '2026-10-18T18:00:00+07:00', head: { vehicleId: f.ids.m1, driverId: f.ids.d2 }, doIds: [d.id] });
    const clientChange = await call('PATCH', `/delivery-orders/${d.id}`, f.planner, { clientId: f.ids.cpac });
    expect(clientChange.statusCode).toBe(422);
    expect(clientChange.json()).toMatchObject({ code: 'DO_LOCKED_BY_SHIPMENT', details: { fields: ['clientId'] } });
    const routeChange = await call('PATCH', `/delivery-orders/${d.id}`, f.planner, { destLocationId: f.ids.locC });
    expect(routeChange.json()).toMatchObject({ code: 'DO_LOCKED_BY_SHIPMENT', details: { fields: ['destLocationId'] } });
    // Fields unrelated to client/route are still editable while linked.
    const qtyChange = await call('PATCH', `/delivery-orders/${d.id}`, f.planner, { qty: 5 });
    expect(qtyChange.statusCode).toBe(200);
  });

  it('enforces roles', async () => {
    // Body validation runs before the role guard, so send a valid body to reach the 403.
    const valid = { clientId: f.ids.scg, serviceTypeId: f.ids.single, materialId: f.ids.bulk, qty: 1, originLocationId: f.ids.locA, destLocationId: f.ids.locB };
    expect((await call('POST', '/delivery-orders', f.viewer, valid)).statusCode).toBe(403);
    expect((await call('GET', '/delivery-orders', f.driver1)).statusCode).toBe(403);
  });
});
