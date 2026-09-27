import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { type PlanningFixtures, createDo, setupPlanning } from '../helpers/planning.js';

describe('POST /shipments/bulk', () => {
  let app: App;
  let f: PlanningFixtures;
  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('creates repeated mixer round trips and reports conflicts per item', async () => {
    const trip = (h: number, doId: string) => ({
      plannedStart: `2026-10-05T${String(h).padStart(2, '0')}:00:00+07:00`,
      plannedEnd: `2026-10-05T${String(h + 2).padStart(2, '0')}:00:00+07:00`,
      head: { vehicleId: f.ids.m1, driverId: f.ids.d2 },
      doIds: [doId],
    });
    const a = await createDo(app, f);
    const b = await createDo(app, f);
    const res = await app.inject({
      method: 'POST', url: '/api/v1/shipments/bulk', headers: f.planner,
      payload: { items: [trip(6, a.id), trip(8, b.id), trip(10, b.id)] },
    });
    expect(res.statusCode).toBe(200);
    const results = res.json().results;
    expect(results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, false]);
    expect(results[0].shipmentNo).toMatch(/^SH-/);
    expect(results[2].errors.map((e: { code: string }) => e.code)).toContain('DO_IN_OTHER_SHIPMENT');
  });
});
