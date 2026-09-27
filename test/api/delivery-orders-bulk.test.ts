import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

describe('bulk delivery orders', () => {
  let app: App;
  let f: PlanningFixtures;
  const item = (o: object = {}) => ({
    clientId: f.ids.scg, serviceTypeId: f.ids.single, materialId: f.ids.bulk, qty: 10,
    originLocationId: f.ids.locA, destLocationId: f.ids.locB, ...o,
  });
  const bulk = (items: object[], dryRun: boolean) =>
    app.inject({ method: 'POST', url: `/api/v1/delivery-orders/bulk?dryRun=${dryRun}`, headers: f.planner, payload: { items } });

  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('dry run reports without writing', async () => {
    const res = await bulk([item(), item({ destLocationId: f.ids.locC })], true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dryRun: true, total: 2, valid: 2, invalid: 0 });
    expect(res.json().results[0]).toMatchObject({ index: 0, ok: true, id: null, doNo: null });
    expect(await app.db.collection(C.deliveryOrders).countDocuments()).toBe(0);
  });

  it('rejects the whole batch when any item is invalid', async () => {
    const res = await bulk([item(), item({ destLocationId: f.ids.locA })], false);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('BULK_HAS_ERRORS');
    expect(res.json().details.results[1].errors[0].code).toBe('SAME_ORIGIN_DEST');
    expect(await app.db.collection(C.deliveryOrders).countDocuments()).toBe(0);
  });

  it('creates all items with sequential numbers and one audit entry', async () => {
    const res = await bulk([item({ clientRef: 'R1' }), item({ clientRef: 'R2' }), item({ clientRef: 'R3' })], false);
    expect(res.statusCode).toBe(200);
    const nos = res.json().results.map((r: { doNo: string }) => r.doNo);
    expect(nos).toHaveLength(3);
    const seq = nos.map((n: string) => Number(n.split('-')[2]));
    expect(seq[1]).toBe(seq[0] + 1);
    expect(seq[2]).toBe(seq[0] + 2);
    expect(await app.db.collection(C.deliveryOrders).countDocuments({ status: 'UNASSIGNED' })).toBe(3);
    const audit = await app.db.collection(C.auditLog).findOne({ entity: 'deliveryOrder', action: 'bulk-create' });
    expect(audit?.after.doNos).toEqual(nos);
  });
});
