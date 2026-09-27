import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { type PlanningFixtures, createDo, setupPlanning } from '../helpers/planning.js';

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
  });

  it('enforces roles', async () => {
    // Body validation runs before the role guard, so send a valid body to reach the 403.
    const valid = { clientId: f.ids.scg, serviceTypeId: f.ids.single, materialId: f.ids.bulk, qty: 1, originLocationId: f.ids.locA, destLocationId: f.ids.locB };
    expect((await call('POST', '/delivery-orders', f.viewer, valid)).statusCode).toBe(403);
    expect((await call('GET', '/delivery-orders', f.driver1)).statusCode).toBe(403);
  });
});
