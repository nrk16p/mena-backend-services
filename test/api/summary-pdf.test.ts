import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { type SummaryPdfData, buildSummaryPdf, embeddableImage } from '../../src/modules/summaries/pdf.js';
import type { MemoryStorage } from '../../src/modules/storage/storage.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { acceptedShipment, at, deliveredPod, gps, tap, tinyJpeg } from '../helpers/execution.js';
import { ok } from '../helpers/http.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

/** A valid 1×1 PNG. */
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4ceIEAAS0AlkWLoFAAAAAAElFTkSuQmCC', 'base64');

const base: SummaryPdfData = {
  shipmentNo: 'SH-2610-00001', plannedStart: new Date(), closedAt: new Date(), closedBy: 'admin',
  vehicles: ['80-3001'], drivers: ['สมชาย ใจดี'],
  stops: [{ seq: 1, location: 'โรงงานสระบุรี', events: [{ code: 'ARRIVED', at: new Date() }] }],
  dos: [{
    doNo: 'DO-2610-00001', client: 'SCG', material: 'ปูนผง', qty: 30, unit: 'ton', outcome: 'DELIVERED', reasonCode: null,
    answers: [{ label: 'ชื่อผู้รับ', value: 'คุณสมศรี' }], hash: 'a'.repeat(64), images: [],
  }],
  flags: [],
};

describe('evidence PDF', () => {
  let app: App;
  let f: PlanningFixtures;
  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('renders Thai text into a PDF', async () => {
    const pdf = await buildSummaryPdf(base);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(5000);
  });

  it('embeds decodable JPEG/PNG images and skips anything else instead of failing', async () => {
    expect(embeddableImage(tinyJpeg())).toMatch(/^data:image\/jpeg;base64,/);
    expect(embeddableImage(TINY_PNG)).toMatch(/^data:image\/png;base64,/);
    expect(embeddableImage(Buffer.from('photo-abc'))).toBeNull();
    expect(embeddableImage(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBeNull(); // JPEG magic, truncated body
    const pdf = await buildSummaryPdf({
      ...base,
      dos: [{ ...base.dos[0]!, images: [Buffer.from('not an image'), Buffer.from([0xff, 0xd8, 0xff, 0x00]), tinyJpeg(), TINY_PNG] }],
    });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('stores the PDF on close, serves it and lets a planner regenerate it', async () => {
    const { shipment, dos } = await acceptedShipment(app, f);
    for (const code of ['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED']) await tap(app, f, shipment, 0, code);
    for (const code of ['ARRIVED', 'UNLOAD_START', 'UNLOAD_END']) await tap(app, f, shipment, 1, code, gps(13.75, 100.5, at('10:00')));
    const pod = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    ok(await app.inject({ method: 'POST', url: `/api/v1/pods/${pod.id}/verify`, headers: f.admin }));
    const current = ok(await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}`, headers: f.admin }));
    ok(await app.inject({ method: 'POST', url: `/api/v1/shipments/${shipment.id}/close`, headers: f.admin, payload: { version: current.version } }));
    const summary = ok(await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}/summary`, headers: f.viewer }));
    expect(summary.pdfKey).toBe(`summaries/${shipment.shipmentNo}.pdf`);
    const res = await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}/summary.pdf`, headers: f.viewer });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    const regenerate = (h: { authorization: string }) => app.inject({ method: 'POST', url: `/api/v1/shipments/${shipment.id}/summary.pdf/regenerate`, headers: h });
    expect((await regenerate(f.viewer)).statusCode).toBe(403);
    expect(ok(await regenerate(f.planner)).pdfKey).toBe(`summaries/${shipment.shipmentNo}.pdf`);
  });

  it('still closes and produces a PDF when a POD file goes missing or is swapped after upload', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-25' });
    for (const code of ['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED']) await tap(app, f, shipment, 0, code);
    for (const code of ['ARRIVED', 'UNLOAD_START', 'UNLOAD_END']) await tap(app, f, shipment, 1, code, gps(13.75, 100.5, at('10:00', '2026-10-25')));
    const pod = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    const storage = app.storage as MemoryStorage;
    const goodsPhoto = pod.files.find((x: { fieldKey: string }) => x.fieldKey === 'goodsPhoto');
    const signature = pod.files.find((x: { fieldKey: string }) => x.fieldKey === 'receiverSign');
    storage.objects.delete(goodsPhoto.key); // simulates the object disappearing from storage before close
    await storage.put(signature.key, tinyJpeg('tampered-after-upload'), 'image/jpeg'); // same key, different bytes → sha256 mismatch
    ok(await app.inject({ method: 'POST', url: `/api/v1/pods/${pod.id}/verify`, headers: f.admin }));
    const current = ok(await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}`, headers: f.admin }));
    const closed = ok(await app.inject({ method: 'POST', url: `/api/v1/shipments/${shipment.id}/close`, headers: f.admin, payload: { version: current.version } }));
    expect(closed.status).toBe('CLOSED'); // a rehash mismatch/missing file never blocks the close or the PDF
    const summary = ok(await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}/summary`, headers: f.viewer }));
    expect(summary.pdfKey).toBe(`summaries/${shipment.shipmentNo}.pdf`);
    const res = await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}/summary.pdf`, headers: f.viewer });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });
});
