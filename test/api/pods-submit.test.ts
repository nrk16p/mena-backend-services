import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { canonicalJson, sha256Hex } from '../../src/lib/canonical.js';
import { type PodDoc, podHashOf } from '../../src/modules/pods/pods.service.js';
import type { MemoryStorage } from '../../src/modules/storage/storage.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { acceptedShipment, at, deliveredPod, gps, tap, tinyJpeg, toDropStop, uploadPhoto } from '../helpers/execution.js';
import { ok } from '../helpers/http.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

/** The POD hash recomputed independently of `podHashOf`, per spec §6.3 as amended by P3-R16. */
function expectedPodHash(stored: PodDoc): string {
  const e = stored.evidence;
  return sha256Hex(
    canonicalJson({
      doId: stored.doId.toHexString(),
      templateId: stored.templateId?.toHexString() ?? null,
      templateVersion: stored.templateVersion,
      outcome: stored.outcome,
      reasonCode: stored.reasonCode,
      note: stored.note,
      answers: stored.answers,
      files: [...stored.files].sort((a, b) => (a.key < b.key ? -1 : 1)).map((x) => ({ key: x.key, sha256: x.sha256, fieldKey: x.fieldKey })),
      evidence: {
        deviceTime: e.deviceTime.toISOString(), receivedAt: e.receivedAt.toISOString(), lat: e.lat, lng: e.lng, accuracyM: e.accuracyM,
        noGpsReason: e.noGpsReason, geofenceDistanceM: e.geofenceDistanceM, device: e.device, appVersion: e.appVersion, offline: e.offline,
      },
    }),
  );
}

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
    const stored = (await app.db.collection<PodDoc>(C.pods).findOne({ _id: new ObjectId(pod.id) }))!;
    expect(stored).toMatchObject({ answers: { receiverName: 'คุณสมศรี' }, outcome: 'DELIVERED', reasonCode: null, note: null });
    expect(pod.hash).toBe(expectedPodHash(stored));
    expect(podHashOf(stored)).toBe(stored.hash); // the stored document alone re-verifies
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

  it('reports FILE_* errors with key and field, checking sizes with HEAD before downloading anything', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-12' });
    await toDropStop(app, f, shipment);
    const storage = app.storage as MemoryStorage;
    const sign = await uploadPhoto(app, f, shipment.id, dos[0].id, tinyJpeg('sig'));
    const signRef = { fieldKey: 'receiverSign', ...sign };
    const submit = (files: object[]) =>
      app.inject({
        method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1,
        payload: { clientPodId: randomUUID(), doId: dos[0].id, outcome: 'DELIVERED', answers: { receiverName: 'x' }, files, ...gps(13.75, 100.5, at('11:00', '2026-10-12')) },
      });
    const get = vi.spyOn(storage, 'get');
    const getStream = vi.spyOn(storage, 'getStream');
    try {
      const big = await uploadPhoto(app, f, shipment.id, dos[0].id, Buffer.alloc(app.config.UPLOAD_MAX_BYTES + 1, 1));
      const tooLarge = await submit([signRef, { fieldKey: 'goodsPhoto', ...big }]);
      expect(tooLarge.json()).toMatchObject({ code: 'FILE_TOO_LARGE', details: { key: big.key, fieldKey: 'goodsPhoto' } });
      const missingKey = `pods/${shipment.id}/${dos[0].id}/${randomUUID()}.jpg`;
      const missing = await submit([{ fieldKey: 'goodsPhoto', key: missingKey, sha256: 'b'.repeat(64), mime: 'image/jpeg', bytes: 10 }, signRef]);
      expect(missing.json()).toMatchObject({ code: 'FILE_MISSING', details: { key: missingKey, fieldKey: 'goodsPhoto' } });
      expect(get).not.toHaveBeenCalled();
      expect(getStream).not.toHaveBeenCalled(); // HEAD found both problems; no object was downloaded

      // An object that grew after its HEAD is still capped while streaming.
      const photo = await uploadPhoto(app, f, shipment.id, dos[0].id);
      await storage.put(photo.key, Buffer.alloc(app.config.UPLOAD_MAX_BYTES + 10, 2), 'image/jpeg');
      const head = vi.spyOn(storage, 'head').mockImplementation(async () => ({ bytes: 100 }));
      const grown = await submit([{ fieldKey: 'goodsPhoto', ...photo }, signRef]);
      head.mockRestore();
      expect(grown.json()).toMatchObject({ code: 'FILE_TOO_LARGE', details: { key: photo.key, fieldKey: 'goodsPhoto' } });

      const other = await uploadPhoto(app, f, shipment.id, dos[0].id);
      const mismatch = await submit([{ fieldKey: 'goodsPhoto', ...other, sha256: 'c'.repeat(64) }, signRef]);
      expect(mismatch.json()).toMatchObject({ code: 'FILE_HASH_MISMATCH', details: { key: other.key, fieldKey: 'goodsPhoto' } });
      const badKey = await submit([{ fieldKey: 'goodsPhoto', ...other, key: 'pods/x/y.jpg' }, signRef]);
      expect(badKey.json()).toMatchObject({ code: 'FILE_KEY_INVALID', details: { key: 'pods/x/y.jpg', fieldKey: 'goodsPhoto' } });
      const badType = await submit([{ fieldKey: 'goodsPhoto', ...other, mime: 'image/png' }, signRef]);
      expect(badType.json()).toMatchObject({ code: 'FILE_TYPE_INVALID', details: { key: other.key, fieldKey: 'goodsPhoto' } });
      expect(get).not.toHaveBeenCalled(); // the POD path only ever streams
    } finally {
      get.mockRestore();
      getStream.mockRestore();
    }
  });

  it('rejects answers whose keys start with $ or contain a dot', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-13' });
    await toDropStop(app, f, shipment);
    const res = await deliveredPod(app, f, shipment, dos[0], { answers: { receiverName: 'x', $where: 'sleep(1000)' } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'POD_INVALID', details: { issues: [expect.objectContaining({ code: 'INVALID_KEY' })] } });
  });

  it('refuses the POD when the shipment stops being active before the transaction', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-14' });
    await toDropStop(app, f, shipment);
    const storage = app.storage as MemoryStorage;
    const realHead = storage.head.bind(storage);
    // The shipment is closed while the files are being checked (after the pre-checks, before the transaction).
    const head = vi.spyOn(storage, 'head').mockImplementation(async (key) => {
      await app.db.collection(C.shipments).updateOne({ shipmentNo: shipment.shipmentNo }, { $set: { status: 'CLOSED' } });
      return realHead(key);
    });
    try {
      const res = await deliveredPod(app, f, shipment, dos[0]);
      expect(res.json().code).toBe('SHIPMENT_NOT_ACTIVE');
    } finally {
      head.mockRestore();
    }
    const d = (await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo }))!;
    expect(d.status).toBe('PICKED_UP');
    expect(await app.db.collection(C.pods).countDocuments({ doId: d._id })).toBe(0);
  });

  it('stores one POD when the same submission arrives three times at once', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-15' });
    await toDropStop(app, f, shipment);
    const photo = await uploadPhoto(app, f, shipment.id, dos[0].id);
    const sign = await uploadPhoto(app, f, shipment.id, dos[0].id, tinyJpeg('sig'));
    const payload = {
      clientPodId: randomUUID(), doId: dos[0].id, outcome: 'DELIVERED', answers: { receiverName: 'x' },
      files: [{ fieldKey: 'goodsPhoto', ...photo }, { fieldKey: 'receiverSign', ...sign }], ...gps(13.75, 100.5, at('11:00', '2026-10-15')),
    };
    const send = () => app.inject({ method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1, payload });
    const results = await Promise.all([send(), send(), send()]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 201]);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    const doId = (await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo }))!._id;
    expect(await app.db.collection(C.pods).countDocuments({ doId })).toBe(1);
  });
});

