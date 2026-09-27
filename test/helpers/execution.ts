import { randomUUID } from 'node:crypto';
import type { App } from '../../src/app.js';
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
