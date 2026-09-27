import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { ok } from '../helpers/http.js';
import { type PlanningFixtures, createDo, postShipment, setupPlanning } from '../helpers/planning.js';

describe('driver job list', () => {
  let app: App;
  let f: PlanningFixtures;
  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('keeps the active job listed behind a backlog of unclosed COMPLETED shipments, plus any with a rejected POD', async () => {
    const o = await createDo(app, f);
    const created = ok(
      await postShipment(app, f, { plannedStart: '2026-10-05T06:00:00+07:00', plannedEnd: '2026-10-05T18:00:00+07:00', head: { vehicleId: f.ids.m1, driverId: f.ids.d1 }, doIds: [o.id] }),
      201,
    );
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: f.planner, payload });
    const planned = ok(await post(`/shipments/${created.id}/plan`, { version: 1 }));
    const dispatched = ok(await post(`/shipments/${created.id}/dispatch`, { version: planned.version }));
    expect(dispatched.status).toBe('DISPATCHED');

    // A backlog of 60 COMPLETED-but-unclosed shipments for the same driver, all planned before today's job.
    const template = (await app.db.collection(C.shipments).findOne({ _id: new ObjectId(created.id) }))!;
    const backlog = Array.from({ length: 60 }, (_, i) => ({
      ...template,
      _id: new ObjectId(),
      shipmentNo: `SH-BACKLOG-${String(i).padStart(3, '0')}`,
      status: 'COMPLETED',
      plannedStart: new Date(Date.UTC(2026, 8, 1, 0, i)),
      plannedEnd: new Date(Date.UTC(2026, 8, 1, 12, i)),
    }));
    // The oldest one has a rejected POD: the driver must still see it to resubmit.
    const rejectedDo = await createDo(app, f);
    backlog[0] = { ...backlog[0]!, shipmentNo: 'SH-BACKLOG-REJECTED', plannedStart: new Date(Date.UTC(2026, 7, 1)) };
    await app.db.collection(C.shipments).insertMany(backlog);
    await app.db.collection(C.deliveryOrders).updateOne({ _id: new ObjectId(rejectedDo.id) }, { $set: { status: 'POD_REJECTED', shipmentId: backlog[0]!._id } });

    const list = ok(await app.inject({ method: 'GET', url: '/api/v1/driver/shipments', headers: f.driver1 }));
    const nos: string[] = list.items.map((s: { shipmentNo: string }) => s.shipmentNo);
    expect(nos[0]).toBe(created.shipmentNo); // active jobs come first
    expect(nos).toContain('SH-BACKLOG-REJECTED');
    // The 10 most recent COMPLETED ones, not the whole backlog.
    for (let i = 50; i < 60; i++) expect(nos).toContain(`SH-BACKLOG-${String(i).padStart(3, '0')}`);
    expect(nos).not.toContain('SH-BACKLOG-020');
    expect(nos).toHaveLength(12);
  });
});
