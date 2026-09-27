import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { type PlanningFixtures, codes, createDo, setupPlanning, validate } from '../helpers/planning.js';

describe('POST /shipments/validate', () => {
  let app: App;
  let f: PlanningFixtures;
  const window = { plannedStart: '2026-10-05T06:00:00+07:00', plannedEnd: '2026-10-05T18:00:00+07:00' };

  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('accepts a complete tractor + trailer plan built from DO ids', async () => {
    const d = await createDo(app, f);
    const out = await validate(app, f, { ...window, head: { vehicleId: f.ids.h1, driverId: f.ids.d1 }, tail: { vehicleId: f.ids.t1, driverId: f.ids.d1 }, doIds: [d.id] });
    expect(out.errors).toEqual([]);
    expect(out.stops).toHaveLength(2);
    expect(out.legs).toEqual([expect.objectContaining({ doIds: [d.id], loaded: true })]);
  });

  it('treats missing pieces as errors when planned and warnings when draft', async () => {
    const d = await createDo(app, f);
    const body = { ...window, head: { vehicleId: f.ids.h1, driverId: f.ids.d1 }, doIds: [d.id] };
    expect(codes((await validate(app, f, body)).errors)).toEqual(['TAIL_REQUIRED']);
    const draft = await validate(app, f, { ...body, mode: 'draft' });
    expect(draft.errors).toEqual([]);
    expect(codes(draft.warnings)).toContain('TAIL_REQUIRED');
    const empty = await validate(app, f, { ...window, mode: 'draft' });
    expect(codes(empty.warnings)).toEqual(['DOS_REQUIRED', 'HEAD_REQUIRED', 'STOPS_REQUIRED']);
  });

  it('checks vehicle slots', async () => {
    const d = await createDo(app, f);
    const rigidWithTail = await validate(app, f, { ...window, head: { vehicleId: f.ids.m1, driverId: f.ids.d1 }, tail: { vehicleId: f.ids.t1, driverId: f.ids.d1 }, doIds: [d.id] });
    expect(codes(rigidWithTail.errors)).toEqual(['RIGID_WITH_TAIL']);
    const tailInHead = await validate(app, f, { ...window, head: { vehicleId: f.ids.t1, driverId: f.ids.d1 }, doIds: [d.id], mode: 'draft' });
    expect(codes(tailInHead.errors)).toEqual(['VEHICLE_WRONG_SLOT']);
    const mixer = await validate(app, f, { ...window, head: { vehicleId: f.ids.m1, driverId: f.ids.d2 }, doIds: [d.id] });
    expect(mixer.errors).toEqual([]);
  });

  it('flags a drop before its pickup in explicit stops', async () => {
    const d = await createDo(app, f);
    const out = await validate(app, f, {
      ...window, head: { vehicleId: f.ids.m1, driverId: f.ids.d1 },
      stops: [
        { locationId: f.ids.locB, dropDoIds: [d.id] },
        { locationId: f.ids.locA, pickupDoIds: [d.id] },
      ],
    });
    expect(codes(out.errors)).toEqual(['DROP_BEFORE_PICKUP']);
  });

  it('warns about driver mismatch, licence expiry, day off and holidays', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/holidays', headers: f.planner, payload: { date: '2026-10-04', name: 'ทดสอบ' } });
    const d = await createDo(app, f);
    // Sat 3 Oct 22:00 → Sun 4 Oct 04:00 Bangkok: D3 is off on Sundays, licence expired 1 Oct, 4 Oct is a holiday.
    const out = await validate(app, f, {
      plannedStart: '2026-10-03T22:00:00+07:00', plannedEnd: '2026-10-04T04:00:00+07:00',
      head: { vehicleId: f.ids.h2, driverId: f.ids.d3 }, tail: { vehicleId: f.ids.t2, driverId: f.ids.d2 }, doIds: [d.id],
    });
    expect(out.errors).toEqual([]);
    expect(codes(out.warnings)).toEqual(['COMPANY_HOLIDAY', 'DRIVER_DAY_OFF', 'DRIVER_MISMATCH', 'LICENSE_EXPIRES']);
  });

  it('blocks resources with a blocking status and warns for OTHER', async () => {
    const d = await createDo(app, f);
    await app.inject({ method: 'POST', url: '/api/v1/resource-blocks', headers: f.planner, payload: { resourceType: 'vehicle', resourceId: f.ids.h2, statusCode: 'PM', from: '2026-10-08T00:00:00+07:00', to: '2026-10-09T00:00:00+07:00' } });
    await app.inject({ method: 'POST', url: '/api/v1/resource-blocks', headers: f.planner, payload: { resourceType: 'driver', resourceId: f.ids.d2, statusCode: 'OTHER', from: '2026-10-08T00:00:00+07:00', to: '2026-10-09T00:00:00+07:00' } });
    const out = await validate(app, f, {
      plannedStart: '2026-10-08T08:00:00+07:00', plannedEnd: '2026-10-08T12:00:00+07:00',
      head: { vehicleId: f.ids.h2, driverId: f.ids.d2 }, tail: { vehicleId: f.ids.t2, driverId: f.ids.d2 }, doIds: [d.id],
    });
    expect(codes(out.errors)).toEqual(['RESOURCE_BLOCKED']);
    expect(codes(out.warnings)).toEqual(['RESOURCE_BLOCK_OTHER']);
  });

  it('rejects deactivated vehicles', async () => {
    const spare = await app.inject({ method: 'POST', url: '/api/v1/vehicles', headers: f.admin, payload: { plate: '80-9999', part: 'rigid', truckTypeId: f.ids.mixerType } });
    await app.inject({ method: 'PATCH', url: `/api/v1/vehicles/${spare.json().id}`, headers: f.admin, payload: { active: false } });
    const d = await createDo(app, f);
    const out = await validate(app, f, { ...window, head: { vehicleId: spare.json().id, driverId: f.ids.d1 }, doIds: [d.id] });
    expect(codes(out.errors)).toEqual(['INACTIVE_REFERENCE']);
  });

  it('rejects a bad time range', async () => {
    const out = await validate(app, f, { plannedStart: '2026-10-05T18:00:00+07:00', plannedEnd: '2026-10-05T06:00:00+07:00', mode: 'draft' });
    expect(codes(out.errors)).toEqual(['INVALID_RANGE']);
  });
});
