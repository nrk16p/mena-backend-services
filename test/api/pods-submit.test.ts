import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { canonicalJson, sha256Hex } from '../../src/lib/canonical.js';
import type { MemoryStorage } from '../../src/modules/storage/storage.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { acceptedShipment, at, deliveredPod, gps, tap, tinyJpeg, toDropStop, uploadPhoto } from '../helpers/execution.js';
import { ok } from '../helpers/http.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

describe('POD submission', () => {
  let app: App;
  let f: PlanningFixtures;
  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('accepts a delivered POD, hashes it per spec §6.3, completes the shipment and still takes the last DEPARTED', async () => {
    const { shipment, dos } = await acceptedShipment(app, f);
    expect((await deliveredPod(app, f, shipment, dos[0])).json().code).toBe('SHIPMENT_NOT_ACTIVE'); // ACCEPTED: the trip has not started
    for (const code of ['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED']) await tap(app, f, shipment, 0, code);
    await tap(app, f, shipment, 1, 'ARRIVED', gps(13.75, 100.5, at('10:00')));
    expect((await deliveredPod(app, f, shipment, dos[0])).json().code).toBe('STEP_REQUIRED'); // UNLOAD_END not recorded yet
    await tap(app, f, shipment, 1, 'UNLOAD_START', gps(13.75, 100.5, at('10:10')));
    await tap(app, f, shipment, 1, 'UNLOAD_END', gps(13.75, 100.5, at('10:40')));
    const pod = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    expect(pod).toMatchObject({ outcome: 'DELIVERED', status: 'submitted', templateId: null, templateVersion: 0, supersedesPodId: null });
    const stored = (await app.db.collection(C.pods).findOne({ _id: new ObjectId(pod.id) }))!;
    const expectedHash = sha256Hex(
      canonicalJson({
        doId: dos[0].id,
        templateId: null,
        templateVersion: 0,
        answers: { receiverName: 'คุณสมศรี' },
        files: [...stored.files].sort((a, b) => (a.key < b.key ? -1 : 1)).map((x: { sha256: string }) => x.sha256),
        evidence: { ...stored.evidence, deviceTime: stored.evidence.deviceTime.toISOString(), receivedAt: stored.evidence.receivedAt.toISOString() },
      }),
    );
    expect(pod.hash).toBe(expectedHash);
    expect(pod.evidence.geofenceDistanceM).toBeLessThan(300);
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo })).toMatchObject({ status: 'DELIVERED' });
    expect(await app.db.collection(C.shipments).findOne({ shipmentNo: shipment.shipmentNo })).toMatchObject({ status: 'COMPLETED' });
    // A COMPLETED shipment still takes the DEPARTED after the last POD (spec §5.3, P3-R4).
    expect((await tap(app, f, shipment, 1, 'DEPARTED', gps(13.75, 100.5, at('11:30')))).status).toBe('accepted');
    const after = await app.db.collection(C.shipments).findOne({ shipmentNo: shipment.shipmentNo });
    expect(after).toMatchObject({ status: 'COMPLETED' });
    expect(after?.stops[1].status).toBe('DONE');
  });

  it('rejects incomplete forms and tampered, foreign, mistyped or missing files', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-06' });
    await toDropStop(app, f, shipment);
    expect((await deliveredPod(app, f, shipment, dos[0], { answers: {} })).json().code).toBe('POD_INVALID');
    const photo = await uploadPhoto(app, f, shipment.id, dos[0].id);
    const sign = await uploadPhoto(app, f, shipment.id, dos[0].id, tinyJpeg('sig'));
    const submit = (files: object[]) =>
      app.inject({
        method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1,
        payload: { clientPodId: randomUUID(), doId: dos[0].id, outcome: 'DELIVERED', answers: { receiverName: 'x' }, files, ...gps(13.75, 100.5, at('11:00', '2026-10-06')) },
      });
    await (app.storage as MemoryStorage).put(photo.key, tinyJpeg('swapped'), 'image/jpeg');
    expect((await submit([{ fieldKey: 'goodsPhoto', ...photo }, { fieldKey: 'receiverSign', ...sign }])).json().code).toBe('FILE_HASH_MISMATCH');
    const foreign = await deliveredPod(app, f, shipment, dos[0], { files: [{ fieldKey: 'goodsPhoto', key: 'pods/other/x.jpg', sha256: 'a'.repeat(64), mime: 'image/jpeg', bytes: 1 }] });
    expect(foreign.json().code).toBe('FILE_KEY_INVALID'); // reference checks run before the form check
    expect((await submit([{ fieldKey: 'goodsPhoto', ...photo, mime: 'application/pdf' }, { fieldKey: 'receiverSign', ...sign }])).json().code).toBe('FILE_TYPE_INVALID');
    const missing = { fieldKey: 'goodsPhoto', key: `pods/${shipment.id}/${dos[0].id}/${randomUUID()}.jpg`, sha256: 'b'.repeat(64), mime: 'image/jpeg', bytes: 10 };
    expect((await submit([missing, { fieldKey: 'receiverSign', ...sign }])).json().code).toBe('FILE_MISSING');
    const doId = (await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo }))!._id;
    expect(await app.db.collection(C.pods).countDocuments({ doId })).toBe(0);
  });

  it('records a failed delivery with a reason and returns the same POD on replay', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-07' });
    for (const code of ['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED']) await tap(app, f, shipment, 0, code);
    await tap(app, f, shipment, 1, 'ARRIVED', gps(13.75, 100.5, at('10:00', '2026-10-07')));
    const payload = { clientPodId: randomUUID(), doId: dos[0].id, outcome: 'FAILED', answers: {}, files: [], ...gps(13.75, 100.5, at('10:05', '2026-10-07')) };
    const noReason = await app.inject({ method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1, payload });
    expect(noReason.json().code).toBe('REASON_REQUIRED');
    const noNote = await app.inject({ method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1, payload: { ...payload, reasonCode: 'OTHER' } });
    expect(noNote.json().code).toBe('NOTE_REQUIRED');
    const failed = ok(await app.inject({ method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1, payload: { ...payload, reasonCode: 'CONSIGNEE_CLOSED' } }), 201);
    const replay = ok(await app.inject({ method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1, payload: { ...payload, reasonCode: 'CONSIGNEE_CLOSED' } }), 200);
    expect(replay.id).toBe(failed.id);
    // Another driver replaying the same clientPodId learns nothing about it.
    expect((await app.inject({ method: 'POST', url: '/api/v1/driver/pods', headers: f.driver2, payload: { ...payload, reasonCode: 'CONSIGNEE_CLOSED' } })).statusCode).toBe(404);
    const d = await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo });
    expect(d).toMatchObject({ status: 'FAILED' });
    expect(d?.attempts).toHaveLength(1);
    const api = ok(await app.inject({ method: 'GET', url: `/api/v1/delivery-orders/${dos[0].id}`, headers: f.viewer }));
    expect(api.attempts).toEqual([expect.objectContaining({ reasonCode: 'CONSIGNEE_CLOSED', podId: failed.id, shipmentId: shipment.id })]);
    expect(await app.db.collection(C.shipments).findOne({ shipmentNo: shipment.shipmentNo })).toMatchObject({ status: 'COMPLETED' });
    // A FAILED DO takes no further POD on this trip.
    expect((await deliveredPod(app, f, shipment, dos[0])).json().code).toBe('DO_NOT_READY');
  });

  it('completes the shipment when the last two PODs arrive at the same moment', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-08', doOverrides: [{}, {}] });
    await toDropStop(app, f, shipment);
    const [a, b] = await Promise.all([deliveredPod(app, f, shipment, dos[0]), deliveredPod(app, f, shipment, dos[1])]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(await app.db.collection(C.shipments).findOne({ shipmentNo: shipment.shipmentNo })).toMatchObject({ status: 'COMPLETED' });
  });

  it('rejects oversized, repeated, mis-sized and oddly named files; another driver cannot submit', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-09' });
    await toDropStop(app, f, shipment);
    const sign = await uploadPhoto(app, f, shipment.id, dos[0].id, tinyJpeg('sig'));
    const submit = (files: object[], headers = f.driver1) =>
      app.inject({
        method: 'POST', url: '/api/v1/driver/pods', headers,
        payload: { clientPodId: randomUUID(), doId: dos[0].id, outcome: 'DELIVERED', answers: { receiverName: 'x' }, files, ...gps(13.75, 100.5, at('11:00', '2026-10-09')) },
      });
    const big = await uploadPhoto(app, f, shipment.id, dos[0].id, Buffer.alloc(app.config.UPLOAD_MAX_BYTES + 1, 1));
    expect((await submit([{ fieldKey: 'goodsPhoto', ...big }, { fieldKey: 'receiverSign', ...sign }])).json().code).toBe('FILE_TOO_LARGE');
    const photo = await uploadPhoto(app, f, shipment.id, dos[0].id);
    expect((await submit([{ fieldKey: 'goodsPhoto', ...photo }, { fieldKey: 'goodsPhoto', ...photo }, { fieldKey: 'receiverSign', ...sign }])).json().code).toBe('FILE_KEY_INVALID');
    expect((await submit([{ fieldKey: 'goodsPhoto', ...photo, key: `pods/${shipment.id}/${dos[0].id}/../x.jpg` }, { fieldKey: 'receiverSign', ...sign }])).json().code).toBe('FILE_KEY_INVALID');
    expect((await submit([{ fieldKey: 'goodsPhoto', ...photo, mime: 'image/png' }, { fieldKey: 'receiverSign', ...sign }])).json().code).toBe('FILE_TYPE_INVALID'); // .jpg key declared as PNG
    expect((await submit([{ fieldKey: 'goodsPhoto', ...photo, bytes: photo.bytes + 1 }, { fieldKey: 'receiverSign', ...sign }])).json().code).toBe('FILE_HASH_MISMATCH');
    expect((await submit([{ fieldKey: 'goodsPhoto', ...photo }, { fieldKey: 'receiverSign', ...sign }], f.driver2)).statusCode).toBe(404);
  });

  it('links a resubmission to the rejected POD it replaces', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-10' });
    await toDropStop(app, f, shipment);
    const first = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    // Task 6 owns review; simulate a rejection directly.
    await app.db.collection(C.pods).updateOne({ _id: new ObjectId(first.id) }, { $set: { status: 'rejected' } });
    await app.db.collection(C.deliveryOrders).updateOne({ doNo: dos[0].doNo }, { $set: { status: 'POD_REJECTED' } });
    const shipmentBefore = (await app.db.collection(C.shipments).findOne({ shipmentNo: shipment.shipmentNo }))!;
    const second = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    expect(second.supersedesPodId).toBe(first.id);
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo })).toMatchObject({ status: 'DELIVERED' });
    const shipmentAfter = (await app.db.collection(C.shipments).findOne({ shipmentNo: shipment.shipmentNo }))!;
    expect(shipmentAfter).toMatchObject({ status: 'COMPLETED', version: shipmentBefore.version + 1 });
  });
});