describe('POD submission with a client template', () => {
  let app: App;
  let f: PlanningFixtures;
  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('hashes a template POD with numeric answers, outcome, note and file fields', async () => {
    const tpl = ok(await app.inject({
      method: 'POST', url: '/api/v1/pod-templates', headers: f.planner,
      payload: {
        clientId: f.ids.scg, jobGroupId: f.ids.bulkGroup, name: 'Bulk POD',
        fields: [
          { key: 'ticket', label: 'ตั๋ว', type: 'photo', required: true, max: 2 },
          { key: 'tempC', label: 'อุณหภูมิ', type: 'number', required: true, min: -30, max: 10 },
          { key: 'bags', label: 'ถุง', type: 'number', required: false, min: 0 },
          { key: 'sealOk', label: 'ซีล', type: 'checkbox', required: true },
          { key: 'receiverName', label: 'ชื่อผู้รับ', type: 'text', required: true },
        ],
      },
    }), 201);
    ok(await app.inject({ method: 'POST', url: `/api/v1/pod-templates/${tpl.id}/publish`, headers: f.planner }));
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-20' });
    await toDropStop(app, f, shipment);
    const t1 = await uploadPhoto(app, f, shipment.id, dos[0].id);
    const t2 = await uploadPhoto(app, f, shipment.id, dos[0].id);
    const answers = { tempC: -4.5, bags: 12, sealOk: true, receiverName: 'คุณสมศรี' };
    const base = {
      doId: dos[0].id, outcome: 'DELIVERED', answers, note: 'ส่งครบ',
      files: [{ fieldKey: 'ticket', ...t2 }, { fieldKey: 'ticket', ...t1 }], ...gps(13.75, 100.5, at('11:00', '2026-10-20')), device: 'phone', appVersion: '2.0.0',
    };
    // P3-R14: a required checkbox left unticked blocks the POD.
    const unticked = await app.inject({ method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1, payload: { ...base, clientPodId: randomUUID(), answers: { ...answers, sealOk: false } } });
    expect(unticked.json()).toMatchObject({ code: 'POD_INVALID', details: { issues: [expect.objectContaining({ code: 'FIELD_REQUIRED', details: { field: 'sealOk' } })] } });
    const pod = ok(await app.inject({ method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1, payload: { ...base, clientPodId: randomUUID() } }), 201);
    expect(pod).toMatchObject({ templateId: tpl.id, templateVersion: 1, answers, note: 'ส่งครบ' });
    const stored = (await app.db.collection<PodDoc>(C.pods).findOne({ _id: new ObjectId(pod.id) }))!;
    expect(stored.files.map((x) => x.key)).toEqual([t1.key, t2.key].sort());
    expect(pod.hash).toBe(expectedPodHash(stored));
    expect(podHashOf(stored)).toBe(stored.hash);
    // Every hashed part matters: outcome, reason, note, answers and each file's field.
    expect(podHashOf({ ...stored, outcome: 'FAILED' })).not.toBe(stored.hash);
    expect(podHashOf({ ...stored, reasonCode: 'SHORTAGE' })).not.toBe(stored.hash);
    expect(podHashOf({ ...stored, note: 'ส่งไม่ครบ' })).not.toBe(stored.hash);
    expect(podHashOf({ ...stored, answers: { ...answers, bags: 11 } })).not.toBe(stored.hash);
    expect(podHashOf({ ...stored, files: stored.files.map((x, i) => (i === 0 ? { ...x, fieldKey: 'other' } : x)) })).not.toBe(stored.hash);
    // Extra evidence fields (never part of the formula) do not change it.
    expect(podHashOf({ ...stored, evidence: { ...stored.evidence, extra: 1 } as PodDoc['evidence'] })).toBe(stored.hash);
  });
});

