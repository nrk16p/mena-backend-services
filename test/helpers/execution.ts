import { createHash, randomUUID } from 'node:crypto';
import type { App } from '../../src/app.js';
import type { MemoryStorage } from '../../src/modules/storage/storage.js';
import { ok } from './http.js';
import { type PlanningFixtures, createDo, postShipment } from './planning.js';

type H = { authorization: string };
const post = (app: App, url: string, h: H, payload: object) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });

export const at = (hhmm: string, day = '2026-10-05') => `${day}T${hhmm}:00+07:00`;
export const gps = (lat = 14.53, lng = 100.91, time = at('08:00')) => ({ lat, lng, accuracyM: 8, deviceTime: time });

export async function acceptedShipment(app: App, f: PlanningFixtures, opts: { doOverrides?: object[]; day?: string } = {}) {
  const day = opts.day ?? '2026-10-05';
  const dos = [];
  for (const o of opts.doOverrides ?? [{}]) dos.push(await createDo(app, f, o));
  const created = ok(await postShipment(app, f, { plannedStart: `${day}T06:00:00+07:00`, plannedEnd: `${day}T18:00:00+07:00`, head: { vehicleId: f.ids.m1, driverId: f.ids.d1 }, doIds: dos.map((d) => d.id) }), 201);
  const planned = ok(await post(app, `/shipments/${created.id}/plan`, f.planner, { version: 1 }));
  const dispatched = ok(await post(app, `/shipments/${created.id}/dispatch`, f.planner, { version: planned.version }));
  const shipment = ok(await post(app, `/driver/shipments/${created.id}/accept`, f.driver1, { version: dispatched.version }));
  return { shipment, dos };
}

export async function tap(
  app: App,
  f: PlanningFixtures,
  shipment: { id: string; stops: { stopId: string }[] },
  stopIndex: number | null,
  code: string,
  extra: object = {},
) {
  const res = await post(app, '/driver/events', f.driver1, {
    events: [{ clientEventId: randomUUID(), shipmentId: shipment.id, stopId: stopIndex === null ? null : shipment.stops[stopIndex]!.stopId, code, ...gps(), ...extra }],
  });
  return ok(res).results[0] as { status: string; code?: string; flags: string[]; eventId: string | null };
}

/** A valid 1×1 grayscale JPEG (159 bytes). */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAABv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8ASP/Z',
  'base64',
);

/** A decodable JPEG made unique by a COM segment right after the JFIF header, so every upload has its own SHA-256. */
export function tinyJpeg(tag: string = randomUUID()): Buffer {
  const text = Buffer.from(tag);
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, (text.length + 2) >> 8, (text.length + 2) & 0xff]), text]);
  return Buffer.concat([TINY_JPEG.subarray(0, 20), com, TINY_JPEG.subarray(20)]);
}

export async function uploadPhoto(app: App, f: PlanningFixtures, shipmentId: string, doId: string, body: Buffer = tinyJpeg()) {
  const { key } = ok<{ key: string }>(
    await app.inject({ method: 'POST', url: '/api/v1/uploads/presign', headers: f.driver1, payload: { shipmentId, doId, contentType: 'image/jpeg' } }),
  );
  await (app.storage as MemoryStorage).put(key, body, 'image/jpeg');
  return { key, sha256: createHash('sha256').update(body).digest('hex'), mime: 'image/jpeg', bytes: body.length };
}

export async function deliveredPod(app: App, f: PlanningFixtures, shipment: { id: string }, d: { id: string }, extra: object = {}) {
  const photo = await uploadPhoto(app, f, shipment.id, d.id);
  const sign = await uploadPhoto(app, f, shipment.id, d.id, tinyJpeg('signature'));
  return app.inject({
    method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1,
    payload: {
      clientPodId: randomUUID(), doId: d.id, outcome: 'DELIVERED',
      answers: { receiverName: 'คุณสมศรี' },
      files: [{ fieldKey: 'goodsPhoto', ...photo }, { fieldKey: 'receiverSign', ...sign }],
      ...gps(13.75, 100.5, at('11:00')), device: 'test-phone', appVersion: '1.0.0', offline: false,
      ...extra,
    },
  });
}

export async function toDropStop(app: App, f: PlanningFixtures, shipment: { id: string; stops: { stopId: string }[] }) {
  for (const code of ['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED']) await tap(app, f, shipment, 0, code);
  await tap(app, f, shipment, 1, 'ARRIVED', gps(13.75, 100.5, at('10:00')));
  await tap(app, f, shipment, 1, 'UNLOAD_START', gps(13.75, 100.5, at('10:10')));
  await tap(app, f, shipment, 1, 'UNLOAD_END', gps(13.75, 100.5, at('10:40')));
}
