import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { acceptedShipment, deliveredPod, toDropStop } from '../helpers/execution.js';
import { ok } from '../helpers/http.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

describe('POD review', () => {
  let app: App;
  let f: PlanningFixtures;
  const post = (url: string, payload: object = {}) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: f.admin, payload });
  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('lists submitted PODs with file links and verifies them', async () => {
    const { shipment, dos } = await acceptedShipment(app, f);
    await toDropStop(app, f, shipment);
    const pod = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    const queue = ok(await app.inject({ method: 'GET', url: '/api/v1/pods?status=submitted', headers: f.viewer }));
    expect(queue.items.map((p: { id: string }) => p.id)).toContain(pod.id);
    const listed = queue.items.find((p: { id: string }) => p.id === pod.id);
    expect(listed).toMatchObject({ doNo: dos[0].doNo, shipmentNo: shipment.shipmentNo, driverName: 'Driver One' });
    const detail = ok(await app.inject({ method: 'GET', url: `/api/v1/pods/${pod.id}`, headers: f.viewer }));
    expect(detail.fileUrls).toHaveLength(2);
    expect(detail).toMatchObject({ doNo: dos[0].doNo, shipmentNo: shipment.shipmentNo, driverName: 'Driver One' });
    expect((await app.inject({ method: 'POST', url: `/api/v1/pods/${pod.id}/verify`, headers: f.viewer })).statusCode).toBe(403);
    const verified = await post(`/pods/${pod.id}/verify`);
    expect(verified.json()).toMatchObject({ status: 'verified', review: { reason: null } });
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo })).toMatchObject({ status: 'POD_VERIFIED' });
    expect((await post(`/pods/${pod.id}/reject`, { reason: 'late' })).json().code).toBe('POD_ALREADY_REVIEWED');
    expect(await app.db.collection(C.auditLog).countDocuments({ entity: 'pod', entityId: pod.id })).toBe(1);
  });

  it('rejects a POD, accepts the resubmission as its successor', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-06' });
    await toDropStop(app, f, shipment);
    const first = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    const rejected = ok(await post(`/pods/${first.id}/reject`, { reason: 'รูปไม่ชัด' }));
    expect(rejected).toMatchObject({ status: 'rejected', review: { reason: 'รูปไม่ชัด' } });
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo })).toMatchObject({ status: 'POD_REJECTED' });
    const second = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    expect(second.supersedesPodId).toBe(first.id);
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo })).toMatchObject({ status: 'DELIVERED' });
    expect((await post(`/pods/${first.id}/verify`)).json().code).toBe('POD_ALREADY_REVIEWED');
    expect(ok(await post(`/pods/${second.id}/verify`)).status).toBe('verified');
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo })).toMatchObject({ status: 'POD_VERIFIED' });
    expect(await app.db.collection(C.auditLog).countDocuments({ entity: 'pod', entityId: { $in: [first.id, second.id] } })).toBe(2);
  });

  it('rejects a review from a planner-only reviewer role too (admin or planner, P3-R1)', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-12' });
    await toDropStop(app, f, shipment);
    const pod = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    const res = await app.inject({ method: 'POST', url: `/api/v1/pods/${pod.id}/verify`, headers: f.planner });
    expect(ok(res).status).toBe('verified');
  });

  // P3-R17: the review queue gap — two reviewers acting on the same POD at once. `review()`'s
  // `findOneAndUpdate({ _id, status: 'submitted' }, ...)` inside a transaction is the guard: MongoDB
  // detects the write conflict between the two concurrent transactions on the same document, aborts
  // and retries the loser, and its retry sees the POD already reviewed.
  it('lets exactly one of two concurrent reviewers decide the same POD, whether both verify or one verifies and one rejects', async () => {
    {
      // Race: two reviewers both try to verify.
      const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-20' });
      await toDropStop(app, f, shipment);
      const pod = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
      const [a, b] = await Promise.all([post(`/pods/${pod.id}/verify`), post(`/pods/${pod.id}/verify`)]);
      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses).toEqual([200, 422]);
      const loser = a.statusCode === 200 ? b : a;
      expect(loser.json().code).toBe('POD_ALREADY_REVIEWED');
      expect(await app.db.collection(C.auditLog).countDocuments({ entity: 'pod', entityId: pod.id })).toBe(1);
    }
    {
      // Race: one reviewer verifies while another rejects the same POD.
      const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-21' });
      await toDropStop(app, f, shipment);
      const pod = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
      const [a, b] = await Promise.all([
        post(`/pods/${pod.id}/verify`),
        app.inject({ method: 'POST', url: `/api/v1/pods/${pod.id}/reject`, headers: f.admin, payload: { reason: 'race' } }),
      ]);
      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses).toEqual([200, 422]);
      const loser = a.statusCode === 200 ? b : a;
      expect(loser.json().code).toBe('POD_ALREADY_REVIEWED');
      expect(await app.db.collection(C.auditLog).countDocuments({ entity: 'pod', entityId: pod.id })).toBe(1);
    }
  });
});
