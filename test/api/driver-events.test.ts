import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { acceptedShipment, at, gps, tap } from '../helpers/execution.js';
import { ok } from '../helpers/http.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

describe('driver events', () => {
  let app: App;
  let f: PlanningFixtures;
  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('records the pickup sequence, starts the trip and marks DOs picked up', async () => {
    const { shipment, dos } = await acceptedShipment(app, f);
    // Every tap is at plant A with its own, increasing device time so the timeline order is unambiguous.
    const plantA = (hhmm: string) => gps(14.53, 100.91, at(hhmm));
    expect((await tap(app, f, shipment, 0, 'ARRIVED', plantA('08:00'))).status).toBe('accepted');
    const sh1 = await app.db.collection(C.shipments).findOne({ shipmentNo: shipment.shipmentNo });
    expect(sh1).toMatchObject({ status: 'IN_TRANSIT' });
    expect(sh1?.stops[0].status).toBe('ARRIVED');
    expect((await tap(app, f, shipment, 0, 'LOAD_END', plantA('08:05'))).code).toBe('EVENT_OUT_OF_ORDER');
    expect((await tap(app, f, shipment, 0, 'LOAD_START', plantA('08:10'))).status).toBe('accepted');
    expect((await tap(app, f, shipment, 0, 'LOAD_END', plantA('08:40'))).status).toBe('accepted');
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo })).toMatchObject({ status: 'PICKED_UP' });
    expect((await tap(app, f, shipment, 1, 'ARRIVED', plantA('08:45'))).code).toBe('PREVIOUS_STOP_OPEN');
    expect((await tap(app, f, shipment, 0, 'DEPARTED', plantA('08:50'))).status).toBe('accepted');
    expect((await app.db.collection(C.shipments).findOne({ shipmentNo: shipment.shipmentNo }))?.stops[0].status).toBe('DONE');
    const drop = await tap(app, f, shipment, 1, 'ARRIVED', plantA('10:00'));
    expect(drop.status).toBe('accepted');
    expect(drop.flags).toContain('OUTSIDE_GEOFENCE'); // tapped at plant A while stop 1 is site B
    expect((await tap(app, f, shipment, 1, 'UNLOAD_START', plantA('10:10'))).status).toBe('accepted');
    expect((await tap(app, f, shipment, 1, 'UNLOAD_END', plantA('10:40'))).status).toBe('accepted');
    expect((await tap(app, f, shipment, 1, 'DEPARTED', plantA('10:45'))).code).toBe('POD_REQUIRED');
    const timeline = ok(await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}/events`, headers: f.viewer }));
    expect(timeline.items.map((e: { code: string }) => e.code)).toEqual(['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED', 'ARRIVED', 'UNLOAD_START', 'UNLOAD_END']);
  });

  it('stores a replayed batch once and flags late sync', async () => {
    const { shipment } = await acceptedShipment(app, f, { day: '2026-10-06' });
    // Taps recorded offline 7 h before now, so LATE_SYNC (> 6 h) never depends on the calendar date.
    const offline = (minutes: number) => new Date(Date.now() - 7 * 3600_000 + minutes * 60_000).toISOString();
    const events = [
      { clientEventId: randomUUID(), shipmentId: shipment.id, stopId: shipment.stops[0].stopId, code: 'ARRIVED', ...gps(14.53, 100.91, offline(0)) },
      { clientEventId: randomUUID(), shipmentId: shipment.id, stopId: shipment.stops[0].stopId, code: 'LOAD_START', ...gps(14.53, 100.91, offline(10)) },
    ];
    const send = () => app.inject({ method: 'POST', url: '/api/v1/driver/events', headers: f.driver1, payload: { events } });
    const first = ok(await send()).results;
    expect(first.map((r: { status: string }) => r.status)).toEqual(['accepted', 'accepted']);
    expect(first[0].flags).toContain('LATE_SYNC');
    expect(first[1].flags).toContain('LATE_SYNC');
    const again = ok(await send()).results;
    expect(again.map((r: { status: string }) => r.status)).toEqual(['duplicate', 'duplicate']);
    expect(again[0].eventId).toBe(first[0].eventId);
    expect(await app.db.collection(C.events).countDocuments({ clientEventId: { $in: events.map((e) => e.clientEventId) } })).toBe(2);
  });

  it('requires a reason for exceptions and hides other drivers\' shipments', async () => {
    const { shipment } = await acceptedShipment(app, f, { day: '2026-10-07' });
    expect((await tap(app, f, shipment, null, 'EXCEPTION')).code).toBe('REASON_REQUIRED');
    expect((await tap(app, f, shipment, null, 'DELAYED', { reasonCode: 'TRAFFIC' })).status).toBe('accepted');
    const other = await app.inject({
      method: 'POST', url: '/api/v1/driver/events', headers: f.driver2,
      payload: { events: [{ clientEventId: randomUUID(), shipmentId: shipment.id, stopId: null, code: 'DELAYED', ...gps() }] },
    });
    expect(ok(other).results[0]).toMatchObject({ status: 'rejected', code: 'NOT_FOUND' });
  });

  it('stores one ARRIVED when taps for the same stop race (shipment version guard)', async () => {
    const { shipment } = await acceptedShipment(app, f, { day: '2026-10-08' });
    const one = () =>
      app.inject({
        method: 'POST', url: '/api/v1/driver/events', headers: f.driver1,
        payload: { events: [{ clientEventId: randomUUID(), shipmentId: shipment.id, stopId: shipment.stops[0].stopId, code: 'ARRIVED', ...gps(14.53, 100.91, at('07:00', '2026-10-08')) }] },
      });
    const results = (await Promise.all([one(), one(), one()])).map((r) => ok(r).results[0] as { status: string; code?: string });
    expect(results.filter((r) => r.status === 'accepted')).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 'accepted')) expect(['EVENT_ALREADY_RECORDED', 'SHIPMENT_CHANGED']).toContain(r.code);
    expect(await app.db.collection(C.events).countDocuments({ shipmentId: new ObjectId(shipment.id), code: 'ARRIVED' })).toBe(1);
  });

  it('stores one event when the same clientEventId arrives concurrently; the replays are duplicates', async () => {
    const { shipment } = await acceptedShipment(app, f, { day: '2026-10-09' });
    const clientEventId = randomUUID();
    const one = () =>
      app.inject({
        method: 'POST', url: '/api/v1/driver/events', headers: f.driver1,
        payload: { events: [{ clientEventId, shipmentId: shipment.id, stopId: shipment.stops[0].stopId, code: 'ARRIVED', ...gps(14.53, 100.91, at('07:00', '2026-10-09')) }] },
      });
    const results = (await Promise.all([one(), one(), one()])).map((r) => ok(r).results[0] as { status: string; eventId: string | null });
    const accepted = results.filter((r) => r.status === 'accepted');
    expect(accepted).toHaveLength(1);
    const others = results.filter((r) => r.status !== 'accepted');
    expect(others.map((r) => r.status)).toEqual(['duplicate', 'duplicate']);
    for (const r of others) expect(r.eventId).toBe(accepted[0]!.eventId);
    expect(await app.db.collection(C.events).countDocuments({ clientEventId })).toBe(1);
  });

  it('rejects a stop that is not on the shipment', async () => {
    const { shipment } = await acceptedShipment(app, f, { day: '2026-10-10' });
    const stopId = new ObjectId().toHexString();
    const res = ok(await app.inject({
      method: 'POST', url: '/api/v1/driver/events', headers: f.driver1,
      payload: { events: [{ clientEventId: randomUUID(), shipmentId: shipment.id, stopId, code: 'DELAYED', reasonCode: 'TRAFFIC', ...gps() }] },
    }));
    expect(res.results[0]).toMatchObject({ status: 'rejected', code: 'STOP_NOT_FOUND' });
  });

  it('shows the driver their own shipment timeline and hides it from other drivers', async () => {
    const { shipment } = await acceptedShipment(app, f, { day: '2026-10-11' });
    const at11 = (hhmm: string) => gps(14.53, 100.91, at(hhmm, '2026-10-11'));
    expect((await tap(app, f, shipment, 0, 'LOAD_START', at11('08:10'))).code).toBe('EVENT_OUT_OF_ORDER');
    expect((await tap(app, f, shipment, 0, 'ARRIVED', at11('08:00'))).status).toBe('accepted');
    expect((await tap(app, f, shipment, null, 'DELAYED', { reasonCode: 'TRAFFIC', ...at11('07:30') })).status).toBe('accepted');
    const url = `/api/v1/driver/shipments/${shipment.id}/events`;
    const mine = ok(await app.inject({ method: 'GET', url, headers: f.driver1 }));
    expect(mine.items.map((e: { code: string }) => e.code)).toEqual(['DELAYED', 'ARRIVED']);
    expect(mine.items[1]).toMatchObject({ shipmentId: shipment.id, stopId: shipment.stops[0].stopId, source: 'app', flags: [] });
    expect((await app.inject({ method: 'GET', url, headers: f.driver2 })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url, headers: f.viewer })).statusCode).toBe(403);
  });
});
