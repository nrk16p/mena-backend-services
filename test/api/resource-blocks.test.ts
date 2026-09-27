import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { findActiveBlocks } from '../../src/modules/availability/blocks.service.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

describe('resource blocks', () => {
  let app: App;
  let f: PlanningFixtures;
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: f.planner, payload });

  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('creates a vehicle PM block carrying both status levels', async () => {
    const res = await post('/resource-blocks', {
      resourceType: 'vehicle', resourceId: f.ids.h2, statusCode: 'PM',
      from: '2026-10-06T08:00:00+07:00', to: '2026-10-07T17:00:00+07:00', note: 'PM 50,000 km',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ statusCode: 'PM', level1: 'not_working', blocksAssignment: true, cancelledAt: null, warnings: [] });
  });

  it('rejects codes for the wrong resource type, bad ranges and deactivated resources', async () => {
    const leaveOnTruck = await post('/resource-blocks', { resourceType: 'vehicle', resourceId: f.ids.h1, statusCode: 'LEAVE', from: '2026-10-06T00:00:00+07:00', to: '2026-10-07T00:00:00+07:00' });
    expect(leaveOnTruck.json().code).toBe('STATUS_CODE_NOT_APPLICABLE');
    const backwards = await post('/resource-blocks', { resourceType: 'driver', resourceId: f.ids.d1, statusCode: 'LEAVE', from: '2026-10-07T00:00:00+07:00', to: '2026-10-06T00:00:00+07:00' });
    expect(backwards.json().code).toBe('INVALID_RANGE');
    const spare = await app.inject({ method: 'POST', url: '/api/v1/drivers', headers: f.admin, payload: { code: 'DX', name: 'x' } });
    await app.inject({ method: 'PATCH', url: `/api/v1/drivers/${spare.json().id}`, headers: f.admin, payload: { active: false } });
    const inactive = await post('/resource-blocks', { resourceType: 'driver', resourceId: spare.json().id, statusCode: 'LEAVE', from: '2026-10-06T00:00:00+07:00', to: '2026-10-07T00:00:00+07:00' });
    expect(inactive.json().code).toBe('INACTIVE_REFERENCE');
  });

  it('warns about shipments already using the resource in that period', async () => {
    const sh = await app.db.collection(C.shipments).insertOne({
      shipmentNo: 'SH-TEST-1', status: 'PLANNED', version: 1,
      plannedStart: new Date('2026-10-10T01:00:00Z'), plannedEnd: new Date('2026-10-10T09:00:00Z'),
      head: { vehicleId: new ObjectId(f.ids.h1), driverId: new ObjectId(f.ids.d1) }, tail: null,
    });
    const res = await post('/resource-blocks', { resourceType: 'driver', resourceId: f.ids.d1, statusCode: 'SICK', from: '2026-10-10T00:00:00+07:00', to: '2026-10-11T00:00:00+07:00' });
    expect(res.statusCode).toBe(201);
    expect(res.json().warnings).toEqual([
      expect.objectContaining({ code: 'SHIPMENT_CONFLICT', details: expect.objectContaining({ shipmentNo: 'SH-TEST-1', shipmentId: sh.insertedId.toHexString() }) }),
    ]);
  });

  it('extends, lists and cancels blocks; cancelled blocks stop counting', async () => {
    const created = (await post('/resource-blocks', { resourceType: 'vehicle', resourceId: f.ids.t2, statusCode: 'REPAIR', from: '2026-10-12T08:00:00+07:00', to: '2026-10-13T08:00:00+07:00' })).json();
    const extended = await app.inject({ method: 'PATCH', url: `/api/v1/resource-blocks/${created.id}`, headers: f.planner, payload: { to: '2026-10-15T08:00:00+07:00' } });
    expect(extended.json().to).toBe('2026-10-15T01:00:00.000Z');
    const list = await app.inject({ method: 'GET', url: `/api/v1/resource-blocks?resourceType=vehicle&resourceId=${f.ids.t2}`, headers: f.viewer });
    expect(list.json().items).toHaveLength(1);
    const range = [new Date('2026-10-14T00:00:00Z'), new Date('2026-10-14T05:00:00Z')] as const;
    expect(await findActiveBlocks(app.db, [{ type: 'vehicle', id: new ObjectId(f.ids.t2) }], ...range)).toHaveLength(1);
    const cancelled = await app.inject({ method: 'POST', url: `/api/v1/resource-blocks/${created.id}/cancel`, headers: f.planner });
    expect(cancelled.json().cancelledAt).not.toBeNull();
    expect(await findActiveBlocks(app.db, [{ type: 'vehicle', id: new ObjectId(f.ids.t2) }], ...range)).toHaveLength(0);
    const again = await app.inject({ method: 'PATCH', url: `/api/v1/resource-blocks/${created.id}`, headers: f.planner, payload: { note: 'x' } });
    expect(again.json().code).toBe('BLOCK_CANCELLED');
  });
});
