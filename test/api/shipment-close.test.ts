import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { acceptedShipment, at, deliveredPod, gps, tap, toDropStop } from '../helpers/execution.js';
import { ok } from '../helpers/http.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

describe('close shipment', () => {
  let app: App;
  let f: PlanningFixtures;
  const admin = (url: string, payload: object = {}) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: f.admin, payload });
  const versionOf = async (id: string) => ok(await app.inject({ method: 'GET', url: `/api/v1/shipments/${id}`, headers: f.admin })).version as number;
  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('closes a completed shipment once every POD is verified, releasing failed DOs', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { doOverrides: [{}, { destLocationId: f.ids.locC }] });
    for (const code of ['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED']) await tap(app, f, shipment, 0, code);
    for (const code of ['ARRIVED', 'UNLOAD_START', 'UNLOAD_END']) await tap(app, f, shipment, 1, code, gps(13.75, 100.5, at('10:00')));
    const good = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    await tap(app, f, shipment, 1, 'DEPARTED', gps(13.75, 100.5, at('11:30')));
    await tap(app, f, shipment, 2, 'ARRIVED', gps(16.43, 102.83, at('15:00')));
    const failed = ok(await app.inject({
      method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1,
      payload: { clientPodId: randomUUID(), doId: dos[1].id, outcome: 'FAILED', reasonCode: 'CONSIGNEE_CLOSED', answers: {}, files: [], ...gps(16.43, 102.83, at('15:05')) },
    }), 201);
    const current = ok(await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}`, headers: f.admin }));
    expect(current.status).toBe('COMPLETED');
    const early = await admin(`/shipments/${shipment.id}/close`, { version: current.version });
    expect(early.json()).toMatchObject({ code: 'PODS_NOT_VERIFIED', details: { doNos: [dos[0].doNo, dos[1].doNo].sort() } });
    ok(await admin(`/pods/${good.id}/verify`));
    ok(await admin(`/pods/${failed.id}/verify`));
    const closeAs = async (h: { authorization: string }) =>
      app.inject({ method: 'POST', url: `/api/v1/shipments/${shipment.id}/close`, headers: h, payload: { version: await versionOf(shipment.id) } });
    expect((await closeAs(f.viewer)).statusCode).toBe(403);
    const closed = ok(await closeAs(f.planner)); // admin or planner may close (P3-R1)
    expect(closed).toMatchObject({ status: 'CLOSED', closedBy: expect.any(String) });
    expect(await app.db.collection(C.auditLog).countDocuments({ entity: 'shipment', entityId: shipment.id, action: 'close' })).toBe(1);
    const summary = ok(await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}/summary`, headers: f.viewer }));
    expect(summary.evidence.pods.map((p: { outcome: string }) => p.outcome).sort()).toEqual(['DELIVERED', 'FAILED']);
    expect(summary.evidence.eventCount).toBeGreaterThanOrEqual(8);
    expect(summary.lines).toEqual([]);
    const released = await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[1].doNo });
    expect(released).toMatchObject({ status: 'UNASSIGNED', shipmentId: null });
    expect(released?.attempts).toHaveLength(1);
    expect((await admin(`/shipments/${shipment.id}/close`, { version: closed.version })).json().code).toBe('SHIPMENT_NOT_COMPLETED');
  });

  it('requires a job group on every non-legacy DO', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-08', doOverrides: [{ materialId: f.ids.bag }] });
    for (const code of ['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED']) await tap(app, f, shipment, 0, code);
    for (const code of ['ARRIVED', 'UNLOAD_START', 'UNLOAD_END']) await tap(app, f, shipment, 1, code, gps(13.75, 100.5, at('10:00', '2026-10-08')));
    const pod = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    ok(await admin(`/pods/${pod.id}/verify`));
    const refused = await admin(`/shipments/${shipment.id}/close`, { version: await versionOf(shipment.id) });
    expect(refused.json()).toMatchObject({ code: 'JOB_GROUP_REQUIRED', details: { doNos: [dos[0].doNo] } });
    // Legacy DOs (Plan 4 migration) are exempt from the job-group requirement (spec §3.4).
    await app.db.collection(C.deliveryOrders).updateOne({ doNo: dos[0].doNo }, { $set: { legacy: true } });
    expect(ok(await admin(`/shipments/${shipment.id}/close`, { version: await versionOf(shipment.id) })).status).toBe('CLOSED');
  });

  it('closes only after the resubmitted POD is verified', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-09' });
    await toDropStop(app, f, shipment);
    const first = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    ok(await admin(`/pods/${first.id}/reject`, { reason: 'ลายเซ็นไม่ชัด' }));
    const second = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    expect(second.supersedesPodId).toBe(first.id);
    const refused = await admin(`/shipments/${shipment.id}/close`, { version: await versionOf(shipment.id) });
    expect(refused.json()).toMatchObject({ code: 'PODS_NOT_VERIFIED', details: { doNos: [dos[0].doNo] } });
    ok(await admin(`/pods/${second.id}/verify`));
    expect(ok(await admin(`/shipments/${shipment.id}/close`, { version: await versionOf(shipment.id) })).status).toBe('CLOSED');
    const summary = ok(await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}/summary`, headers: f.viewer }));
    expect(summary.evidence.pods).toEqual([expect.objectContaining({ podId: second.id, hash: second.hash, outcome: 'DELIVERED' })]);
  });

  it('keeps taking driver events on a COMPLETED shipment, and close needs the refetched version', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-12' });
    await toDropStop(app, f, shipment);
    const pod = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    const completed = ok(await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}`, headers: f.admin }));
    expect(completed.status).toBe('COMPLETED');
    expect((await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}/summary`, headers: f.viewer })).statusCode).toBe(404);
    // The last DEPARTED arrives after the last POD (P3-R4): accepted, the shipment stays COMPLETED, the version moves on.
    expect((await tap(app, f, shipment, 1, 'DEPARTED', gps(13.75, 100.5, at('11:30', '2026-10-12')))).status).toBe('accepted');
    ok(await admin(`/pods/${pod.id}/verify`));
    const after = ok(await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}`, headers: f.admin }));
    expect(after.status).toBe('COMPLETED');
    expect(after.version).toBeGreaterThan(completed.version);
    const stale = await admin(`/shipments/${shipment.id}/close`, { version: completed.version });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('VERSION_CONFLICT');
    const closed = ok(await admin(`/shipments/${shipment.id}/close`, { version: await versionOf(shipment.id) }));
    expect(closed).toMatchObject({ status: 'CLOSED', version: after.version + 1, summaryId: expect.any(String) });
    // The summary snapshots each POD's file list (Task 9 re-hashes the files against it).
    const summary = ok(await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}/summary`, headers: f.viewer }));
    expect(summary).toMatchObject({ id: closed.summaryId, shipmentId: shipment.id, shipmentNo: closed.shipmentNo, pdfKey: null, adjustments: [] });
    expect(summary.evidence.pods[0].files.map((x: { fieldKey: string }) => x.fieldKey).sort()).toEqual(['goodsPhoto', 'receiverSign']);
    expect(summary.evidence.pods[0].files[0]).toEqual({ fieldKey: expect.any(String), key: expect.any(String), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(summary.evidence.distances.legs).toHaveLength(1);
    // Closed means locked: no more driver events.
    expect((await tap(app, f, shipment, 1, 'DEPARTED', gps(13.75, 100.5, at('11:40', '2026-10-12')))).code).toBe('SHIPMENT_NOT_ACTIVE');
  });
});
