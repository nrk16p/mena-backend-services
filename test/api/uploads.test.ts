import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { signLocal } from '../../src/modules/storage/storage.js';
import { TEST_ENV, buildTestApp, closeTestApp } from '../helpers/app.js';
import { ok } from '../helpers/http.js';
import { type PlanningFixtures, createDo, postShipment, setupPlanning } from '../helpers/planning.js';

describe('POST /uploads/presign', () => {
  let app: App;
  let f: PlanningFixtures;
  let shipmentId: string;
  let doId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
    const d = await createDo(app, f);
    doId = d.id;
    const sh = ok(await postShipment(app, f, { plannedStart: '2026-10-05T06:00:00+07:00', plannedEnd: '2026-10-05T18:00:00+07:00', head: { vehicleId: f.ids.m1, driverId: f.ids.d1 }, doIds: [d.id] }), 201);
    shipmentId = sh.id;
    const post = (url: string, h: { authorization: string }, payload: object) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });
    const planned = ok(await post(`/shipments/${sh.id}/plan`, f.planner, { version: 1 }));
    const dispatched = ok(await post(`/shipments/${sh.id}/dispatch`, f.planner, { version: planned.version }));
    ok(await post(`/driver/shipments/${sh.id}/accept`, f.driver1, { version: dispatched.version }));
  });
  afterAll(async () => closeTestApp(app));

  const presign = (h: { authorization: string }, payload: object) => app.inject({ method: 'POST', url: '/api/v1/uploads/presign', headers: h, payload });

  it('returns a PUT URL under the shipment/DO prefix', async () => {
    const res = await presign(f.driver1, { shipmentId, doId, contentType: 'image/jpeg' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.key).toMatch(new RegExp(`^pods/${shipmentId}/${doId}/[0-9a-f-]{36}\\.jpg$`));
    expect(body).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, expiresInSec: 300, maxBytes: 5242880 });
    expect(body.url.startsWith('http://localhost:3000/api/v1/uploads/local?key=')).toBe(true);
  });

  it('accepts the upload on the signed local URL and serves it back via a signed GET link', async () => {
    const { url, key } = (await presign(f.driver1, { shipmentId, doId, contentType: 'image/jpeg' })).json();
    const path = url.replace('http://localhost:3000', '');
    const put = await app.inject({ method: 'PUT', url: path, headers: { 'content-type': 'image/jpeg' }, payload: Buffer.from('jpeg-bytes') });
    expect(put.statusCode).toBe(204);
    expect((await app.storage.get(key))?.body.toString()).toBe('jpeg-bytes');

    const getUrl = (await app.storage.presignGet(key, 300)).replace('http://localhost:3000', '');
    const get = await app.inject({ method: 'GET', url: getUrl });
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.toString()).toBe('jpeg-bytes');
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    expect(get.headers['content-security-policy']).toBe('sandbox');

    const forged = await app.inject({ method: 'PUT', url: path.replace(/sig=[^&]+/, 'sig=00'), headers: { 'content-type': 'image/jpeg' }, payload: Buffer.from('x') });
    expect(forged.statusCode).toBe(403);
  });

  it('binds the signature to the method and content type', async () => {
    const { url, key } = (await presign(f.driver1, { shipmentId, doId, contentType: 'image/jpeg' })).json();
    const path = url.replace('http://localhost:3000', '');

    // A GET link can't be replayed as a PUT.
    const getUrl = (await app.storage.presignGet(key, 300)).replace('http://localhost:3000', '');
    const putWithGetLink = await app.inject({ method: 'PUT', url: getUrl, headers: { 'content-type': 'image/jpeg' }, payload: Buffer.from('x') });
    expect(putWithGetLink.statusCode).toBe(403);

    // A PUT link can't be replayed as a GET, or reused with a different (but otherwise valid) content type.
    const getWithPutLink = await app.inject({ method: 'GET', url: path });
    expect(getWithPutLink.statusCode).toBe(403);
    const wrongContentType = await app.inject({ method: 'PUT', url: path, headers: { 'content-type': 'image/png' }, payload: Buffer.from('x') });
    expect(wrongContentType.statusCode).toBe(403);
  });

  it('rejects a content type outside UPLOAD_TYPES on the local PUT route with 415, even with a well-formed signature', async () => {
    const key = `pods/${shipmentId}/${doId}/${randomUUID()}.pdf`;
    const exp = String(Math.floor(Date.now() / 1000) + 300);
    const contentType = 'application/pdf';
    const sig = signLocal(TEST_ENV.JWT_SECRET, 'PUT', key, exp, contentType);
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/local?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`,
      headers: { 'content-type': contentType },
      payload: Buffer.from('pdf-bytes'),
    });
    expect(res.statusCode).toBe(415);
  });

  it('rejects a PUT body larger than UPLOAD_MAX_BYTES with 413', async () => {
    const { url } = (await presign(f.driver1, { shipmentId, doId, contentType: 'image/jpeg' })).json();
    const path = url.replace('http://localhost:3000', '');
    const oversized = Buffer.alloc(app.config.UPLOAD_MAX_BYTES + 1, 1);
    const res = await app.inject({ method: 'PUT', url: path, headers: { 'content-type': 'image/jpeg' }, payload: oversized });
    expect(res.statusCode).toBe(413);
  });

  it("hides other drivers' shipments and rejects other content types", async () => {
    expect((await presign(f.driver2, { shipmentId, doId, contentType: 'image/jpeg' })).statusCode).toBe(404);
    expect((await presign(f.driver1, { shipmentId, doId, contentType: 'application/pdf' })).statusCode).toBe(400);
  });

  it('404s when the DO is not on the shipment', async () => {
    const other = await createDo(app, f);
    const res = await presign(f.driver1, { shipmentId, doId: other.id, contentType: 'image/jpeg' });
    expect(res.statusCode).toBe(404);
  });

  it('normalizes an uppercase shipmentId/doId into a lowercase object key', async () => {
    const res = await presign(f.driver1, { shipmentId: shipmentId.toUpperCase(), doId: doId.toUpperCase(), contentType: 'image/jpeg' });
    expect(res.statusCode).toBe(200);
    const { key } = res.json();
    expect(key.startsWith(`pods/${shipmentId}/${doId}/`)).toBe(true);
    expect(key).toBe(key.toLowerCase());
  });

  it('refuses uploads before the driver has accepted the shipment', async () => {
    const d = await createDo(app, f);
    const sh = ok(await postShipment(app, f, { plannedStart: '2026-10-06T06:00:00+07:00', plannedEnd: '2026-10-06T18:00:00+07:00', head: { vehicleId: f.ids.m1, driverId: f.ids.d1 }, doIds: [d.id] }), 201);
    const planned = ok(await app.inject({ method: 'POST', url: `/api/v1/shipments/${sh.id}/plan`, headers: f.planner, payload: { version: 1 } }));
    ok(await app.inject({ method: 'POST', url: `/api/v1/shipments/${sh.id}/dispatch`, headers: f.planner, payload: { version: planned.version } }));
    const res = await presign(f.driver1, { shipmentId: sh.id, doId: d.id, contentType: 'image/jpeg' });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('SHIPMENT_NOT_ACTIVE');
  });
});
