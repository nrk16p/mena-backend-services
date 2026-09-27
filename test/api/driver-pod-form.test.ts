import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { ok } from '../helpers/http.js';
import { type PlanningFixtures, createDo, postShipment, setupPlanning } from '../helpers/planning.js';

describe('POD form in the driver job list', () => {
  let app: App;
  let f: PlanningFixtures;
  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('attaches the client template when published, else the default form, and keeps COMPLETED shipments until CLOSED', async () => {
    const tpl = ok(await app.inject({
      method: 'POST', url: '/api/v1/pod-templates', headers: f.planner,
      payload: { clientId: f.ids.scg, jobGroupId: f.ids.bulkGroup, name: 'Bulk POD', extraSteps: ['DOCS_SUBMITTED'], fields: [{ key: 'ticket', label: 'ตั๋ว', type: 'photo', required: true }] },
    }), 201);
    ok(await app.inject({ method: 'POST', url: `/api/v1/pod-templates/${tpl.id}/publish`, headers: f.planner }));
    const bulk = await createDo(app, f);
    const bag = await createDo(app, f, { clientId: f.ids.cpac, materialId: f.ids.bag, destLocationId: f.ids.locC });
    const post = (url: string, h: { authorization: string }, payload: object) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });
    const sh = ok(await postShipment(app, f, { plannedStart: '2026-10-05T06:00:00+07:00', plannedEnd: '2026-10-05T18:00:00+07:00', head: { vehicleId: f.ids.m1, driverId: f.ids.d1 }, doIds: [bulk.id, bag.id] }), 201);
    const planned = ok(await post(`/shipments/${sh.id}/plan`, f.planner, { version: 1 }));
    ok(await post(`/shipments/${sh.id}/dispatch`, f.planner, { version: planned.version }));
    const list = ok(await app.inject({ method: 'GET', url: '/api/v1/driver/shipments', headers: f.driver1 }));
    const dos = Object.fromEntries(list.items[0].deliveryOrders.map((d: { doNo: string }) => [d.doNo, d]));
    expect(dos[bulk.doNo].podForm).toMatchObject({ templateId: tpl.id, version: 1, extraSteps: ['DOCS_SUBMITTED'], fields: [{ key: 'ticket' }] });
    expect(dos[bag.doNo].podForm).toMatchObject({ templateId: null, version: 0, extraSteps: [] });
    expect(dos[bag.doNo].podForm.fields.map((x: { key: string }) => x.key)).toEqual(['goodsPhoto', 'receiverName', 'receiverSign']);

    const listedIds = async () => ok(await app.inject({ method: 'GET', url: '/api/v1/driver/shipments', headers: f.driver1 })).items.map((x: { id: string }) => x.id);
    await app.db.collection(C.shipments).updateOne({ shipmentNo: sh.shipmentNo }, { $set: { status: 'COMPLETED' } });
    expect(await listedIds()).toContain(sh.id);
    await app.db.collection(C.shipments).updateOne({ shipmentNo: sh.shipmentNo }, { $set: { status: 'CLOSED' } });
    expect(await listedIds()).not.toContain(sh.id);
  });
});
