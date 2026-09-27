# Plan 3 — Driver Execution, ePOD, Pallets & Shipment Close — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A driver runs an accepted shipment end to end — records every stop step with GPS, uploads photos/signatures to DigitalOcean Spaces, submits a POD per delivery order using the client's POD form (or a failed-delivery report with a reason) and records pallet movements — and an admin verifies/rejects PODs and closes the shipment, producing a locked trip summary and an evidence PDF.

**Architecture:** New modules `storage` (S3-compatible adapter + in-memory test adapter), `execution` (event rules + driver events), `pods` (form validation, submission, review), `pallets`, and `summaries` (close + PDF). Pure rule engines (`event-rules.ts`, `pod-validation.ts`, `geo.ts`, `canonical.ts`) are dependency-free with unit tests. Every write that touches a shipment and its DOs runs in one MongoDB transaction; events and PODs are append-only.

**Tech Stack:** Plan 1–2 stack plus `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`, `pdfmake@^0.2` (+ `@types/pdfmake`), Sarabun TTF fonts (OFL) for Thai text in PDFs.

**Spec:** `docs/superpowers/specs/2026-09-27-phase1-planning-epod-design.md` §5.3–5.6, §6, §7, §9, §13 (performance). Roadmap: `docs/superpowers/plans/2026-09-27-roadmap.md`.

**Decisions made in this plan (flag to PO at handoff):**
- Driver events and PODs are append-only records that are themselves the audit trail; they do not write `auditLog` entries. POD verify/reject, pallet corrections and shipment close do.
- Admin `CORRECTION` events and admin step overrides (spec §5.3) are **not** in this plan; a wrong tap is fixed by the planner cancelling/re-planning or by a later plan.
- Geofence-suggested events (spec §5.5) need the GPS feed and are in Plan 4.
- A POD with outcome `FAILED` keeps its DO linked to the shipment until close; closing the shipment releases failed DOs back to the pool (`UNASSIGNED`) with the attempt recorded in `attempts[]` (spec §5.2 "failed attempt remains part of the original shipment's evidence").
- If a client has no published POD template, the built-in default form (goods photo ≥ 1, receiver name, receiver signature) is used.
- Storage: `STORAGE_DRIVER=s3` uses DigitalOcean Spaces via the S3 API (keys from `.env`); tests and local development without keys use `STORAGE_DRIVER=memory`.
- Evidence PDF embeds up to two JPEG/PNG photos per DO and the signature; WebP photos are listed by name only (pdfmake cannot embed WebP).

## Global Constraints

- Everything in Plan 1 and Plan 2 Global Constraints still applies.
- **Never call `bulkWrite` or `insertMany` inside `withTransaction`** (mongodb 6.21 + client `timeoutMS` rejects them; write documents one at a time inside the transaction).
- Every driver event, POD and pallet movement carries `lat`, `lng`, `accuracyM` (all nullable only together with `noGpsReason: 'NO_GPS'`) and `deviceTime`; the server adds `receivedAt` and flags `NO_GPS`, `LOW_ACCURACY` (> 100 m), `OUTSIDE_GEOFENCE` (> location `geofenceRadiusM`), `LATE_SYNC` (receivedAt − deviceTime > 6 h).
- Driver writes are idempotent: `clientEventId` / `clientPodId` are UUIDs with unique indexes; a replay returns the original result (`duplicate`), never a second record.
- Uploaded files: only `image/jpeg`, `image/png`, `image/webp`; max `UPLOAD_MAX_BYTES` (default 5 242 880); key prefix `pods/{shipmentId}/{doId}/`; SHA-256 recomputed by the server before a POD is accepted.
- `pod.hash = sha256(canonicalJson({ doId, templateId, templateVersion, outcome, reasonCode, answers, files: files sorted by key → { key, sha256 }, evidence }))` where `canonicalJson` sorts object keys recursively.
- Reason codes: `SHORTAGE, OVERAGE, DAMAGED, REFUSED_FULL, REFUSED_PARTIAL, CONSIGNEE_CLOSED, NO_RECEIVER, WRONG_ADDRESS, DOCS_MISSING, TEMP_OUT_OF_RANGE, TRAFFIC, BREAKDOWN, WEATHER, CHECKPOINT, OTHER` (`OTHER` requires a note).
- Stop step order: `ARRIVED` → (drop DOs) `UNLOAD_START` → `UNLOAD_END` → (pickup DOs) `LOAD_START` → `LOAD_END` → `DEPARTED`; a stop cannot be `ARRIVED` before the previous stop is `DEPARTED`; `DEPARTED` at a stop with drops requires a POD for every drop DO.
- Roles: driver endpoints need role `driver` + linked `driverId` and only reach shipments where the driver is head or tail driver (others → 404). POD review (verify/reject) and close: `admin` or `planner` (PO 2026-09-27); `viewer` → 403. Reads of events/PODs/summaries: `admin`, `planner`, `viewer`.

## Review Focus

1. **Phone offline for hours, then syncs a batch of taps twice** → each event stored once (duplicates reported as `duplicate`), in-order taps accepted, `LATE_SYNC` flagged. Test in Task 4.
2. **Driver taps "Departed" before submitting PODs for the drops at that stop** → rejected with `POD_REQUIRED`, nothing stored. Test in Task 4.
3. **A photo uploaded, then replaced in storage with a different file before the POD is submitted** (or the client sends the wrong hash) → `FILE_HASH_MISMATCH`, POD not stored. Test in Task 6.
4. **Admin rejects a POD and the driver resubmits** → the new POD supersedes the old one, the DO returns to `DELIVERED`, and the shipment can close only after the new POD is verified. Test in Task 7.
5. **Two pallet movements for the same trailer sent at the same moment** → the balance reflects both, each `balanceAfter` is consistent with a serial order. Test in Task 8.

---

## File Structure

```
src/
  config.ts                         + STORAGE_DRIVER, SPACES_*, UPLOAD_MAX_BYTES
  lib/geo.ts                        haversineM, gpsFlags
  lib/canonical.ts                  canonicalJson, sha256Hex
  lib/gps.ts                        GpsFields zod + toGps
  plugins/storage.ts                app.storage (S3Storage | MemoryStorage)
  modules/storage/storage.ts        Storage interface, MemoryStorage, S3Storage, createStorage
  modules/storage/uploads.routes.ts POST /uploads/presign
  modules/execution/event-rules.ts  pure step rules
  modules/execution/events.service.ts recordDriverEvent
  modules/execution/events.routes.ts  POST /driver/events, GET /shipments/:id/events
  modules/pods/pod-validation.ts    DEFAULT_POD_FIELDS, validatePodAnswers (pure)
  modules/pods/pods.service.ts      submitPod, podFormFor
  modules/pods/pods.routes.ts       POST /driver/pods, GET /pods, GET /pods/:id, verify, reject
  modules/pallets/pallets.routes.ts pallet movements + balances
  modules/summaries/close.service.ts closeShipment
  modules/summaries/pdf.ts          buildSummaryPdf
  modules/summaries/summaries.routes.ts POST /shipments/:id/close, GET summary, GET summary.pdf
  modules/shipments/shipment.types.ts   StopDoc.status union; ShipmentDoc close fields
  modules/shipments/shipment.schemas.ts ShipmentItem close fields
  modules/shipments/driver.routes.ts    + podForm per DO
  seed/seed.ts                      richer demo (users, fleet, templates)
assets/fonts/Sarabun-Regular.ttf, Sarabun-Bold.ttf
test/helpers/execution.ts          acceptedShipment, tap, uploadPhoto, submitPod helpers
```

---

### Task 1: Storage adapter, config and upload presign

**Files:**
- Create: `src/modules/storage/storage.ts`, `src/plugins/storage.ts`, `src/modules/storage/uploads.routes.ts`, `src/lib/canonical.ts`
- Modify: `src/config.ts`, `src/app.ts`, `src/routes.ts`, `src/types/fastify.d.ts`, `.env.example`, `test/unit/config.test.ts`
- Test: `test/unit/storage.test.ts`, `test/api/uploads.test.ts`

**Interfaces:**
- Produces:
  - `interface Storage { presignPut(key, contentType, expiresSec): Promise<string>; presignGet(key, expiresSec): Promise<string>; get(key): Promise<{ body: Buffer; contentType: string } | null>; put(key, body, contentType): Promise<void> }`, `class MemoryStorage implements Storage` (public `objects: Map`; constructed with optional `{ baseUrl, secret }` — with them it returns signed local URLs `${baseUrl}/api/v1/uploads/local?key=…&exp=…&sig=…`, without them `memory://<key>`), `verifyLocalSignature(secret, key, exp, sig): boolean`, `class S3Storage`, `createStorage(config): Storage`; `app.storage`.
  - Config `PUBLIC_BASE_URL` (default `http://localhost:3000`) — used for local upload links.
  - Only when `STORAGE_DRIVER=memory`: `PUT /uploads/local?key&exp&sig` (raw `image/*` body, ≤ `UPLOAD_MAX_BYTES`) stores the object; `GET /uploads/local?key&exp&sig` streams it. Invalid/expired signature → 403 `INVALID_SIGNATURE`. These let the browser demo work without Spaces keys (data is lost on restart).
  - Config: `STORAGE_DRIVER: 's3' | 'memory'` (default `'memory'`), `SPACES_ENDPOINT?`, `SPACES_REGION` (default `'sgp1'`), `SPACES_BUCKET?`, `SPACES_KEY?`, `SPACES_SECRET?` (all four required when `STORAGE_DRIVER=s3`), `UPLOAD_MAX_BYTES` (default 5242880).
  - `canonicalJson(value: unknown): string`, `sha256Hex(data: string | Buffer): string`.
  - `POST /uploads/presign` (driver): body `{ shipmentId, doId, contentType: 'image/jpeg'|'image/png'|'image/webp' }` → `{ key, url, method: 'PUT', headers: { 'Content-Type': string }, expiresInSec: 300, maxBytes }`; 404 if the shipment isn't the driver's or the DO isn't in it; 422 `SHIPMENT_NOT_ACTIVE` unless ACCEPTED/IN_TRANSIT/COMPLETED.

- [ ] **Step 1: Install**

Run: `npm i @aws-sdk/client-s3@^3 @aws-sdk/s3-request-presigner@^3`

- [ ] **Step 2: Write the failing tests**

Append inside the `describe` of `test/unit/config.test.ts`:
```ts
  it('defaults to memory storage and requires Spaces settings for s3', () => {
    expect(loadConfig(base).STORAGE_DRIVER).toBe('memory');
    expect(loadConfig(base).UPLOAD_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 's3' })).toThrow(/SPACES_BUCKET/);
    const s3 = loadConfig({
      ...base, STORAGE_DRIVER: 's3', SPACES_ENDPOINT: 'https://sgp1.digitaloceanspaces.com',
      SPACES_BUCKET: 'b', SPACES_KEY: 'k', SPACES_SECRET: 's',
    });
    expect(s3.SPACES_REGION).toBe('sgp1');
  });
```

`test/unit/storage.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../../src/lib/canonical.js';
import { MemoryStorage, S3Storage, verifyLocalSignature } from '../../src/modules/storage/storage.js';

describe('canonical hashing', () => {
  it('sorts keys recursively so equal objects hash equally', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
    expect(sha256Hex(canonicalJson({ x: 1, y: 2 }))).toBe(sha256Hex(canonicalJson({ y: 2, x: 1 })));
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('MemoryStorage', () => {
  it('stores and returns objects', async () => {
    const s = new MemoryStorage();
    expect(await s.get('k')).toBeNull();
    await s.put('k', Buffer.from('hi'), 'text/plain');
    expect(await s.get('k')).toEqual({ body: Buffer.from('hi'), contentType: 'text/plain' });
    expect(await s.presignPut('k', 'image/png', 300)).toBe('memory://k');
  });

  it('signs local URLs when given a base URL and secret', async () => {
    const s = new MemoryStorage({ baseUrl: 'http://localhost:3000', secret: 'x'.repeat(32) });
    const url = new URL(await s.presignPut('pods/a/b.jpg', 'image/jpeg', 300));
    expect(url.pathname).toBe('/api/v1/uploads/local');
    const key = url.searchParams.get('key')!;
    const exp = url.searchParams.get('exp')!;
    const sig = url.searchParams.get('sig')!;
    expect(verifyLocalSignature('x'.repeat(32), key, exp, sig)).toBe(true);
    expect(verifyLocalSignature('x'.repeat(32), key, exp, `${sig}0`)).toBe(false);
    expect(verifyLocalSignature('x'.repeat(32), key, String(Math.floor(Date.now() / 1000) - 1), sig)).toBe(false);
  });
});

describe('S3Storage', () => {
  it('presigns PUT and GET URLs for the bucket without network access', async () => {
    const s = new S3Storage({ endpoint: 'https://sgp1.digitaloceanspaces.com', region: 'sgp1', bucket: 'mena-pod', key: 'AKIA', secret: 'secret' });
    const put = await s.presignPut('pods/a/b/c.jpg', 'image/jpeg', 300);
    expect(put).toContain('mena-pod');
    expect(put).toContain('pods/a/b/c.jpg');
    expect(put).toContain('X-Amz-Signature=');
    expect(await s.presignGet('pods/a/b/c.jpg', 300)).toContain('X-Amz-Expires=300');
  });
});
```

`test/api/uploads.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
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
    const sh = (await postShipment(app, f, { plannedStart: '2026-10-05T06:00:00+07:00', plannedEnd: '2026-10-05T18:00:00+07:00', head: { vehicleId: f.ids.m1, driverId: f.ids.d1 }, doIds: [d.id] })).json();
    shipmentId = sh.id;
    const post = (url: string, h: { authorization: string }, payload: object) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });
    const planned = (await post(`/shipments/${sh.id}/plan`, f.planner, { version: 1 })).json();
    const dispatched = (await post(`/shipments/${sh.id}/dispatch`, f.planner, { version: planned.version })).json();
    await post(`/driver/shipments/${sh.id}/accept`, f.driver1, { version: dispatched.version });
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

  it('accepts the upload on the signed local URL and serves it back', async () => {
    const { url, key } = (await presign(f.driver1, { shipmentId, doId, contentType: 'image/jpeg' })).json();
    const path = url.replace('http://localhost:3000', '');
    const put = await app.inject({ method: 'PUT', url: path, headers: { 'content-type': 'image/jpeg' }, payload: Buffer.from('jpeg-bytes') });
    expect(put.statusCode).toBe(204);
    expect((await app.storage.get(key))?.body.toString()).toBe('jpeg-bytes');
    const get = await app.inject({ method: 'GET', url: path });
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.toString()).toBe('jpeg-bytes');
    const forged = await app.inject({ method: 'PUT', url: path.replace(/sig=[^&]+/, 'sig=00'), headers: { 'content-type': 'image/jpeg' }, payload: Buffer.from('x') });
    expect(forged.statusCode).toBe(403);
  });

  it('hides other drivers\' shipments and rejects other content types', async () => {
    expect((await presign(f.driver2, { shipmentId, doId, contentType: 'image/jpeg' })).statusCode).toBe(404);
    expect((await presign(f.driver1, { shipmentId, doId, contentType: 'application/pdf' })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts test/unit/storage.test.ts test/api/uploads.test.ts`
Expected: FAIL — config fields, modules and route missing.

- [ ] **Step 4: Implement config, hashing and storage**

`src/config.ts` — add to `EnvSchema`:
```ts
  STORAGE_DRIVER: z.enum(['s3', 'memory']).default('memory'),
  SPACES_ENDPOINT: z.string().url().optional(),
  SPACES_REGION: z.string().default('sgp1'),
  SPACES_BUCKET: z.string().min(1).optional(),
  SPACES_KEY: z.string().min(1).optional(),
  SPACES_SECRET: z.string().min(1).optional(),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
```
and turn the schema into a refined one (keep `Config = z.infer<typeof EnvSchema>` working):
```ts
const EnvSchema = BaseEnvSchema.superRefine((env, ctx) => {
  if (env.STORAGE_DRIVER !== 's3') return;
  for (const k of ['SPACES_ENDPOINT', 'SPACES_BUCKET', 'SPACES_KEY', 'SPACES_SECRET'] as const) {
    if (!env[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: `${k} is required when STORAGE_DRIVER=s3` });
  }
});
```
(rename the existing `z.object({...})` to `BaseEnvSchema`).

`src/lib/canonical.ts`:
```ts
import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
```

`src/modules/storage/storage.ts`:
```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../../config.js';

export interface StoredObject {
  body: Buffer;
  contentType: string;
}

export interface Storage {
  presignPut(key: string, contentType: string, expiresSec: number): Promise<string>;
  presignGet(key: string, expiresSec: number): Promise<string>;
  get(key: string): Promise<StoredObject | null>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
}

export function signLocal(secret: string, key: string, exp: string): string {
  return createHmac('sha256', secret).update(`${key}\n${exp}`).digest('hex');
}

export function verifyLocalSignature(secret: string, key: string, exp: string, sig: string): boolean {
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < Date.now()) return false;
  const a = Buffer.from(signLocal(secret, key, exp), 'hex');
  const b = Buffer.from(sig, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export class MemoryStorage implements Storage {
  readonly objects = new Map<string, StoredObject>();
  constructor(private readonly local?: { baseUrl: string; secret: string }) {}

  private link(key: string, expiresSec: number): string {
    if (!this.local) return `memory://${key}`;
    const exp = String(Math.floor(Date.now() / 1000) + expiresSec);
    const q = new URLSearchParams({ key, exp, sig: signLocal(this.local.secret, key, exp) });
    return `${this.local.baseUrl}/api/v1/uploads/local?${q.toString()}`;
  }
  async presignPut(key: string, _contentType?: string, expiresSec = 300): Promise<string> {
    return this.link(key, expiresSec);
  }
  async presignGet(key: string, expiresSec = 300): Promise<string> {
    return this.link(key, expiresSec);
  }
  async get(key: string): Promise<StoredObject | null> {
    return this.objects.get(key) ?? null;
  }
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }
}

export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(o: { endpoint: string; region: string; bucket: string; key: string; secret: string }) {
    this.bucket = o.bucket;
    this.client = new S3Client({ endpoint: o.endpoint, region: o.region, credentials: { accessKeyId: o.key, secretAccessKey: o.secret } });
  }

  presignPut(key: string, contentType: string, expiresSec: number): Promise<string> {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }), { expiresIn: expiresSec });
  }

  presignGet(key: string, expiresSec: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresSec });
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) return null;
      return { body: Buffer.from(await res.Body.transformToByteArray()), contentType: res.ContentType ?? 'application/octet-stream' };
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw e;
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }
}

export function createStorage(config: Config): Storage {
  if (config.STORAGE_DRIVER === 'memory') return new MemoryStorage({ baseUrl: config.PUBLIC_BASE_URL, secret: config.JWT_SECRET });
  return new S3Storage({
    endpoint: config.SPACES_ENDPOINT!,
    region: config.SPACES_REGION,
    bucket: config.SPACES_BUCKET!,
    key: config.SPACES_KEY!,
    secret: config.SPACES_SECRET!,
  });
}
```

`src/types/fastify.d.ts` — add `storage: Storage;` to `FastifyInstance` (import type `Storage` from `../modules/storage/storage.js`).

`src/plugins/storage.ts`:
```ts
import fp from 'fastify-plugin';
import { createStorage } from '../modules/storage/storage.js';

export default fp(
  async (app) => {
    app.decorate('storage', createStorage(app.config));
  },
  { name: 'storage' },
);
```
Register it in `src/app.ts` right after `mongoPlugin`: `await app.register(storagePlugin);`.

- [ ] **Step 5: Implement the presign route**

`src/modules/storage/uploads.routes.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { AppError, notFound, unprocessable } from '../../lib/errors.js';
import { objectIdString } from '../../lib/ids.js';
import { doIdsOf } from '../shipments/shipment.service.js';
import type { ShipmentDoc } from '../shipments/shipment.types.js';

export const UPLOAD_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;
export const ACTIVE_FOR_UPLOAD = ['ACCEPTED', 'IN_TRANSIT', 'COMPLETED'] as const;

export function driverIdOf(req: { principal: unknown }): ObjectId {
  const p = req.principal as { kind: string; driverId: string | null } | null;
  if (!p || p.kind !== 'user' || !p.driverId) throw new AppError(403, 'NOT_A_DRIVER', 'This user is not linked to a driver');
  return new ObjectId(p.driverId);
}

export async function loadDriverShipment(db: import('mongodb').Db, id: ObjectId, driverId: ObjectId): Promise<ShipmentDoc> {
  const doc = await db
    .collection<ShipmentDoc>(C.shipments)
    .findOne({ _id: id, $or: [{ 'head.driverId': driverId }, { 'tail.driverId': driverId }] });
  if (!doc) throw notFound('Shipment');
  return doc;
}

export const uploadRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/uploads/presign',
    {
      schema: {
        tags: ['driver'],
        body: z.object({
          shipmentId: objectIdString,
          doId: objectIdString,
          contentType: z.enum(Object.keys(UPLOAD_TYPES) as [keyof typeof UPLOAD_TYPES, ...(keyof typeof UPLOAD_TYPES)[]]),
        }),
        response: {
          200: z.object({
            key: z.string(),
            url: z.string(),
            method: z.literal('PUT'),
            headers: z.object({ 'Content-Type': z.string() }),
            expiresInSec: z.number(),
            maxBytes: z.number(),
          }),
        },
      },
      preHandler: app.requireRoles('driver'),
    },
    async (req) => {
      const shipment = await loadDriverShipment(app.db, new ObjectId(req.body.shipmentId), driverIdOf(req));
      if (!doIdsOf(shipment.stops).some((id) => id.toHexString() === req.body.doId)) throw notFound('Delivery order');
      if (!(ACTIVE_FOR_UPLOAD as readonly string[]).includes(shipment.status)) {
        throw unprocessable('SHIPMENT_NOT_ACTIVE', `Uploads are not allowed for a ${shipment.status} shipment`);
      }
      const key = `pods/${req.body.shipmentId}/${req.body.doId}/${randomUUID()}.${UPLOAD_TYPES[req.body.contentType]}`;
      const expiresInSec = 300;
      return {
        key,
        url: await app.storage.presignPut(key, req.body.contentType, expiresInSec),
        method: 'PUT' as const,
        headers: { 'Content-Type': req.body.contentType },
        expiresInSec,
        maxBytes: app.config.UPLOAD_MAX_BYTES,
      };
    },
  );
};
```

Also add the local upload routes inside `uploadRoutes` (only registered when `app.config.STORAGE_DRIVER === 'memory'`):
```ts
  if (app.config.STORAGE_DRIVER === 'memory') {
    const LocalQuery = z.object({ key: z.string().min(1), exp: z.string(), sig: z.string() });
    const check = (q: z.infer<typeof LocalQuery>) => {
      if (!verifyLocalSignature(app.config.JWT_SECRET, q.key, q.exp, q.sig)) throw new AppError(403, 'INVALID_SIGNATURE', 'The upload link is invalid or expired');
    };
    await app.register(async (local) => {
      local.addContentTypeParser(/^(image|application)\//, { parseAs: 'buffer', bodyLimit: app.config.UPLOAD_MAX_BYTES }, (_req, body, done) => done(null, body));
      local.put('/uploads/local', { schema: { hide: true, querystring: LocalQuery } }, async (req, reply) => {
        check(req.query);
        const body = req.body as Buffer;
        await app.storage.put(req.query.key, body, req.headers['content-type'] ?? 'application/octet-stream');
        return reply.status(204).send();
      });
      local.get('/uploads/local', { schema: { hide: true, querystring: LocalQuery } }, async (req, reply) => {
        check(req.query);
        const obj = await app.storage.get(req.query.key);
        if (!obj) throw notFound('File');
        return reply.header('content-type', obj.contentType).send(obj.body);
      });
    });
  }
```
(import `verifyLocalSignature` from `./storage.js`). The browser must be able to PUT to this URL: in the demo the Vite dev servers proxy `/api` to the API, and `PUBLIC_BASE_URL` can be set to the Vite origin so links stay same-origin.

Register `uploadRoutes` in `src/routes.ts`. Append to `.env.example`:
```
# File storage: memory (tests/local) or s3 (DigitalOcean Spaces)
STORAGE_DRIVER=memory
SPACES_ENDPOINT=https://sgp1.digitaloceanspaces.com
SPACES_REGION=sgp1
SPACES_BUCKET=
SPACES_KEY=
SPACES_SECRET=
UPLOAD_MAX_BYTES=5242880
# Base URL used in local (memory storage) upload links
PUBLIC_BASE_URL=http://localhost:3000
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(storage): Spaces/memory storage adapter, canonical hashing and upload presign" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 2: GPS evidence helpers and step rules (pure)

**Files:**
- Create: `src/lib/geo.ts`, `src/lib/gps.ts`, `src/modules/execution/event-rules.ts`
- Test: `test/unit/geo.test.ts`, `test/unit/event-rules.test.ts`

**Interfaces:**
- Produces:
  - `haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number`.
  - `gpsFlags(i: { lat: number | null; lng: number | null; accuracyM: number | null; deviceTime: Date; receivedAt: Date; target?: { lat: number; lng: number; radiusM: number } }): { flags: string[]; distanceM: number | null }`.
  - `GpsFields` (zod object: `lat`, `lng`, `accuracyM` nullable; `noGpsReason: 'NO_GPS' | null` default null; `deviceTime` ISO) with refinement; `type GpsInput`.
  - `STOP_EVENTS`, `EXTRA_EVENTS`, `GLOBAL_EVENTS`, `EVENT_CODES`, `REASON_CODES`, types `StopEventCode`, `ExtraEventCode`, `EventCode`, `ReasonCode`.
  - `stopSequence(hasDrops, hasPickups): StopEventCode[]`, `checkStopEvent(state: StopState, code: StopEventCode, prevStopDeparted: boolean): Issue | null`, `checkExtraEvent(state: StopState, code: ExtraEventCode, allowed: string[]): Issue | null`, `stopStatusFrom(done: Set<string>): 'PENDING' | 'ARRIVED' | 'WORKING' | 'DONE'`, `interface StopState { hasDrops: boolean; hasPickups: boolean; done: Set<string>; allDropsHavePod: boolean }`.

- [ ] **Step 1: Write the failing tests**

`test/unit/geo.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { gpsFlags, haversineM } from '../../src/lib/geo.js';
import { GpsFields } from '../../src/lib/gps.js';

const t0 = new Date('2026-10-05T01:00:00Z');

describe('geo', () => {
  it('computes distances in metres', () => {
    const bkk = { lat: 13.7563, lng: 100.5018 };
    expect(haversineM(bkk, bkk)).toBe(0);
    expect(Math.round(haversineM(bkk, { lat: 13.7563, lng: 100.5118 }) / 10) * 10).toBe(1080);
  });

  it('flags missing GPS, low accuracy, outside geofence and late sync', () => {
    expect(gpsFlags({ lat: null, lng: null, accuracyM: null, deviceTime: t0, receivedAt: t0 })).toEqual({ flags: ['NO_GPS'], distanceM: null });
    const out = gpsFlags({
      lat: 13.76, lng: 100.52, accuracyM: 150, deviceTime: t0, receivedAt: new Date(t0.getTime() + 7 * 3600_000),
      target: { lat: 13.75, lng: 100.5, radiusM: 300 },
    });
    expect(out.flags.sort()).toEqual(['LATE_SYNC', 'LOW_ACCURACY', 'OUTSIDE_GEOFENCE']);
    expect(out.distanceM).toBeGreaterThan(2000);
    expect(gpsFlags({ lat: 13.75, lng: 100.5, accuracyM: 10, deviceTime: t0, receivedAt: t0, target: { lat: 13.75, lng: 100.5, radiusM: 300 } }).flags).toEqual([]);
  });

  it('validates GPS payloads', () => {
    const ok = GpsFields.safeParse({ lat: 13.7, lng: 100.5, accuracyM: 8, deviceTime: '2026-10-05T08:00:00+07:00' });
    expect(ok.success).toBe(true);
    expect(GpsFields.safeParse({ lat: null, lng: null, accuracyM: null, noGpsReason: 'NO_GPS', deviceTime: '2026-10-05T08:00:00+07:00' }).success).toBe(true);
    expect(GpsFields.safeParse({ lat: null, lng: null, accuracyM: null, deviceTime: '2026-10-05T08:00:00+07:00' }).success).toBe(false);
    expect(GpsFields.safeParse({ lat: 13.7, lng: null, accuracyM: 5, deviceTime: '2026-10-05T08:00:00+07:00' }).success).toBe(false);
  });
});
```

`test/unit/event-rules.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { checkExtraEvent, checkStopEvent, stopSequence, stopStatusFrom } from '../../src/modules/execution/event-rules.js';

const state = (o: Partial<{ hasDrops: boolean; hasPickups: boolean; done: string[]; allDropsHavePod: boolean }>) => ({
  hasDrops: o.hasDrops ?? false, hasPickups: o.hasPickups ?? false, done: new Set(o.done ?? []), allDropsHavePod: o.allDropsHavePod ?? false,
});

describe('step rules', () => {
  it('orders drops before pickups', () => {
    expect(stopSequence(true, true)).toEqual(['ARRIVED', 'UNLOAD_START', 'UNLOAD_END', 'LOAD_START', 'LOAD_END', 'DEPARTED']);
    expect(stopSequence(false, true)).toEqual(['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED']);
  });

  it('accepts the next step and rejects skipped, repeated or irrelevant steps', () => {
    const pickup = state({ hasPickups: true, done: ['ARRIVED'] });
    expect(checkStopEvent(pickup, 'LOAD_START', true)).toBeNull();
    expect(checkStopEvent(pickup, 'LOAD_END', true)?.code).toBe('EVENT_OUT_OF_ORDER');
    expect(checkStopEvent(pickup, 'ARRIVED', true)?.code).toBe('EVENT_ALREADY_RECORDED');
    expect(checkStopEvent(pickup, 'UNLOAD_START', true)?.code).toBe('EVENT_NOT_APPLICABLE');
  });

  it('requires the previous stop to be departed before arriving', () => {
    expect(checkStopEvent(state({ hasDrops: true }), 'ARRIVED', false)?.code).toBe('PREVIOUS_STOP_OPEN');
  });

  it('requires PODs before departing a drop stop', () => {
    const drop = state({ hasDrops: true, done: ['ARRIVED', 'UNLOAD_START', 'UNLOAD_END'] });
    expect(checkStopEvent(drop, 'DEPARTED', true)?.code).toBe('POD_REQUIRED');
    expect(checkStopEvent({ ...drop, allDropsHavePod: true }, 'DEPARTED', true)).toBeNull();
  });

  it('allows configured extra steps only while at the stop', () => {
    expect(checkExtraEvent(state({ hasDrops: true }), 'DOCS_SUBMITTED', ['DOCS_SUBMITTED'])?.code).toBe('NOT_AT_STOP');
    expect(checkExtraEvent(state({ hasDrops: true, done: ['ARRIVED'] }), 'DOCS_SUBMITTED', ['DOCS_SUBMITTED'])).toBeNull();
    expect(checkExtraEvent(state({ hasDrops: true, done: ['ARRIVED'] }), 'TEMP_CHECKED', ['DOCS_SUBMITTED'])?.code).toBe('EVENT_NOT_APPLICABLE');
    expect(checkExtraEvent(state({ hasDrops: true, done: ['ARRIVED', 'DEPARTED'] }), 'DOCS_SUBMITTED', ['DOCS_SUBMITTED'])?.code).toBe('NOT_AT_STOP');
  });

  it('derives the stop status', () => {
    expect(stopStatusFrom(new Set())).toBe('PENDING');
    expect(stopStatusFrom(new Set(['ARRIVED']))).toBe('ARRIVED');
    expect(stopStatusFrom(new Set(['ARRIVED', 'UNLOAD_START']))).toBe('WORKING');
    expect(stopStatusFrom(new Set(['ARRIVED', 'DEPARTED']))).toBe('DONE');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/geo.test.ts test/unit/event-rules.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/lib/geo.ts`:
```ts
const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const LATE_SYNC_MS = 6 * 3600_000;
export const LOW_ACCURACY_M = 100;

export function gpsFlags(i: {
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  deviceTime: Date;
  receivedAt: Date;
  target?: { lat: number; lng: number; radiusM: number };
}): { flags: string[]; distanceM: number | null } {
  const flags: string[] = [];
  let distanceM: number | null = null;
  if (i.lat === null || i.lng === null) flags.push('NO_GPS');
  else {
    if (i.accuracyM !== null && i.accuracyM > LOW_ACCURACY_M) flags.push('LOW_ACCURACY');
    if (i.target) {
      distanceM = Math.round(haversineM({ lat: i.lat, lng: i.lng }, i.target));
      if (distanceM > i.target.radiusM) flags.push('OUTSIDE_GEOFENCE');
    }
  }
  if (i.receivedAt.getTime() - i.deviceTime.getTime() > LATE_SYNC_MS) flags.push('LATE_SYNC');
  return { flags, distanceM };
}
```

`src/lib/gps.ts`:
```ts
import { z } from 'zod';

export const GpsFields = z
  .object({
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
    accuracyM: z.number().min(0).nullable(),
    noGpsReason: z.literal('NO_GPS').nullable().default(null),
    deviceTime: z.string().datetime({ offset: true }),
  })
  .refine((g) => (g.lat === null) === (g.lng === null), { message: 'lat and lng must both be set or both be null', path: ['lat'] })
  .refine((g) => g.lat !== null || g.noGpsReason === 'NO_GPS', { message: 'send noGpsReason "NO_GPS" when the position is missing', path: ['noGpsReason'] });

export type GpsInput = z.infer<typeof GpsFields>;
```

`src/modules/execution/event-rules.ts`:
```ts
import type { Issue } from '../../lib/issues.js';

export const STOP_EVENTS = ['ARRIVED', 'UNLOAD_START', 'UNLOAD_END', 'LOAD_START', 'LOAD_END', 'DEPARTED'] as const;
export const EXTRA_EVENTS = ['DOCS_SUBMITTED', 'DOCS_RETURNED', 'SEAL_CHECKED', 'TEMP_CHECKED'] as const;
export const GLOBAL_EVENTS = ['DELAYED', 'BREAKDOWN', 'EXCEPTION'] as const;
export const EVENT_CODES = [...STOP_EVENTS, ...EXTRA_EVENTS, ...GLOBAL_EVENTS] as const;
export const REASON_CODES = [
  'SHORTAGE', 'OVERAGE', 'DAMAGED', 'REFUSED_FULL', 'REFUSED_PARTIAL', 'CONSIGNEE_CLOSED', 'NO_RECEIVER',
  'WRONG_ADDRESS', 'DOCS_MISSING', 'TEMP_OUT_OF_RANGE', 'TRAFFIC', 'BREAKDOWN', 'WEATHER', 'CHECKPOINT', 'OTHER',
] as const;

export type StopEventCode = (typeof STOP_EVENTS)[number];
export type ExtraEventCode = (typeof EXTRA_EVENTS)[number];
export type EventCode = (typeof EVENT_CODES)[number];
export type ReasonCode = (typeof REASON_CODES)[number];

export interface StopState {
  hasDrops: boolean;
  hasPickups: boolean;
  done: Set<string>;
  allDropsHavePod: boolean;
}

export function stopSequence(hasDrops: boolean, hasPickups: boolean): StopEventCode[] {
  return [
    'ARRIVED',
    ...(hasDrops ? (['UNLOAD_START', 'UNLOAD_END'] as const) : []),
    ...(hasPickups ? (['LOAD_START', 'LOAD_END'] as const) : []),
    'DEPARTED',
  ];
}

export function checkStopEvent(state: StopState, code: StopEventCode, prevStopDeparted: boolean): Issue | null {
  const seq = stopSequence(state.hasDrops, state.hasPickups);
  const idx = seq.indexOf(code);
  if (idx === -1) return { code: 'EVENT_NOT_APPLICABLE', message: `${code} does not apply to this stop` };
  if (state.done.has(code)) return { code: 'EVENT_ALREADY_RECORDED', message: `${code} was already recorded for this stop` };
  if (code === 'ARRIVED' && !prevStopDeparted) return { code: 'PREVIOUS_STOP_OPEN', message: 'Depart the previous stop first' };
  const missing = seq.slice(0, idx).filter((c) => !state.done.has(c));
  if (missing.length > 0) return { code: 'EVENT_OUT_OF_ORDER', message: `Record ${missing.join(', ')} first`, details: { missing } };
  if (code === 'DEPARTED' && state.hasDrops && !state.allDropsHavePod) {
    return { code: 'POD_REQUIRED', message: 'Submit a POD for every delivery order dropped here before departing' };
  }
  return null;
}

export function checkExtraEvent(state: StopState, code: ExtraEventCode, allowed: string[]): Issue | null {
  if (!state.done.has('ARRIVED') || state.done.has('DEPARTED')) return { code: 'NOT_AT_STOP', message: `${code} can only be recorded while at the stop` };
  if (!allowed.includes(code)) return { code: 'EVENT_NOT_APPLICABLE', message: `${code} is not required by this client` };
  if (state.done.has(code)) return { code: 'EVENT_ALREADY_RECORDED', message: `${code} was already recorded for this stop` };
  return null;
}

export function stopStatusFrom(done: Set<string>): 'PENDING' | 'ARRIVED' | 'WORKING' | 'DONE' {
  if (done.has('DEPARTED')) return 'DONE';
  if (['UNLOAD_START', 'UNLOAD_END', 'LOAD_START', 'LOAD_END'].some((c) => done.has(c))) return 'WORKING';
  if (done.has('ARRIVED')) return 'ARRIVED';
  return 'PENDING';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(execution): GPS evidence flags, GPS payload schema and stop step rules" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 3: POD form validation (pure) and POD template in the driver job list

**Files:**
- Create: `src/modules/pods/pod-validation.ts`
- Modify: `src/modules/shipments/driver.routes.ts`, `src/modules/shipments/shipment.types.ts`, `src/modules/shipments/shipment.schemas.ts`
- Test: `test/unit/pod-validation.test.ts`, `test/api/driver-pod-form.test.ts`

**Interfaces:**
- Consumes: `PodField`, `PodFieldSchema`, `EXTRA_STEPS`, `resolvePodTemplate(db, clientId, jobGroupId)`.
- Produces:
  - `DEFAULT_POD_FIELDS: PodField[]` (`goodsPhoto` photo required min 1 max 5; `receiverName` text required; `receiverSign` signature required).
  - `interface PodFileRef { fieldKey: string; key: string; sha256: string; mime: string; bytes: number }`.
  - `interface PodForm { templateId: ObjectId | null; version: number; fields: PodField[]; extraSteps: string[] }`, `podFormFor(db, doc: DeliveryOrderDoc): Promise<PodForm>`.
  - `validatePodAnswers(fields: PodField[], answers: Record<string, unknown>, files: PodFileRef[], outcome: 'DELIVERED' | 'FAILED'): Issue[]` — codes `UNKNOWN_FIELD`, `FIELD_REQUIRED`, `INVALID_TYPE`, `OUT_OF_RANGE`, `INVALID_OPTION`, `PHOTO_COUNT`, `SIGNATURE_COUNT`, `FILE_FIELD_MISMATCH`. For `FAILED`, required-ness is not enforced (given values are still type-checked).
  - `StopDoc.status` becomes `'PENDING' | 'ARRIVED' | 'WORKING' | 'DONE'`; `ShipmentDoc` gains `closedAt: Date | null`, `closedBy: string | null`, `summaryId: ObjectId | null`; `ShipmentItem` gains `closedAt`, `closedBy`, `summaryId` (all `z.string().nullable().default(null)`).
  - `GET /driver/shipments` → each delivery order also carries `podForm: { templateId: string | null; version: number; fields: PodField[]; extraSteps: string[] }`.

- [ ] **Step 1: Write the failing tests**

`test/unit/pod-validation.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_POD_FIELDS, type PodFileRef, validatePodAnswers } from '../../src/modules/pods/pod-validation.js';
import type { PodField } from '../../src/modules/pod-templates/pod-templates.schemas.js';

const file = (fieldKey: string, n = 1): PodFileRef => ({ fieldKey, key: `pods/s/d/${fieldKey}-${n}.jpg`, sha256: 'x', mime: 'image/jpeg', bytes: 1000 });
const codes = (issues: { code: string }[]) => issues.map((i) => i.code).sort();

const fields: PodField[] = [
  ...DEFAULT_POD_FIELDS,
  { key: 'tempC', label: 'อุณหภูมิ', type: 'number', required: true, min: -30, max: 10 },
  { key: 'condition', label: 'สภาพ', type: 'select', required: false, options: ['ปกติ', 'เสียหาย'] },
  { key: 'sealOk', label: 'ซีล', type: 'checkbox', required: false },
  { key: 'qty', label: 'จำนวน', type: 'qtyLines', required: false },
];

describe('validatePodAnswers', () => {
  it('accepts a complete delivered POD', () => {
    const issues = validatePodAnswers(
      fields,
      { receiverName: 'คุณสมศรี', tempC: 4, condition: 'ปกติ', sealOk: true, qty: [{ planned: 30, delivered: 30, unit: 'ton' }] },
      [file('goodsPhoto'), file('receiverSign')],
      'DELIVERED',
    );
    expect(issues).toEqual([]);
  });

  it('reports every problem at once', () => {
    const issues = validatePodAnswers(
      fields,
      { tempC: 20, condition: 'แตก', sealOk: 'yes', extra: 1 },
      [file('goodsPhoto', 1), file('goodsPhoto', 2), file('goodsPhoto', 3), file('goodsPhoto', 4), file('goodsPhoto', 5), file('goodsPhoto', 6), file('unknown')],
      'DELIVERED',
    );
    expect(codes(issues)).toEqual(['FIELD_REQUIRED', 'FILE_FIELD_MISMATCH', 'INVALID_OPTION', 'INVALID_TYPE', 'OUT_OF_RANGE', 'PHOTO_COUNT', 'SIGNATURE_COUNT', 'UNKNOWN_FIELD']);
  });

  it('does not require fields for a failed delivery but still type-checks them', () => {
    expect(validatePodAnswers(fields, {}, [], 'FAILED')).toEqual([]);
    expect(codes(validatePodAnswers(fields, { tempC: 'cold' }, [], 'FAILED'))).toEqual(['INVALID_TYPE']);
  });
});
```

The "reports every problem" case expects exactly one issue per problem: `receiverName` missing (`FIELD_REQUIRED`), signature missing (`SIGNATURE_COUNT`), 6 photos > max 5 (`PHOTO_COUNT`), `tempC` 20 > 10 (`OUT_OF_RANGE`), `condition` not an option (`INVALID_OPTION`), `sealOk` not boolean (`INVALID_TYPE`), answer key `extra` (`UNKNOWN_FIELD`), file with fieldKey `unknown` (`FILE_FIELD_MISMATCH`).

`test/api/driver-pod-form.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { type PlanningFixtures, createDo, postShipment, setupPlanning } from '../helpers/planning.js';

describe('POD form in the driver job list', () => {
  let app: App;
  let f: PlanningFixtures;
  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('attaches the client template when published, else the default form', async () => {
    const tpl = await app.inject({
      method: 'POST', url: '/api/v1/pod-templates', headers: f.planner,
      payload: { clientId: f.ids.scg, jobGroupId: f.ids.bulkGroup, name: 'Bulk POD', extraSteps: ['DOCS_SUBMITTED'], fields: [{ key: 'ticket', label: 'ตั๋ว', type: 'photo', required: true }] },
    });
    await app.inject({ method: 'POST', url: `/api/v1/pod-templates/${tpl.json().id}/publish`, headers: f.planner });
    const bulk = await createDo(app, f);
    const bag = await createDo(app, f, { clientId: f.ids.cpac, materialId: f.ids.bag, destLocationId: f.ids.locC });
    const post = (url: string, h: { authorization: string }, payload: object) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });
    const sh = (await postShipment(app, f, { plannedStart: '2026-10-05T06:00:00+07:00', plannedEnd: '2026-10-05T18:00:00+07:00', head: { vehicleId: f.ids.m1, driverId: f.ids.d1 }, doIds: [bulk.id, bag.id] })).json();
    const planned = (await post(`/shipments/${sh.id}/plan`, f.planner, { version: 1 })).json();
    await post(`/shipments/${sh.id}/dispatch`, f.planner, { version: planned.version });
    const list = await app.inject({ method: 'GET', url: '/api/v1/driver/shipments', headers: f.driver1 });
    const dos = Object.fromEntries(list.json().items[0].deliveryOrders.map((d: { doNo: string }) => [d.doNo, d]));
    expect(dos[bulk.doNo].podForm).toMatchObject({ templateId: tpl.json().id, version: 1, extraSteps: ['DOCS_SUBMITTED'], fields: [{ key: 'ticket' }] });
    expect(dos[bag.doNo].podForm).toMatchObject({ templateId: null, version: 0, extraSteps: [] });
    expect(dos[bag.doNo].podForm.fields.map((x: { key: string }) => x.key)).toEqual(['goodsPhoto', 'receiverName', 'receiverSign']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/pod-validation.test.ts test/api/driver-pod-form.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement validation**

`src/modules/pods/pod-validation.ts`:
```ts
import type { Db, ObjectId } from 'mongodb';
import type { Issue } from '../../lib/issues.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import type { PodField } from '../pod-templates/pod-templates.schemas.js';
import { resolvePodTemplate } from '../pod-templates/pod-templates.service.js';

export const DEFAULT_POD_FIELDS: PodField[] = [
  { key: 'goodsPhoto', label: 'รูปสินค้า', type: 'photo', required: true, min: 1, max: 5 },
  { key: 'receiverName', label: 'ชื่อผู้รับ', type: 'text', required: true },
  { key: 'receiverSign', label: 'ลายเซ็นผู้รับ', type: 'signature', required: true },
];

export interface PodFileRef {
  fieldKey: string;
  key: string;
  sha256: string;
  mime: string;
  bytes: number;
}

export interface PodForm {
  templateId: ObjectId | null;
  version: number;
  fields: PodField[];
  extraSteps: string[];
}

export async function podFormFor(db: Db, d: DeliveryOrderDoc): Promise<PodForm> {
  const tpl = await resolvePodTemplate(db, d.clientId, d.jobGroupId);
  if (!tpl) return { templateId: null, version: 0, fields: DEFAULT_POD_FIELDS, extraSteps: [] };
  return { templateId: tpl._id, version: tpl.version ?? 0, fields: tpl.fields, extraSteps: tpl.extraSteps };
}

const issue = (code: string, key: string, message: string): Issue => ({ code, message, details: { field: key } });
const missing = (v: unknown) => v === undefined || v === null || v === '';

export function validatePodAnswers(fields: PodField[], answers: Record<string, unknown>, files: PodFileRef[], outcome: 'DELIVERED' | 'FAILED'): Issue[] {
  const issues: Issue[] = [];
  const enforce = outcome === 'DELIVERED';
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const key of Object.keys(answers)) {
    const f = byKey.get(key);
    if (!f || f.type === 'photo' || f.type === 'signature') issues.push(issue('UNKNOWN_FIELD', key, `${key} is not an answer field of this form`));
  }
  for (const file of files) {
    const f = byKey.get(file.fieldKey);
    if (!f || (f.type !== 'photo' && f.type !== 'signature')) issues.push(issue('FILE_FIELD_MISMATCH', file.fieldKey, `${file.fieldKey} is not a photo or signature field`));
  }
  for (const f of fields) {
    const v = answers[f.key];
    const n = files.filter((x) => x.fieldKey === f.key).length;
    switch (f.type) {
      case 'photo': {
        const min = enforce ? (f.min ?? (f.required ? 1 : 0)) : 0;
        const max = f.max ?? 10;
        if (n < min || n > max) issues.push(issue('PHOTO_COUNT', f.key, `${f.label}: ${n} photo(s), expected ${min}–${max}`));
        break;
      }
      case 'signature':
        if (n > 1 || (enforce && f.required && n !== 1)) issues.push(issue('SIGNATURE_COUNT', f.key, `${f.label}: exactly one signature is required`));
        break;
      case 'text':
        if (missing(v)) {
          if (enforce && f.required) issues.push(issue('FIELD_REQUIRED', f.key, `${f.label} is required`));
        } else if (typeof v !== 'string') issues.push(issue('INVALID_TYPE', f.key, `${f.label} must be text`));
        break;
      case 'number':
        if (missing(v)) {
          if (enforce && f.required) issues.push(issue('FIELD_REQUIRED', f.key, `${f.label} is required`));
        } else if (typeof v !== 'number' || !Number.isFinite(v)) issues.push(issue('INVALID_TYPE', f.key, `${f.label} must be a number`));
        else if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) issues.push(issue('OUT_OF_RANGE', f.key, `${f.label} must be between ${f.min ?? '−∞'} and ${f.max ?? '∞'}`));
        break;
      case 'select':
        if (missing(v)) {
          if (enforce && f.required) issues.push(issue('FIELD_REQUIRED', f.key, `${f.label} is required`));
        } else if (typeof v !== 'string' || !(f.options ?? []).includes(v)) issues.push(issue('INVALID_OPTION', f.key, `${f.label} must be one of the options`));
        break;
      case 'checkbox':
        if (v === undefined) {
          if (enforce && f.required) issues.push(issue('FIELD_REQUIRED', f.key, `${f.label} is required`));
        } else if (typeof v !== 'boolean') issues.push(issue('INVALID_TYPE', f.key, `${f.label} must be true or false`));
        break;
      case 'qtyLines':
      case 'palletLines': {
        const lineOk =
          f.type === 'qtyLines'
            ? (l: unknown) => !!l && typeof l === 'object' && typeof (l as { delivered?: unknown }).delivered === 'number' && (l as { delivered: number }).delivered >= 0
            : (l: unknown) => !!l && typeof l === 'object' && typeof (l as { type?: unknown }).type === 'string' && Number.isInteger((l as { qty?: unknown }).qty) && (l as { qty: number }).qty >= 0;
        if (v === undefined || (Array.isArray(v) && v.length === 0)) {
          if (enforce && f.required) issues.push(issue('FIELD_REQUIRED', f.key, `${f.label} is required`));
        } else if (!Array.isArray(v) || !v.every(lineOk)) issues.push(issue('INVALID_TYPE', f.key, `${f.label} has invalid lines`));
        break;
      }
    }
  }
  return issues;
}
```

- [ ] **Step 4: Extend shipment types/schemas and the driver list**

`src/modules/shipments/shipment.types.ts`: change `StopDoc.status` to `'PENDING' | 'ARRIVED' | 'WORKING' | 'DONE'`; add to `ShipmentDoc`: `closedAt?: Date | null; closedBy?: string | null; summaryId?: ObjectId | null;` (optional so existing creators compile).

`src/modules/shipments/shipment.schemas.ts` — in `ShipmentItem` add:
```ts
  closedAt: z.string().nullable().default(null),
  closedBy: z.string().nullable().default(null),
  summaryId: z.string().nullable().default(null),
```
and change the stop `status` schema to `z.enum(['PENDING', 'ARRIVED', 'WORKING', 'DONE'])`.

`src/modules/shipments/driver.routes.ts` — import `podFormFor` and `PodFieldSchema`-compatible output; define
```ts
const PodFormOut = z.object({
  templateId: z.string().nullable(),
  version: z.number(),
  extraSteps: z.array(z.string()),
  fields: z.array(z.object({ key: z.string(), label: z.string(), type: z.string(), required: z.boolean(), min: z.number().optional(), max: z.number().optional(), unit: z.string().optional(), options: z.array(z.string()).optional() })),
});
const DriverShipment = ShipmentItem.extend({ deliveryOrders: z.array(DoItem.extend({ podForm: PodFormOut })), locations: z.array(LocationLite) });
```
and in the list handler map each DO to `{ ...toApi(d), podForm: toApi(await podFormFor(app.db, d)) }` (resolve forms once per distinct `clientId|jobGroupId` pair with a small `Map` cache inside the request).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS (existing shipment tests still pass with the new nullable fields).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(pods): POD form validation, default form and POD form in the driver job list" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 4: Driver events (`POST /driver/events`) and shipment timeline

**Files:**
- Create: `src/modules/execution/events.service.ts`, `src/modules/execution/events.routes.ts`, `test/helpers/execution.ts`
- Modify: `src/db/collections.ts`, `src/db/indexes.ts`, `src/routes.ts`
- Test: `test/api/driver-events.test.ts`

**Interfaces:**
- Consumes: step rules, `gpsFlags`, `GpsFields`, `loadDriverShipment`, `driverIdOf`, `withTransaction`, `podFormFor` (for allowed extra steps).
- Produces:
  - `C.events`; indexes `events { clientEventId: 1 } unique`, `{ shipmentId: 1, deviceTime: 1 }`.
  - `interface EventDoc { _id; clientEventId; shipmentId; stopId: ObjectId | null; doId: ObjectId | null; code; reasonCode: string | null; note: string | null; deviceTime; receivedAt; lat; lng; accuracyM; noGpsReason; geofenceDistanceM: number | null; source: 'app'; by: string; flags: string[] }`.
  - `recordDriverEvent(app, by: string, driverId: ObjectId, input: EventInput): Promise<EventResult>` where `EventResult = { clientEventId: string; status: 'accepted' | 'duplicate' | 'rejected'; eventId: string | null; flags: string[]; code?: string; message?: string }`.
  - Effects of an accepted event (one transaction): event inserted; stop `status` updated via `stopStatusFrom`; shipment `ACCEPTED → IN_TRANSIT` on the first event; `version` incremented; on `LOAD_END` every DO picked up at that stop moves `PLANNED → PICKED_UP`.
  - `POST /driver/events` body `{ events: EventInput[] }` (1–100) → `{ results: EventResult[] }` (always 200; each event handled in order).
  - `EventInput = { clientEventId: uuid, shipmentId, stopId?: id | null, code: EventCode, reasonCode?: ReasonCode | null, note?: string | null } & GpsFields`. `EXCEPTION` requires `reasonCode`; `reasonCode: 'OTHER'` requires `note`.
  - `GET /shipments/:id/events` (staff) → `{ items: EventItem[] }` ordered by `deviceTime`.
  - Test helpers `acceptedShipment(app, f, opts?)` (creates DO(s), shipment on M1/D1, plans, dispatches, accepts; returns `{ shipment, dos }`) and `tap(app, f, shipment, stopIndex, code, extra?)`.

- [ ] **Step 1: Write the test helpers**

`test/helpers/execution.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { App } from '../../src/app.js';
import { type PlanningFixtures, createDo, postShipment } from './planning.js';

type H = { authorization: string };
const post = (app: App, url: string, h: H, payload: object) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });

export const at = (hhmm: string, day = '2026-10-05') => `${day}T${hhmm}:00+07:00`;
export const gps = (lat = 14.53, lng = 100.91, time = at('08:00')) => ({ lat, lng, accuracyM: 8, deviceTime: time });

export async function acceptedShipment(app: App, f: PlanningFixtures, opts: { doOverrides?: object[]; day?: string } = {}) {
  const day = opts.day ?? '2026-10-05';
  const dos = [];
  for (const o of opts.doOverrides ?? [{}]) dos.push(await createDo(app, f, o));
  const created = (await postShipment(app, f, { plannedStart: `${day}T06:00:00+07:00`, plannedEnd: `${day}T18:00:00+07:00`, head: { vehicleId: f.ids.m1, driverId: f.ids.d1 }, doIds: dos.map((d) => d.id) })).json();
  const planned = (await post(app, `/shipments/${created.id}/plan`, f.planner, { version: 1 })).json();
  const dispatched = (await post(app, `/shipments/${created.id}/dispatch`, f.planner, { version: planned.version })).json();
  const shipment = (await post(app, `/driver/shipments/${created.id}/accept`, f.driver1, { version: dispatched.version })).json();
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
  return res.json().results[0] as { status: string; code?: string; flags: string[]; eventId: string | null };
}
```

- [ ] **Step 2: Write the failing test**

`test/api/driver-events.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { acceptedShipment, at, gps, tap } from '../helpers/execution.js';
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
    expect((await tap(app, f, shipment, 0, 'ARRIVED')).status).toBe('accepted');
    const sh1 = await app.db.collection(C.shipments).findOne({ shipmentNo: shipment.shipmentNo });
    expect(sh1).toMatchObject({ status: 'IN_TRANSIT' });
    expect(sh1?.stops[0].status).toBe('ARRIVED');
    expect((await tap(app, f, shipment, 0, 'LOAD_END')).code).toBe('EVENT_OUT_OF_ORDER');
    expect((await tap(app, f, shipment, 0, 'LOAD_START')).status).toBe('accepted');
    expect((await tap(app, f, shipment, 0, 'LOAD_END')).status).toBe('accepted');
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo })).toMatchObject({ status: 'PICKED_UP' });
    expect((await tap(app, f, shipment, 1, 'ARRIVED')).code).toBe('PREVIOUS_STOP_OPEN');
    expect((await tap(app, f, shipment, 0, 'DEPARTED')).status).toBe('accepted');
    const drop = await tap(app, f, shipment, 1, 'ARRIVED');
    expect(drop.status).toBe('accepted');
    expect(drop.flags).toContain('OUTSIDE_GEOFENCE'); // gps() is at plant A, stop 1 is site B
    expect((await tap(app, f, shipment, 1, 'UNLOAD_START')).status).toBe('accepted');
    expect((await tap(app, f, shipment, 1, 'UNLOAD_END')).status).toBe('accepted');
    const dep = await tap(app, f, shipment, 1, 'DEPARTED');
    expect(dep.code).toBe('POD_REQUIRED');
    const timeline = await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}/events`, headers: f.viewer });
    expect(timeline.json().items.map((e: { code: string }) => e.code)).toEqual(['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED', 'ARRIVED', 'UNLOAD_START', 'UNLOAD_END']);
  });

  it('stores a replayed batch once and flags late sync', async () => {
    const { shipment } = await acceptedShipment(app, f, { day: '2026-10-06' });
    const events = [
      { clientEventId: randomUUID(), shipmentId: shipment.id, stopId: shipment.stops[0].stopId, code: 'ARRIVED', ...gps(14.53, 100.91, at('06:30', '2026-10-06')) },
      { clientEventId: randomUUID(), shipmentId: shipment.id, stopId: shipment.stops[0].stopId, code: 'LOAD_START', ...gps(14.53, 100.91, at('06:40', '2026-10-06')) },
    ];
    const send = () => app.inject({ method: 'POST', url: '/api/v1/driver/events', headers: f.driver1, payload: { events } });
    const first = (await send()).json().results;
    expect(first.map((r: { status: string }) => r.status)).toEqual(['accepted', 'accepted']);
    expect(first[0].flags).toContain('LATE_SYNC');
    const again = (await send()).json().results;
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
    expect(other.json().results[0]).toMatchObject({ status: 'rejected', code: 'NOT_FOUND' });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/api/driver-events.test.ts`
Expected: FAIL — `/driver/events` 404.

- [ ] **Step 4: Implement the service**

Add `events: 'events'` to `C`; add indexes `[C.events]: [{ key: { clientEventId: 1 }, unique: true }, { key: { shipmentId: 1, deviceTime: 1 } }]`.

`src/modules/execution/events.service.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { AppError, notFound, unprocessable } from '../../lib/errors.js';
import { gpsFlags } from '../../lib/geo.js';
import { GpsFields } from '../../lib/gps.js';
import { objectIdString } from '../../lib/ids.js';
import { withTransaction } from '../../lib/tx.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import { podFormFor } from '../pods/pod-validation.js';
import { loadDriverShipment } from '../storage/uploads.routes.js';
import type { ShipmentDoc } from '../shipments/shipment.types.js';
import {
  EVENT_CODES, EXTRA_EVENTS, GLOBAL_EVENTS, REASON_CODES, STOP_EVENTS,
  type ExtraEventCode, type StopEventCode, checkExtraEvent, checkStopEvent, stopStatusFrom,
} from './event-rules.js';

export const EventInput = z
  .object({
    clientEventId: z.string().uuid(),
    shipmentId: objectIdString,
    stopId: objectIdString.nullable().default(null),
    code: z.enum(EVENT_CODES),
    reasonCode: z.enum(REASON_CODES).nullable().default(null),
    note: z.string().trim().max(500).nullable().default(null),
  })
  .and(GpsFields);
export type EventInputT = z.infer<typeof EventInput>;

export interface EventDoc {
  _id: ObjectId;
  clientEventId: string;
  shipmentId: ObjectId;
  stopId: ObjectId | null;
  doId: ObjectId | null;
  code: string;
  reasonCode: string | null;
  note: string | null;
  deviceTime: Date;
  receivedAt: Date;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  noGpsReason: string | null;
  geofenceDistanceM: number | null;
  source: 'app';
  by: string;
  flags: string[];
}

export interface EventResult {
  clientEventId: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  eventId: string | null;
  flags: string[];
  code?: string;
  message?: string;
}

const DONE_POD: DeliveryOrderDoc['status'][] = ['DELIVERED', 'FAILED', 'POD_VERIFIED', 'POD_REJECTED'];

export async function recordDriverEvent(app: FastifyInstance, by: string, driverId: ObjectId, input: EventInputT): Promise<EventResult> {
  const base = { clientEventId: input.clientEventId, flags: [] as string[] };
  const events = app.db.collection<EventDoc>(C.events);
  const existing = await events.findOne({ clientEventId: input.clientEventId });
  if (existing) return { ...base, status: 'duplicate', eventId: existing._id.toHexString(), flags: existing.flags };
  try {
    const shipment = await loadDriverShipment(app.db, new ObjectId(input.shipmentId), driverId);
    if (shipment.status !== 'ACCEPTED' && shipment.status !== 'IN_TRANSIT') {
      throw unprocessable('SHIPMENT_NOT_ACTIVE', `Cannot record events on a ${shipment.status} shipment`);
    }
    if (input.code === 'EXCEPTION' && !input.reasonCode) throw unprocessable('REASON_REQUIRED', 'Choose a reason for the exception');
    if (input.reasonCode === 'OTHER' && !input.note) throw unprocessable('NOTE_REQUIRED', 'Describe the reason');

    const isGlobal = (GLOBAL_EVENTS as readonly string[]).includes(input.code);
    const stopIndex = input.stopId ? shipment.stops.findIndex((s) => s.stopId.toHexString() === input.stopId) : -1;
    if (!isGlobal && stopIndex === -1) throw unprocessable('STOP_REQUIRED', 'Choose the stop for this step');
    const stop = stopIndex >= 0 ? shipment.stops[stopIndex]! : null;

    let target: { lat: number; lng: number; radiusM: number } | undefined;
    const doneAt = async (stopId: ObjectId) =>
      new Set((await events.find({ shipmentId: shipment._id, stopId }, { projection: { code: 1 } }).toArray()).map((e) => e.code));

    let doneAfter: Set<string> | null = null;
    if (stop) {
      const loc = await app.db.collection(C.locations).findOne({ _id: stop.locationId });
      if (loc) target = { lat: loc.geo.coordinates[1], lng: loc.geo.coordinates[0], radiusM: loc.geofenceRadiusM };
      const done = await doneAt(stop.stopId);
      const drops = await app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).find({ _id: { $in: stop.dropDoIds } }).toArray();
      const state = { hasDrops: stop.dropDoIds.length > 0, hasPickups: stop.pickupDoIds.length > 0, done, allDropsHavePod: drops.every((d) => DONE_POD.includes(d.status)) };
      let problem;
      if ((STOP_EVENTS as readonly string[]).includes(input.code)) {
        const prev = stopIndex > 0 ? shipment.stops[stopIndex - 1]! : null;
        const prevDeparted = prev ? (await doneAt(prev.stopId)).has('DEPARTED') : true;
        problem = checkStopEvent(state, input.code as StopEventCode, prevDeparted);
      } else if ((EXTRA_EVENTS as readonly string[]).includes(input.code)) {
        const related = await app.db
          .collection<DeliveryOrderDoc>(C.deliveryOrders)
          .find({ _id: { $in: [...stop.dropDoIds, ...stop.pickupDoIds] } })
          .toArray();
        const allowed = new Set<string>();
        for (const d of related) for (const s of (await podFormFor(app.db, d)).extraSteps) allowed.add(s);
        problem = checkExtraEvent(state, input.code as ExtraEventCode, [...allowed]);
      }
      if (problem) throw unprocessable(problem.code, problem.message, problem.details);
      doneAfter = new Set([...done, input.code]);
    }

    const receivedAt = new Date();
    const deviceTime = new Date(input.deviceTime);
    const { flags, distanceM } = gpsFlags({ lat: input.lat, lng: input.lng, accuracyM: input.accuracyM, deviceTime, receivedAt, target });
    const doc: EventDoc = {
      _id: new ObjectId(),
      clientEventId: input.clientEventId,
      shipmentId: shipment._id,
      stopId: stop?.stopId ?? null,
      doId: null,
      code: input.code,
      reasonCode: input.reasonCode,
      note: input.note,
      deviceTime,
      receivedAt,
      lat: input.lat,
      lng: input.lng,
      accuracyM: input.accuracyM,
      noGpsReason: input.noGpsReason,
      geofenceDistanceM: distanceM,
      source: 'app',
      by,
      flags,
    };
    await withTransaction(app.mongo, async (session) => {
      await events.insertOne(doc, { session });
      const set: Record<string, unknown> = { updatedAt: receivedAt, updatedBy: by };
      if (shipment.status === 'ACCEPTED') set.status = 'IN_TRANSIT';
      if (stop && doneAfter) set[`stops.${stopIndex}.status`] = stopStatusFrom(doneAfter);
      const res = await app.db
        .collection<ShipmentDoc>(C.shipments)
        .updateOne({ _id: shipment._id, status: { $in: ['ACCEPTED', 'IN_TRANSIT'] } }, { $set: set, $inc: { version: 1 } }, { session });
      if (res.matchedCount === 0) throw unprocessable('SHIPMENT_NOT_ACTIVE', 'The shipment changed; reload');
      if (stop && input.code === 'LOAD_END' && stop.pickupDoIds.length > 0) {
        await app.db
          .collection<DeliveryOrderDoc>(C.deliveryOrders)
          .updateMany({ _id: { $in: stop.pickupDoIds }, status: 'PLANNED' }, { $set: { status: 'PICKED_UP', updatedAt: receivedAt, updatedBy: by } }, { session });
      }
    });
    return { ...base, status: 'accepted', eventId: doc._id.toHexString(), flags };
  } catch (e) {
    if ((e as { code?: unknown }).code === 11000) {
      const dup = await events.findOne({ clientEventId: input.clientEventId });
      return { ...base, status: 'duplicate', eventId: dup?._id.toHexString() ?? null, flags: dup?.flags ?? [] };
    }
    if (e instanceof AppError) return { ...base, status: 'rejected', eventId: null, code: e.code, message: e.message };
    throw e;
  }
}

export { notFound };
```

Note: `updateMany` of DOs inside the transaction is allowed (only `bulkWrite`/`insertMany` are banned).

- [ ] **Step 5: Implement the routes**

`src/modules/execution/events.routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { IdParams } from '../../lib/ids.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import { driverIdOf } from '../storage/uploads.routes.js';
import { type EventDoc, EventInput, recordDriverEvent } from './events.service.js';

const EventResultSchema = z.object({
  clientEventId: z.string(),
  status: z.enum(['accepted', 'duplicate', 'rejected']),
  eventId: z.string().nullable(),
  flags: z.array(z.string()),
  code: z.string().optional(),
  message: z.string().optional(),
});

const EventItem = z.object({
  id: z.string(), clientEventId: z.string(), shipmentId: z.string(), stopId: z.string().nullable(), code: z.string(),
  reasonCode: z.string().nullable(), note: z.string().nullable(), deviceTime: z.string(), receivedAt: z.string(),
  lat: z.number().nullable(), lng: z.number().nullable(), accuracyM: z.number().nullable(), geofenceDistanceM: z.number().nullable(),
  by: z.string(), flags: z.array(z.string()),
});

export const eventRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/driver/events',
    { schema: { tags: ['driver'], body: z.object({ events: z.array(EventInput).min(1).max(100) }), response: { 200: z.object({ results: z.array(EventResultSchema) }) } }, preHandler: app.requireRoles('driver') },
    async (req) => {
      const driverId = driverIdOf(req);
      const by = actorOf(req);
      const results = [];
      for (const e of req.body.events) results.push(await recordDriverEvent(app, by, driverId, e));
      return { results };
    },
  );

  app.get(
    '/shipments/:id/events',
    { schema: { tags: ['shipments'], params: IdParams, response: { 200: z.object({ items: z.array(EventItem) }) } }, preHandler: app.requireRoles(...STAFF_ROLES) },
    async (req) => {
      const id = new ObjectId(req.params.id);
      if (!(await app.db.collection(C.shipments).countDocuments({ _id: id }, { limit: 1 }))) throw notFound('Shipment');
      const items = await app.db.collection<EventDoc>(C.events).find({ shipmentId: id }).sort({ deviceTime: 1, receivedAt: 1 }).limit(1000).toArray();
      return { items: items.map(toApi) };
    },
  );
};
```

Map a `notFound` thrown by `loadDriverShipment` to `code: 'NOT_FOUND'` (it already has that code). Register `eventRoutes` in `src/routes.ts`. Remove the stray `export { notFound }` line at the end of the service if typecheck flags it as unused.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(execution): idempotent driver step events with GPS flags and shipment timeline" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 5: POD submission (`POST /driver/pods`)

**Files:**
- Create: `src/modules/pods/pods.service.ts`, `src/modules/pods/pods.routes.ts`
- Modify: `src/db/collections.ts`, `src/db/indexes.ts`, `src/routes.ts`, `src/modules/orders/order.types.ts`, `test/helpers/execution.ts`
- Test: `test/api/pods-submit.test.ts`

**Interfaces:**
- Consumes: `validatePodAnswers`, `podFormFor`, `gpsFlags`, `canonicalJson`, `sha256Hex`, `app.storage`, `loadDriverShipment`, `driverIdOf`.
- Produces:
  - `C.pods`; indexes `pods { clientPodId: 1 } unique`, `{ doId: 1, receivedAt: -1 }`, `{ status: 1, receivedAt: 1 }`, `{ shipmentId: 1 }`.
  - `DeliveryOrderDoc.attempts: { shipmentId: ObjectId; reasonCode: string; podId: ObjectId; at: Date }[]` (optional; `$push` on failed PODs).
  - `interface PodDoc { _id; clientPodId; doId; shipmentId; stopId; templateId: ObjectId | null; templateVersion: number; outcome: 'DELIVERED' | 'FAILED'; reasonCode: string | null; note: string | null; answers; files: PodFileRef[]; evidence: { deviceTime; receivedAt; lat; lng; accuracyM; noGpsReason; geofenceDistanceM; device: string | null; appVersion: string | null; offline: boolean }; hash: string; flags: string[]; status: 'submitted' | 'verified' | 'rejected'; review: { by: string; at: Date; reason: string | null } | null; supersedesPodId: ObjectId | null; by: string }`.
  - `submitPod(app, by, driverId, input): Promise<{ pod: PodDoc; duplicate: boolean }>`; errors (422): `SHIPMENT_NOT_ACTIVE`, `DO_NOT_READY` (DELIVERED needs DO `PICKED_UP` or `POD_REJECTED`; FAILED needs `PLANNED`, `PICKED_UP` or `POD_REJECTED`), `STEP_REQUIRED` (DELIVERED needs `UNLOAD_END` at the drop stop; FAILED needs `ARRIVED` at the drop stop), `REASON_REQUIRED`, `NOTE_REQUIRED`, `POD_INVALID` (details = form issues), `FILE_KEY_INVALID`, `FILE_MISSING`, `FILE_HASH_MISMATCH`, `FILE_TOO_LARGE`, `FILE_TYPE_INVALID`.
  - Effects (one transaction): pod inserted; DO → `DELIVERED` / `FAILED` (+ `attempts` push); `supersedesPodId` = previous latest pod of the DO when it was `rejected`; shipment `IN_TRANSIT → COMPLETED` when every DO of the shipment is in `DELIVERED | FAILED | POD_VERIFIED | POD_REJECTED` (version +1).
  - Route `POST /driver/pods` → 201 `PodItem` (200 with the original pod when `clientPodId` was already used).
  - `PodItem` zod schema (API shape of `PodDoc`, dates as strings) exported for Task 6.
  - Test helpers `uploadPhoto(app, f, shipmentId, doId, content?) → { key, sha256, mime, bytes }` (presign + `MemoryStorage.put`) and `deliveredPod(app, f, shipment, doc, extra?)`.

- [ ] **Step 1: Extend the test helpers**

Append to `test/helpers/execution.ts`:
```ts
import { createHash } from 'node:crypto';
import type { MemoryStorage } from '../../src/modules/storage/storage.js';

export async function uploadPhoto(app: App, f: PlanningFixtures, shipmentId: string, doId: string, content = `photo-${randomUUID()}`) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/uploads/presign', headers: f.driver1, payload: { shipmentId, doId, contentType: 'image/jpeg' } });
  const { key } = res.json();
  const body = Buffer.from(content);
  await (app.storage as MemoryStorage).put(key, body, 'image/jpeg');
  return { key, sha256: createHash('sha256').update(body).digest('hex'), mime: 'image/jpeg', bytes: body.length };
}

export async function deliveredPod(app: App, f: PlanningFixtures, shipment: { id: string }, d: { id: string }, extra: object = {}) {
  const photo = await uploadPhoto(app, f, shipment.id, d.id);
  const sign = await uploadPhoto(app, f, shipment.id, d.id, 'signature');
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
```

- [ ] **Step 2: Write the failing test**

`test/api/pods-submit.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import type { MemoryStorage } from '../../src/modules/storage/storage.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { acceptedShipment, at, deliveredPod, gps, tap, toDropStop, uploadPhoto } from '../helpers/execution.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

describe('POD submission', () => {
  let app: App;
  let f: PlanningFixtures;
  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('accepts a delivered POD, hashes it, and completes the shipment', async () => {
    const { shipment, dos } = await acceptedShipment(app, f);
    expect((await deliveredPod(app, f, shipment, dos[0])).json().code).toBe('STEP_REQUIRED');
    await toDropStop(app, f, shipment);
    const res = await deliveredPod(app, f, shipment, dos[0]);
    expect(res.statusCode).toBe(201);
    const pod = res.json();
    expect(pod).toMatchObject({ outcome: 'DELIVERED', status: 'submitted', templateId: null, templateVersion: 0, supersedesPodId: null });
    expect(pod.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(pod.evidence.geofenceDistanceM).toBeLessThan(300);
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo })).toMatchObject({ status: 'DELIVERED' });
    expect(await app.db.collection(C.shipments).findOne({ shipmentNo: shipment.shipmentNo })).toMatchObject({ status: 'COMPLETED' });
    expect((await tap(app, f, shipment, 1, 'DEPARTED')).status).toBe('rejected'); // shipment is COMPLETED
  });

  it('rejects incomplete forms and tampered or missing files', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-06' });
    await toDropStop(app, f, { ...shipment });
    const incomplete = await deliveredPod(app, f, shipment, dos[0], { answers: {} });
    expect(incomplete.json().code).toBe('POD_INVALID');
    const photo = await uploadPhoto(app, f, shipment.id, dos[0].id);
    const sign = await uploadPhoto(app, f, shipment.id, dos[0].id, 'sig');
    await (app.storage as MemoryStorage).put(photo.key, Buffer.from('swapped'), 'image/jpeg');
    const tampered = await app.inject({
      method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1,
      payload: { clientPodId: randomUUID(), doId: dos[0].id, outcome: 'DELIVERED', answers: { receiverName: 'x' }, files: [{ fieldKey: 'goodsPhoto', ...photo }, { fieldKey: 'receiverSign', ...sign }], ...gps(13.75, 100.5, at('11:00', '2026-10-06')) },
    });
    expect(tampered.json().code).toBe('FILE_HASH_MISMATCH');
    const foreign = await deliveredPod(app, f, shipment, dos[0], { files: [{ fieldKey: 'goodsPhoto', key: 'pods/other/x.jpg', sha256: 'a'.repeat(64), mime: 'image/jpeg', bytes: 1 }] });
    expect(foreign.json().code).toBe('FILE_KEY_INVALID');
    expect(await app.db.collection(C.pods).countDocuments({ doId: (await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo }))!._id })).toBe(0);
  });

  it('records a failed delivery with a reason and returns the same POD on replay', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-07' });
    for (const code of ['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED']) await tap(app, f, shipment, 0, code);
    await tap(app, f, shipment, 1, 'ARRIVED', gps(13.75, 100.5, at('10:00', '2026-10-07')));
    const payload = { clientPodId: randomUUID(), doId: dos[0].id, outcome: 'FAILED', answers: {}, files: [], ...gps(13.75, 100.5, at('10:05', '2026-10-07')) };
    const noReason = await app.inject({ method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1, payload });
    expect(noReason.json().code).toBe('REASON_REQUIRED');
    const failed = await app.inject({ method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1, payload: { ...payload, reasonCode: 'CONSIGNEE_CLOSED' } });
    expect(failed.statusCode).toBe(201);
    const replay = await app.inject({ method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1, payload: { ...payload, reasonCode: 'CONSIGNEE_CLOSED' } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(failed.json().id);
    const d = await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo });
    expect(d).toMatchObject({ status: 'FAILED' });
    expect(d?.attempts).toHaveLength(1);
    expect(await app.db.collection(C.shipments).findOne({ shipmentNo: shipment.shipmentNo })).toMatchObject({ status: 'COMPLETED' });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/api/pods-submit.test.ts`
Expected: FAIL — `/driver/pods` 404.

- [ ] **Step 4: Implement the service**

Add `pods: 'pods'` to `C`; add the pod indexes. In `order.types.ts` add `attempts?: { shipmentId: ObjectId; reasonCode: string; podId: ObjectId; at: Date }[];` to `DeliveryOrderDoc`.

`src/modules/pods/pods.service.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { canonicalJson, sha256Hex } from '../../lib/canonical.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { gpsFlags } from '../../lib/geo.js';
import { GpsFields } from '../../lib/gps.js';
import { objectIdString } from '../../lib/ids.js';
import { withTransaction } from '../../lib/tx.js';
import { REASON_CODES } from '../execution/event-rules.js';
import type { EventDoc } from '../execution/events.service.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import { doIdsOf } from '../shipments/shipment.service.js';
import type { ShipmentDoc } from '../shipments/shipment.types.js';
import { UPLOAD_TYPES, loadDriverShipment } from '../storage/uploads.routes.js';
import { type PodFileRef, podFormFor, validatePodAnswers } from './pod-validation.js';

export const PodInput = z
  .object({
    clientPodId: z.string().uuid(),
    doId: objectIdString,
    outcome: z.enum(['DELIVERED', 'FAILED']),
    reasonCode: z.enum(REASON_CODES).nullable().default(null),
    note: z.string().trim().max(500).nullable().default(null),
    answers: z.record(z.unknown()).default({}),
    files: z.array(z.object({ fieldKey: z.string(), key: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/), mime: z.string(), bytes: z.number().int().min(0) })).max(30).default([]),
    device: z.string().max(100).nullable().default(null),
    appVersion: z.string().max(30).nullable().default(null),
    offline: z.boolean().default(false),
  })
  .and(GpsFields);
export type PodInputT = z.infer<typeof PodInput>;

export interface PodDoc {
  _id: ObjectId;
  clientPodId: string;
  doId: ObjectId;
  shipmentId: ObjectId;
  stopId: ObjectId;
  templateId: ObjectId | null;
  templateVersion: number;
  outcome: 'DELIVERED' | 'FAILED';
  reasonCode: string | null;
  note: string | null;
  answers: Record<string, unknown>;
  files: PodFileRef[];
  evidence: {
    deviceTime: Date; receivedAt: Date; lat: number | null; lng: number | null; accuracyM: number | null;
    noGpsReason: string | null; geofenceDistanceM: number | null; device: string | null; appVersion: string | null; offline: boolean;
  };
  hash: string;
  flags: string[];
  status: 'submitted' | 'verified' | 'rejected';
  review: { by: string; at: Date; reason: string | null } | null;
  supersedesPodId: ObjectId | null;
  by: string;
}

export const DONE_FOR_COMPLETION: DeliveryOrderDoc['status'][] = ['DELIVERED', 'FAILED', 'POD_VERIFIED', 'POD_REJECTED'];

export async function submitPod(app: FastifyInstance, by: string, driverId: ObjectId, input: PodInputT): Promise<{ pod: PodDoc; duplicate: boolean }> {
  const pods = app.db.collection<PodDoc>(C.pods);
  const dup = await pods.findOne({ clientPodId: input.clientPodId });
  if (dup) return { pod: dup, duplicate: true };

  const d = await app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).findOne({ _id: new ObjectId(input.doId) });
  if (!d || !d.shipmentId) throw notFound('Delivery order');
  const shipment = await loadDriverShipment(app.db, d.shipmentId, driverId);
  if (shipment.status !== 'IN_TRANSIT' && shipment.status !== 'COMPLETED') throw unprocessable('SHIPMENT_NOT_ACTIVE', `Cannot submit a POD on a ${shipment.status} shipment`);

  const allowed: DeliveryOrderDoc['status'][] = input.outcome === 'DELIVERED' ? ['PICKED_UP', 'POD_REJECTED'] : ['PLANNED', 'PICKED_UP', 'POD_REJECTED'];
  if (!allowed.includes(d.status)) throw unprocessable('DO_NOT_READY', `A ${d.status} delivery order cannot take a ${input.outcome} POD`);
  const stop = shipment.stops.find((s) => s.dropDoIds.some((id) => id.equals(d._id)))!;
  const done = new Set(
    (await app.db.collection<EventDoc>(C.events).find({ shipmentId: shipment._id, stopId: stop.stopId }, { projection: { code: 1 } }).toArray()).map((e) => e.code),
  );
  const needed = input.outcome === 'DELIVERED' ? 'UNLOAD_END' : 'ARRIVED';
  if (!done.has(needed)) throw unprocessable('STEP_REQUIRED', `Record ${needed} at the drop stop first`);
  if (input.outcome === 'FAILED' && !input.reasonCode) throw unprocessable('REASON_REQUIRED', 'Choose why the delivery failed');
  if (input.reasonCode === 'OTHER' && !input.note) throw unprocessable('NOTE_REQUIRED', 'Describe the reason');

  const form = await podFormFor(app.db, d);
  const formIssues = validatePodAnswers(form.fields, input.answers, input.files, input.outcome);
  if (formIssues.length > 0) throw unprocessable('POD_INVALID', 'The POD form is incomplete or invalid', { issues: formIssues });

  const prefix = `pods/${shipment._id.toHexString()}/${d._id.toHexString()}/`;
  for (const file of input.files) {
    if (!file.key.startsWith(prefix)) throw unprocessable('FILE_KEY_INVALID', `${file.key} does not belong to this delivery order`);
    if (!(file.mime in UPLOAD_TYPES)) throw unprocessable('FILE_TYPE_INVALID', `${file.mime} is not an allowed image type`);
    const stored = await app.storage.get(file.key);
    if (!stored) throw unprocessable('FILE_MISSING', `${file.key} was not uploaded`);
    if (stored.body.length > app.config.UPLOAD_MAX_BYTES) throw unprocessable('FILE_TOO_LARGE', `${file.key} is larger than ${app.config.UPLOAD_MAX_BYTES} bytes`);
    if (sha256Hex(stored.body) !== file.sha256) throw unprocessable('FILE_HASH_MISMATCH', `${file.key} does not match its fingerprint`);
  }

  const loc = await app.db.collection(C.locations).findOne({ _id: stop.locationId });
  const receivedAt = new Date();
  const deviceTime = new Date(input.deviceTime);
  const { flags, distanceM } = gpsFlags({
    lat: input.lat, lng: input.lng, accuracyM: input.accuracyM, deviceTime, receivedAt,
    target: loc ? { lat: loc.geo.coordinates[1], lng: loc.geo.coordinates[0], radiusM: loc.geofenceRadiusM } : undefined,
  });
  const evidence = {
    deviceTime, receivedAt, lat: input.lat, lng: input.lng, accuracyM: input.accuracyM, noGpsReason: input.noGpsReason,
    geofenceDistanceM: distanceM, device: input.device, appVersion: input.appVersion, offline: input.offline,
  };
  const previous = await pods.find({ doId: d._id }).sort({ _id: -1 }).limit(1).next();
  const files = [...input.files].sort((a, b) => (a.key < b.key ? -1 : 1));
  const hash = sha256Hex(
    canonicalJson({
      doId: d._id.toHexString(), templateId: form.templateId?.toHexString() ?? null, templateVersion: form.version, outcome: input.outcome,
      reasonCode: input.reasonCode, answers: input.answers, files: files.map((x) => ({ key: x.key, sha256: x.sha256 })),
      evidence: { ...evidence, deviceTime: deviceTime.toISOString(), receivedAt: receivedAt.toISOString() },
    }),
  );
  const pod: PodDoc = {
    _id: new ObjectId(), clientPodId: input.clientPodId, doId: d._id, shipmentId: shipment._id, stopId: stop.stopId,
    templateId: form.templateId, templateVersion: form.version, outcome: input.outcome, reasonCode: input.reasonCode, note: input.note,
    answers: input.answers, files, evidence, hash, flags, status: 'submitted', review: null,
    supersedesPodId: previous?.status === 'rejected' ? previous._id : null, by,
  };

  try {
    await withTransaction(app.mongo, async (session) => {
      await pods.insertOne(pod, { session });
      const nextStatus = input.outcome === 'DELIVERED' ? 'DELIVERED' : 'FAILED';
      const update: Record<string, unknown> = { $set: { status: nextStatus, updatedAt: receivedAt, updatedBy: by } };
      if (input.outcome === 'FAILED') update.$push = { attempts: { shipmentId: shipment._id, reasonCode: input.reasonCode!, podId: pod._id, at: receivedAt } };
      const res = await app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).updateOne({ _id: d._id, status: d.status }, update, { session });
      if (res.matchedCount === 0) throw unprocessable('DO_NOT_READY', 'The delivery order changed; reload');
      const all = await app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).find({ _id: { $in: doIdsOf(shipment.stops) } }, { session }).toArray();
      if (shipment.status === 'IN_TRANSIT' && all.every((x) => DONE_FOR_COMPLETION.includes(x.status))) {
        await app.db
          .collection<ShipmentDoc>(C.shipments)
          .updateOne({ _id: shipment._id, status: 'IN_TRANSIT' }, { $set: { status: 'COMPLETED', updatedAt: receivedAt, updatedBy: by }, $inc: { version: 1 } }, { session });
      }
    });
  } catch (e) {
    if ((e as { code?: unknown }).code === 11000) {
      const again = await pods.findOne({ clientPodId: input.clientPodId });
      if (again) return { pod: again, duplicate: true };
    }
    throw e;
  }
  return { pod, duplicate: false };
}
```

- [ ] **Step 5: Implement the route and PodItem**

`src/modules/pods/pods.routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf } from '../../lib/audit.js';
import { toApi } from '../../lib/serialize.js';
import { driverIdOf } from '../storage/uploads.routes.js';
import { PodInput, submitPod } from './pods.service.js';

export const PodItem = z.object({
  id: z.string(), clientPodId: z.string(), doId: z.string(), shipmentId: z.string(), stopId: z.string(),
  templateId: z.string().nullable(), templateVersion: z.number(), outcome: z.enum(['DELIVERED', 'FAILED']),
  reasonCode: z.string().nullable(), note: z.string().nullable(), answers: z.record(z.unknown()),
  files: z.array(z.object({ fieldKey: z.string(), key: z.string(), sha256: z.string(), mime: z.string(), bytes: z.number() })),
  evidence: z.object({
    deviceTime: z.string(), receivedAt: z.string(), lat: z.number().nullable(), lng: z.number().nullable(), accuracyM: z.number().nullable(),
    noGpsReason: z.string().nullable(), geofenceDistanceM: z.number().nullable(), device: z.string().nullable(), appVersion: z.string().nullable(), offline: z.boolean(),
  }),
  hash: z.string(), flags: z.array(z.string()), status: z.enum(['submitted', 'verified', 'rejected']),
  review: z.object({ by: z.string(), at: z.string(), reason: z.string().nullable() }).nullable(),
  supersedesPodId: z.string().nullable(), by: z.string(),
});

export const podRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/driver/pods',
    { schema: { tags: ['driver'], body: PodInput, response: { 200: PodItem, 201: PodItem } }, preHandler: app.requireRoles('driver') },
    async (req, reply) => {
      const { pod, duplicate } = await submitPod(app, actorOf(req), driverIdOf(req), req.body);
      return reply.status(duplicate ? 200 : 201).send(toApi(pod));
    },
  );
};
```
Register `podRoutes` in `src/routes.ts`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(pods): POD submission with form rules, file fingerprints, GPS evidence and completion" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 6: POD review (list, detail with file links, verify, reject, resubmission)

**Files:**
- Modify: `src/modules/pods/pods.routes.ts`
- Test: `test/api/pods-review.test.ts`

**Interfaces:**
- Consumes: `PodDoc`, `PodItem`, `withTransaction`, `writeAudit`, `app.storage.presignGet`.
- Produces:
  - `GET /pods?status=&shipmentId=&doId=&flagged=true` (staff; paginated, oldest first) → `pageResponse(PodItem)`.
  - `GET /pods/:id` (staff) → `PodItem & { fileUrls: { key: string; url: string }[] }` (5-minute GET links).
  - `POST /pods/:id/verify` (admin) → pod `verified`; a DELIVERED pod moves its DO to `POD_VERIFIED`; a FAILED pod leaves the DO `FAILED`.
  - `POST /pods/:id/reject` (admin) `{ reason }` → pod `rejected`; DO → `POD_REJECTED` (only if this pod is the DO's latest).
  - Only a `submitted` pod can be verified/rejected (422 `POD_ALREADY_REVIEWED`); a superseded pod (not the DO's latest) → 422 `POD_SUPERSEDED`. Each writes one audit entry in the transaction.

- [ ] **Step 1: Write the failing test**

`test/api/pods-review.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { acceptedShipment, deliveredPod, toDropStop } from '../helpers/execution.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

describe('POD review', () => {
  let app: App;
  let f: PlanningFixtures;
  const post = (url: string, payload: object = {}) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: f.admin, payload });
  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('lists submitted PODs with file links and verifies them', async () => {
    const { shipment, dos } = await acceptedShipment(app, f);
    await toDropStop(app, f, shipment);
    const pod = (await deliveredPod(app, f, shipment, dos[0])).json();
    const queue = await app.inject({ method: 'GET', url: '/api/v1/pods?status=submitted', headers: f.viewer });
    expect(queue.json().items.map((p: { id: string }) => p.id)).toContain(pod.id);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/pods/${pod.id}`, headers: f.viewer });
    expect(detail.json().fileUrls).toHaveLength(2);
    expect((await app.inject({ method: 'POST', url: `/api/v1/pods/${pod.id}/verify`, headers: f.viewer })).statusCode).toBe(403);
    const verified = await post(`/pods/${pod.id}/verify`);
    expect(verified.json()).toMatchObject({ status: 'verified', review: { reason: null } });
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo })).toMatchObject({ status: 'POD_VERIFIED' });
    expect((await post(`/pods/${pod.id}/reject`, { reason: 'late' })).json().code).toBe('POD_ALREADY_REVIEWED');
    expect(await app.db.collection(C.auditLog).countDocuments({ entity: 'pod', entityId: pod.id })).toBe(1);
  });

  it('rejects a POD, accepts the resubmission as its successor', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-06' });
    await toDropStop(app, f, shipment);
    const first = (await deliveredPod(app, f, shipment, dos[0])).json();
    const rejected = await post(`/pods/${first.id}/reject`, { reason: 'รูปไม่ชัด' });
    expect(rejected.json()).toMatchObject({ status: 'rejected', review: { reason: 'รูปไม่ชัด' } });
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo })).toMatchObject({ status: 'POD_REJECTED' });
    const second = (await deliveredPod(app, f, shipment, dos[0])).json();
    expect(second.supersedesPodId).toBe(first.id);
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo })).toMatchObject({ status: 'DELIVERED' });
    expect((await post(`/pods/${first.id}/verify`)).json().code).toBe('POD_ALREADY_REVIEWED');
    expect((await post(`/pods/${second.id}/verify`)).json().status).toBe('verified');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/pods-review.test.ts`
Expected: FAIL — 404 routes.

- [ ] **Step 3: Implement**

Add to `podRoutes` (imports: `ObjectId`, `Filter` from mongodb; `C`; `writeAudit`; `notFound`, `unprocessable`; `IdParams`, `objectIdString`; `PageQuery`, `pageResponse`, `paginate`; `STAFF_ROLES`; `withTransaction`; `PodDoc`; `DeliveryOrderDoc`):
```ts
  const staff = app.requireRoles(...STAFF_ROLES);
  const admin = app.requireRoles('admin', 'planner'); // POD review: admin or planner (PO 2026-09-27)
  const pods = () => app.db.collection<PodDoc>(C.pods);
  const load = async (id: string) => {
    const p = await pods().findOne({ _id: new ObjectId(id) });
    if (!p) throw notFound('POD');
    return p;
  };

  app.get(
    '/pods',
    {
      schema: {
        tags: ['pods'],
        querystring: PageQuery.extend({
          status: z.enum(['submitted', 'verified', 'rejected']).optional(),
          shipmentId: objectIdString.optional(),
          doId: objectIdString.optional(),
          flagged: z.enum(['true', 'false']).optional(),
        }),
        response: { 200: pageResponse(PodItem) },
      },
      preHandler: staff,
    },
    async (req) => {
      const q = req.query;
      const filter: Filter<PodDoc> = {};
      if (q.status) filter.status = q.status;
      if (q.shipmentId) filter.shipmentId = new ObjectId(q.shipmentId);
      if (q.doId) filter.doId = new ObjectId(q.doId);
      if (q.flagged === 'true') filter['flags.0'] = { $exists: true };
      const page = await paginate(pods(), filter, q);
      return { items: page.items.map(toApi), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/pods/:id',
    { schema: { tags: ['pods'], params: IdParams, response: { 200: PodItem.extend({ fileUrls: z.array(z.object({ key: z.string(), url: z.string() })) }) } }, preHandler: staff },
    async (req) => {
      const p = await load(req.params.id);
      const fileUrls = [];
      for (const file of p.files) fileUrls.push({ key: file.key, url: await app.storage.presignGet(file.key, 300) });
      return { ...toApi(p), fileUrls };
    },
  );

  async function review(id: string, by: string, decision: 'verified' | 'rejected', reason: string | null) {
    const p = await load(id);
    if (p.status !== 'submitted') throw unprocessable('POD_ALREADY_REVIEWED', `This POD is already ${p.status}`);
    const latest = await pods().find({ doId: p.doId }).sort({ _id: -1 }).limit(1).next();
    if (!latest?._id.equals(p._id)) throw unprocessable('POD_SUPERSEDED', 'A newer POD exists for this delivery order');
    return withTransaction(app.mongo, async (session) => {
      const updated = await pods().findOneAndUpdate(
        { _id: p._id, status: 'submitted' },
        { $set: { status: decision, review: { by, at: new Date(), reason } } },
        { returnDocument: 'after', session },
      );
      if (!updated) throw unprocessable('POD_ALREADY_REVIEWED', 'This POD was reviewed meanwhile');
      const doStatus = decision === 'rejected' ? 'POD_REJECTED' : p.outcome === 'DELIVERED' ? 'POD_VERIFIED' : null;
      if (doStatus) {
        await app.db
          .collection<DeliveryOrderDoc>(C.deliveryOrders)
          .updateOne({ _id: p.doId }, { $set: { status: doStatus, updatedAt: new Date(), updatedBy: by } }, { session });
      }
      await writeAudit(app.db, { entity: 'pod', entityId: id, action: decision === 'verified' ? 'verify' : 'reject', by, after: { reason } }, { session });
      return updated;
    });
  }

  app.post('/pods/:id/verify', { schema: { tags: ['pods'], params: IdParams, response: { 200: PodItem } }, preHandler: admin }, async (req) =>
    toApi(await review(req.params.id, actorOf(req), 'verified', null)),
  );

  app.post(
    '/pods/:id/reject',
    { schema: { tags: ['pods'], params: IdParams, body: z.object({ reason: z.string().trim().min(3).max(500) }), response: { 200: PodItem } }, preHandler: admin },
    async (req) => toApi(await review(req.params.id, actorOf(req), 'rejected', req.body.reason)),
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(pods): POD review queue, detail links, verify/reject and resubmission" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 7: Pallet movements and balances

**Files:**
- Create: `src/modules/pallets/pallets.routes.ts`
- Modify: `src/db/collections.ts`, `src/db/indexes.ts`, `src/routes.ts`
- Test: `test/api/pallets.test.ts`

**Interfaces:**
- Produces:
  - `C.palletMovements`, `C.palletBalances`; indexes `palletMovements { clientEventId: 1 } unique (partial: clientEventId string)`, `{ vehicleId: 1, at: -1 }`; `palletBalances { vehicleId: 1 } unique`.
  - Movement doc `{ _id, clientEventId: string | null, vehicleId, driverId: ObjectId | null, shipmentId: ObjectId | null, doId: ObjectId | null, typeCode, sign, qty, remark, at: Date, lat, lng, accuracyM, flags, balanceAfter, source: 'app' | 'admin', by }`.
  - `POST /driver/pallet-movements` (driver) `{ movements: ({ clientEventId, shipmentId, doId?, typeCode, qty (int ≥ 1), remark? } & GpsFields)[] }` (1–50) → `{ results: { clientEventId, status: 'accepted'|'duplicate'|'rejected', balanceAfter: number | null, code?, message? }[] }`. The vehicle is the shipment's tail, else its head. Shipment must be ACCEPTED/IN_TRANSIT/COMPLETED.
  - `POST /pallet-movements` (admin correction) `{ vehicleId, typeCode, qty, remark }` → 201 movement.
  - `GET /pallet-balances?vehicleId=` (staff) → `{ items: { vehicleId, plate, balance, lastMovementAt }[] }`; `GET /pallet-movements?vehicleId=` (staff, paginated, newest first by `_id`).
  - Each movement: one transaction — upsert `palletBalances` with `$inc: { balance: sign × qty }` (returnDocument after) and insert the movement with `balanceAfter`.

- [ ] **Step 1: Write the failing test**

`test/api/pallets.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { acceptedShipment, gps } from '../helpers/execution.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

describe('pallets', () => {
  let app: App;
  let f: PlanningFixtures;
  let shipmentId: string;
  const move = (typeCode: string, qty: number, id = randomUUID()) => ({ clientEventId: id, shipmentId, typeCode, qty, ...gps() });
  const send = (movements: object[]) => app.inject({ method: 'POST', url: '/api/v1/driver/pallet-movements', headers: f.driver1, payload: { movements } });

  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
    shipmentId = (await acceptedShipment(app, f)).shipment.id;
  });
  afterAll(async () => closeTestApp(app));

  it('keeps a running balance per vehicle and is idempotent', async () => {
    const id = randomUUID();
    const res = (await send([move('RETURN_IN', 10, id), move('DEPOSIT', 3)])).json().results;
    expect(res.map((r: { balanceAfter: number }) => r.balanceAfter)).toEqual([10, 7]);
    expect((await send([move('RETURN_IN', 10, id)])).json().results[0].status).toBe('duplicate');
    expect((await send([move('NOPE', 1)])).json().results[0].code).toBe('INVALID_REFERENCE');
    const bal = await app.inject({ method: 'GET', url: `/api/v1/pallet-balances?vehicleId=${f.ids.m1}`, headers: f.viewer });
    expect(bal.json().items).toEqual([expect.objectContaining({ plate: '80-3001', balance: 7 })]);
  });

  it('serialises concurrent movements on the same vehicle', async () => {
    const before = (await app.inject({ method: 'GET', url: `/api/v1/pallet-balances?vehicleId=${f.ids.m1}`, headers: f.viewer })).json().items[0].balance;
    const results = await Promise.all(Array.from({ length: 5 }, () => send([move('RETURN_IN', 2)])));
    const afters = results.map((r) => r.json().results[0].balanceAfter).sort((a: number, b: number) => a - b);
    expect(afters).toEqual([before + 2, before + 4, before + 6, before + 8, before + 10]);
  });

  it('lets an admin correct the balance', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/pallet-movements', headers: f.admin, payload: { vehicleId: f.ids.m1, typeCode: 'DEPOSIT', qty: 1, remark: 'นับสต็อกจริง' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ source: 'admin', remark: 'นับสต็อกจริง' });
    const list = await app.inject({ method: 'GET', url: `/api/v1/pallet-movements?vehicleId=${f.ids.m1}`, headers: f.viewer });
    expect(list.json().items.length).toBeGreaterThanOrEqual(8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/pallets.test.ts`
Expected: FAIL — 404.

- [ ] **Step 3: Implement**

Add `palletMovements: 'palletMovements'`, `palletBalances: 'palletBalances'` to `C`; indexes:
```ts
  [C.palletMovements]: [
    { key: { clientEventId: 1 }, unique: true, partialFilterExpression: { clientEventId: { $type: 'string' } } },
    { key: { vehicleId: 1, at: -1 } },
  ],
  [C.palletBalances]: [{ key: { vehicleId: 1 }, unique: true }],
```

`src/modules/pallets/pallets.routes.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf, writeAudit } from '../../lib/audit.js';
import { AppError, notFound, unprocessable } from '../../lib/errors.js';
import { gpsFlags } from '../../lib/geo.js';
import { GpsFields } from '../../lib/gps.js';
import { objectIdString } from '../../lib/ids.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import { withTransaction } from '../../lib/tx.js';
import { driverIdOf, loadDriverShipment } from '../storage/uploads.routes.js';

interface MovementDoc {
  _id: ObjectId; clientEventId: string | null; vehicleId: ObjectId; driverId: ObjectId | null; shipmentId: ObjectId | null; doId: ObjectId | null;
  typeCode: string; sign: number; qty: number; remark: string | null; at: Date; lat: number | null; lng: number | null; accuracyM: number | null;
  flags: string[]; balanceAfter: number; source: 'app' | 'admin'; by: string;
}

const MovementItem = z.object({
  id: z.string(), clientEventId: z.string().nullable(), vehicleId: z.string(), driverId: z.string().nullable(), shipmentId: z.string().nullable(),
  doId: z.string().nullable(), typeCode: z.string(), sign: z.number(), qty: z.number(), remark: z.string().nullable(), at: z.string(),
  flags: z.array(z.string()), balanceAfter: z.number(), source: z.enum(['app', 'admin']), by: z.string(),
});

async function applyMovement(app: FastifyInstance, m: Omit<MovementDoc, '_id' | 'sign' | 'balanceAfter'>): Promise<MovementDoc> {
  const type = await app.db.collection(C.palletMovementTypes).findOne({ code: m.typeCode, active: true });
  if (!type) throw unprocessable('INVALID_REFERENCE', `Unknown pallet movement type ${m.typeCode}`, { field: 'typeCode' });
  const sign = type.sign as number;
  return withTransaction(app.mongo, async (session) => {
    const bal = await app.db.collection(C.palletBalances).findOneAndUpdate(
      { vehicleId: m.vehicleId },
      { $inc: { balance: sign * m.qty }, $set: { lastMovementAt: m.at } },
      { upsert: true, returnDocument: 'after', session },
    );
    const doc: MovementDoc = { ...m, _id: new ObjectId(), sign, balanceAfter: bal!.balance as number };
    await app.db.collection<MovementDoc>(C.palletMovements).insertOne(doc, { session });
    return doc;
  });
}

const DriverMovement = z
  .object({ clientEventId: z.string().uuid(), shipmentId: objectIdString, doId: objectIdString.nullable().default(null), typeCode: z.string().trim().min(1).max(40), qty: z.number().int().min(1), remark: z.string().trim().max(200).nullable().default(null) })
  .and(GpsFields);

export const palletRoutes: FastifyPluginAsyncZod = async (app) => {
  const staff = app.requireRoles(...STAFF_ROLES);
  const moves = () => app.db.collection<MovementDoc>(C.palletMovements);

  app.post(
    '/driver/pallet-movements',
    {
      schema: {
        tags: ['driver'],
        body: z.object({ movements: z.array(DriverMovement).min(1).max(50) }),
        response: { 200: z.object({ results: z.array(z.object({ clientEventId: z.string(), status: z.enum(['accepted', 'duplicate', 'rejected']), balanceAfter: z.number().nullable(), code: z.string().optional(), message: z.string().optional() })) }) },
      },
      preHandler: app.requireRoles('driver'),
    },
    async (req) => {
      const driverId = driverIdOf(req);
      const by = actorOf(req);
      const results = [];
      for (const m of req.body.movements) {
        const dup = await moves().findOne({ clientEventId: m.clientEventId });
        if (dup) {
          results.push({ clientEventId: m.clientEventId, status: 'duplicate' as const, balanceAfter: dup.balanceAfter });
          continue;
        }
        try {
          const sh = await loadDriverShipment(app.db, new ObjectId(m.shipmentId), driverId);
          if (!['ACCEPTED', 'IN_TRANSIT', 'COMPLETED'].includes(sh.status)) throw unprocessable('SHIPMENT_NOT_ACTIVE', `Cannot record pallets on a ${sh.status} shipment`);
          const vehicleId = sh.tail?.vehicleId ?? sh.head!.vehicleId;
          const at = new Date(m.deviceTime);
          const { flags } = gpsFlags({ lat: m.lat, lng: m.lng, accuracyM: m.accuracyM, deviceTime: at, receivedAt: new Date() });
          const doc = await applyMovement(app, {
            clientEventId: m.clientEventId, vehicleId, driverId, shipmentId: sh._id, doId: m.doId ? new ObjectId(m.doId) : null,
            typeCode: m.typeCode, qty: m.qty, remark: m.remark, at, lat: m.lat, lng: m.lng, accuracyM: m.accuracyM, flags, source: 'app', by,
          });
          results.push({ clientEventId: m.clientEventId, status: 'accepted' as const, balanceAfter: doc.balanceAfter });
        } catch (e) {
          if ((e as { code?: unknown }).code === 11000) {
            const again = await moves().findOne({ clientEventId: m.clientEventId });
            results.push({ clientEventId: m.clientEventId, status: 'duplicate' as const, balanceAfter: again?.balanceAfter ?? null });
          } else if (e instanceof AppError) {
            results.push({ clientEventId: m.clientEventId, status: 'rejected' as const, balanceAfter: null, code: e.code, message: e.message });
          } else throw e;
        }
      }
      return { results };
    },
  );

  app.post(
    '/pallet-movements',
    {
      schema: { tags: ['pallets'], body: z.object({ vehicleId: objectIdString, typeCode: z.string().trim().min(1).max(40), qty: z.number().int().min(1), remark: z.string().trim().min(3).max(200) }), response: { 201: MovementItem } },
      preHandler: app.requireRoles('admin'),
    },
    async (req, reply) => {
      const vehicleId = new ObjectId(req.body.vehicleId);
      if (!(await app.db.collection(C.vehicles).countDocuments({ _id: vehicleId }, { limit: 1 }))) throw notFound('Vehicle');
      const by = actorOf(req);
      const doc = await applyMovement(app, {
        clientEventId: null, vehicleId, driverId: null, shipmentId: null, doId: null, typeCode: req.body.typeCode, qty: req.body.qty,
        remark: req.body.remark, at: new Date(), lat: null, lng: null, accuracyM: null, flags: [], source: 'admin', by,
      });
      await writeAudit(app.db, { entity: 'palletMovement', entityId: doc._id.toHexString(), action: 'correct', by, after: toApi(doc) });
      return reply.status(201).send(toApi(doc));
    },
  );

  app.get(
    '/pallet-balances',
    { schema: { tags: ['pallets'], querystring: z.object({ vehicleId: objectIdString.optional() }), response: { 200: z.object({ items: z.array(z.object({ vehicleId: z.string(), plate: z.string(), balance: z.number(), lastMovementAt: z.string().nullable() })) }) } }, preHandler: staff },
    async (req) => {
      const f: Filter<{ vehicleId: ObjectId }> = req.query.vehicleId ? { vehicleId: new ObjectId(req.query.vehicleId) } : {};
      const bals = await app.db.collection(C.palletBalances).find(f).limit(2000).toArray();
      const vehicles = await app.db.collection(C.vehicles).find({ _id: { $in: bals.map((b) => b.vehicleId as ObjectId) } }, { projection: { plate: 1 } }).toArray();
      const plate = new Map(vehicles.map((v) => [v._id.toHexString(), v.plate as string]));
      return {
        items: bals.map((b) => ({
          vehicleId: (b.vehicleId as ObjectId).toHexString(), plate: plate.get((b.vehicleId as ObjectId).toHexString()) ?? '',
          balance: b.balance as number, lastMovementAt: b.lastMovementAt ? (b.lastMovementAt as Date).toISOString() : null,
        })),
      };
    },
  );

  app.get(
    '/pallet-movements',
    { schema: { tags: ['pallets'], querystring: PageQuery.extend({ vehicleId: objectIdString.optional() }), response: { 200: pageResponse(MovementItem) } }, preHandler: staff },
    async (req) => {
      const f: Filter<MovementDoc> = req.query.vehicleId ? { vehicleId: new ObjectId(req.query.vehicleId) } : {};
      const page = await paginate(moves(), f, req.query);
      return { items: page.items.map(toApi), nextCursor: page.nextCursor };
    },
  );
};
```
Register `palletRoutes` in `src/routes.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`; then run the concurrency test 10× (`for i in $(seq 1 10); do npx vitest run test/api/pallets.test.ts || break; done`).
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(pallets): pallet movements with running per-vehicle balance and admin corrections" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 8: Close shipment and trip summary

**Files:**
- Create: `src/modules/summaries/close.service.ts`, `src/modules/summaries/summaries.routes.ts`
- Modify: `src/db/collections.ts`, `src/db/indexes.ts`, `src/routes.ts`
- Test: `test/api/shipment-close.test.ts`

**Interfaces:**
- Produces:
  - `C.tripSummaries`; index `{ shipmentId: 1 } unique`.
  - `interface TripSummaryDoc { _id; shipmentId; shipmentNo; lockedAt: Date; lockedBy: string; evidence: { pods: { doId; doNo; podId; hash; outcome; reasonCode }[]; eventCount: number; flags: string[]; distances: { legs: { fromStopId; toStopId; loaded: boolean; mapKm: number | null; gpsKm: number | null }[]; clientKmByDo: { doNo: string; clientKm: number | null }[] } }; lines: never[]; adjustments: never[]; pdfKey: string | null }`.
  - `closeShipment(app, shipment, version, by): Promise<{ shipment: ShipmentDoc; summary: TripSummaryDoc }>` — 422 `SHIPMENT_NOT_COMPLETED`, `PODS_NOT_VERIFIED` (details `{ doNos }`), `JOB_GROUP_REQUIRED` (details `{ doNos }`), 409 `VERSION_CONFLICT`. In one transaction: insert summary; shipment → `CLOSED` with `closedAt`, `closedBy`, `summaryId`, version +1; FAILED DOs → `UNASSIGNED`, `shipmentId/pickupStopId/dropStopId = null` (attempts kept); audit `close`.
  - `POST /shipments/:id/close` (admin) `{ version }` → `ShipmentItem`; `GET /shipments/:id/summary` (staff) → summary JSON (404 if not closed).

- [ ] **Step 1: Write the failing test**

`test/api/shipment-close.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { acceptedShipment, at, deliveredPod, gps, tap } from '../helpers/execution.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

describe('close shipment', () => {
  let app: App;
  let f: PlanningFixtures;
  const admin = (url: string, payload: object = {}) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: f.admin, payload });
  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('closes a completed shipment once every POD is verified, releasing failed DOs', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { doOverrides: [{}, { destLocationId: f.ids.locC }] });
    for (const code of ['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED']) await tap(app, f, shipment, 0, code);
    for (const code of ['ARRIVED', 'UNLOAD_START', 'UNLOAD_END']) await tap(app, f, shipment, 1, code, gps(13.75, 100.5, at('10:00')));
    const good = (await deliveredPod(app, f, shipment, dos[0])).json();
    await tap(app, f, shipment, 1, 'DEPARTED', gps(13.75, 100.5, at('11:30')));
    await tap(app, f, shipment, 2, 'ARRIVED', gps(16.43, 102.83, at('15:00')));
    const failed = (await app.inject({
      method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1,
      payload: { clientPodId: randomUUID(), doId: dos[1].id, outcome: 'FAILED', reasonCode: 'CONSIGNEE_CLOSED', answers: {}, files: [], ...gps(16.43, 102.83, at('15:05')) },
    })).json();
    let current = (await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}`, headers: f.admin })).json();
    expect(current.status).toBe('COMPLETED');
    const early = await admin(`/shipments/${shipment.id}/close`, { version: current.version });
    expect(early.json()).toMatchObject({ code: 'PODS_NOT_VERIFIED', details: { doNos: [dos[0].doNo, dos[1].doNo].sort() } });
    await admin(`/pods/${good.id}/verify`);
    await admin(`/pods/${failed.id}/verify`);
    current = (await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}`, headers: f.admin })).json();
    const closed = await admin(`/shipments/${shipment.id}/close`, { version: current.version });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ status: 'CLOSED', closedBy: expect.any(String) });
    const summary = (await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}/summary`, headers: f.viewer })).json();
    expect(summary.evidence.pods.map((p: { outcome: string }) => p.outcome).sort()).toEqual(['DELIVERED', 'FAILED']);
    expect(summary.evidence.eventCount).toBeGreaterThanOrEqual(8);
    expect(summary.lines).toEqual([]);
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[1].doNo })).toMatchObject({ status: 'UNASSIGNED', shipmentId: null });
    expect((await admin(`/shipments/${shipment.id}/close`, { version: closed.json().version })).json().code).toBe('SHIPMENT_NOT_COMPLETED');
  });

  it('requires a job group on every DO', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-08', doOverrides: [{ materialId: f.ids.bag }] });
    for (const code of ['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED']) await tap(app, f, shipment, 0, code);
    for (const code of ['ARRIVED', 'UNLOAD_START', 'UNLOAD_END']) await tap(app, f, shipment, 1, code, gps(13.75, 100.5, at('10:00', '2026-10-08')));
    const pod = (await deliveredPod(app, f, shipment, dos[0])).json();
    await admin(`/pods/${pod.id}/verify`);
    const current = (await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}`, headers: f.admin })).json();
    expect((await admin(`/shipments/${shipment.id}/close`, { version: current.version })).json()).toMatchObject({ code: 'JOB_GROUP_REQUIRED', details: { doNos: [dos[0].doNo] } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/shipment-close.test.ts`
Expected: FAIL — close route 404.

- [ ] **Step 3: Implement**

Add `tripSummaries: 'tripSummaries'` to `C` and index `[C.tripSummaries]: [{ key: { shipmentId: 1 }, unique: true }]`.

`src/modules/summaries/close.service.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { C } from '../../db/collections.js';
import { writeAudit } from '../../lib/audit.js';
import { conflict, unprocessable } from '../../lib/errors.js';
import { withTransaction } from '../../lib/tx.js';
import type { EventDoc } from '../execution/events.service.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import type { PodDoc } from '../pods/pods.service.js';
import { doIdsOf } from '../shipments/shipment.service.js';
import type { ShipmentDoc } from '../shipments/shipment.types.js';

export interface TripSummaryDoc {
  _id: ObjectId;
  shipmentId: ObjectId;
  shipmentNo: string;
  lockedAt: Date;
  lockedBy: string;
  evidence: {
    pods: { doId: ObjectId; doNo: string; podId: ObjectId; hash: string; outcome: string; reasonCode: string | null }[];
    eventCount: number;
    flags: string[];
    distances: {
      legs: { fromStopId: ObjectId; toStopId: ObjectId; loaded: boolean; mapKm: number | null; gpsKm: number | null }[];
      clientKmByDo: { doNo: string; clientKm: number | null }[];
    };
  };
  lines: never[];
  adjustments: never[];
  pdfKey: string | null;
}

export async function closeShipment(app: FastifyInstance, shipment: ShipmentDoc, version: number, by: string) {
  if (shipment.status !== 'COMPLETED') throw unprocessable('SHIPMENT_NOT_COMPLETED', `Cannot close a ${shipment.status} shipment`);
  if (version !== shipment.version) throw conflict('VERSION_CONFLICT', 'The shipment was changed by someone else; reload and try again');
  const dos = await app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).find({ _id: { $in: doIdsOf(shipment.stops) } }).toArray();
  const latest = new Map<string, PodDoc>();
  for (const p of await app.db.collection<PodDoc>(C.pods).find({ shipmentId: shipment._id }).sort({ _id: 1 }).toArray()) latest.set(p.doId.toHexString(), p);
  const unverified = dos.filter((d) => latest.get(d._id.toHexString())?.status !== 'verified').map((d) => d.doNo).sort();
  if (unverified.length > 0) throw unprocessable('PODS_NOT_VERIFIED', 'Verify every POD before closing', { doNos: unverified });
  const noGroup = dos.filter((d) => !d.jobGroupId).map((d) => d.doNo).sort();
  if (noGroup.length > 0) throw unprocessable('JOB_GROUP_REQUIRED', 'Assign a job group to every delivery order before closing', { doNos: noGroup });

  const events = await app.db.collection<EventDoc>(C.events).find({ shipmentId: shipment._id }, { projection: { flags: 1 } }).toArray();
  const flags = new Set<string>();
  for (const e of events) for (const fl of e.flags) flags.add(fl);
  for (const p of latest.values()) for (const fl of p.flags) flags.add(fl);
  const now = new Date();
  const summary: TripSummaryDoc = {
    _id: new ObjectId(),
    shipmentId: shipment._id,
    shipmentNo: shipment.shipmentNo,
    lockedAt: now,
    lockedBy: by,
    evidence: {
      pods: dos.map((d) => {
        const p = latest.get(d._id.toHexString())!;
        return { doId: d._id, doNo: d.doNo, podId: p._id, hash: p.hash, outcome: p.outcome, reasonCode: p.reasonCode };
      }),
      eventCount: events.length,
      flags: [...flags].sort(),
      distances: {
        legs: shipment.legs.map((l) => ({ fromStopId: l.fromStopId, toStopId: l.toStopId, loaded: l.loaded, mapKm: l.mapKm, gpsKm: l.gpsKm })),
        clientKmByDo: dos.map((d) => ({ doNo: d.doNo, clientKm: d.distance.clientKm })),
      },
    },
    lines: [],
    adjustments: [],
    pdfKey: null,
  };
  const failedIds = dos.filter((d) => d.status === 'FAILED').map((d) => d._id);
  return withTransaction(app.mongo, async (session) => {
    const updated = await app.db.collection<ShipmentDoc>(C.shipments).findOneAndUpdate(
      { _id: shipment._id, version: shipment.version, status: 'COMPLETED' },
      { $set: { status: 'CLOSED', closedAt: now, closedBy: by, summaryId: summary._id, updatedAt: now, updatedBy: by }, $inc: { version: 1 } },
      { returnDocument: 'after', session },
    );
    if (!updated) throw conflict('VERSION_CONFLICT', 'The shipment was changed by someone else; reload and try again');
    await app.db.collection<TripSummaryDoc>(C.tripSummaries).insertOne(summary, { session });
    if (failedIds.length > 0) {
      await app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).updateMany(
        { _id: { $in: failedIds }, status: 'FAILED' },
        { $set: { status: 'UNASSIGNED', shipmentId: null, pickupStopId: null, dropStopId: null, updatedAt: now, updatedBy: by } },
        { session },
      );
    }
    await writeAudit(app.db, { entity: 'shipment', entityId: shipment._id.toHexString(), action: 'close', by, after: { summaryId: summary._id.toHexString() } }, { session });
    return { shipment: updated, summary };
  });
}
```

`src/modules/summaries/summaries.routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { IdParams } from '../../lib/ids.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import { ShipmentItem } from '../shipments/shipment.schemas.js';
import { shipmentView } from '../shipments/shipment.service.js';
import type { ShipmentDoc } from '../shipments/shipment.types.js';
import { type TripSummaryDoc, closeShipment } from './close.service.js';

export const summaryRoutes: FastifyPluginAsyncZod = async (app) => {
  const loadShipment = async (id: string) => {
    const s = await app.db.collection<ShipmentDoc>(C.shipments).findOne({ _id: new ObjectId(id) });
    if (!s) throw notFound('Shipment');
    return s;
  };

  app.post(
    '/shipments/:id/close',
    { schema: { tags: ['shipments'], params: IdParams, body: z.object({ version: z.number().int().positive() }), response: { 200: ShipmentItem } }, preHandler: app.requireRoles('admin', 'planner') },
    async (req) => shipmentView((await closeShipment(app, await loadShipment(req.params.id), req.body.version, actorOf(req))).shipment),
  );

  app.get(
    '/shipments/:id/summary',
    { schema: { tags: ['shipments'], params: IdParams }, preHandler: app.requireRoles(...STAFF_ROLES) },
    async (req) => {
      const s = await app.db.collection<TripSummaryDoc>(C.tripSummaries).findOne({ shipmentId: new ObjectId(req.params.id) });
      if (!s) throw notFound('Trip summary');
      return toApi(s);
    },
  );
};
```
Register `summaryRoutes` in `src/routes.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(summaries): close shipment into a locked trip summary, releasing failed DOs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 9: Evidence PDF

**Files:**
- Create: `src/modules/summaries/pdf.ts`, `assets/fonts/Sarabun-Regular.ttf`, `assets/fonts/Sarabun-Bold.ttf`, `assets/fonts/OFL.txt`
- Modify: `src/modules/summaries/close.service.ts`, `src/modules/summaries/summaries.routes.ts`, `package.json` (files are read at runtime; ensure `assets/` is not excluded from deploys)
- Test: `test/api/summary-pdf.test.ts`

**Interfaces:**
- Produces:
  - `buildSummaryPdf(data: SummaryPdfData): Promise<Buffer>` where `SummaryPdfData = { shipmentNo; plannedStart: Date; closedAt: Date; closedBy: string; vehicles: string[]; drivers: string[]; stops: { seq: number; location: string; events: { code: string; at: Date }[] }[]; dos: { doNo: string; client: string; material: string; qty: number; unit: string; outcome: string; reasonCode: string | null; receiverName: string | null; hash: string; images: Buffer[] }[]; flags: string[] }`.
  - After a successful close, the service builds the PDF (JPEG/PNG images only, max 2 photos + signature per DO), stores it at `summaries/{shipmentNo}.pdf` and sets `tripSummaries.pdfKey`. A PDF failure is logged and leaves `pdfKey: null`; `POST /shipments/:id/summary.pdf/regenerate` (admin) rebuilds it.
  - `GET /shipments/:id/summary.pdf` (staff) → `application/pdf` body streamed from storage (404 `PDF_NOT_READY` if `pdfKey` is null).

- [ ] **Step 1: Install and fetch fonts**

Run:
```bash
npm i pdfmake@^0.2 && npm i -D @types/pdfmake
mkdir -p assets/fonts
curl -fsSL -o assets/fonts/Sarabun-Regular.ttf https://github.com/google/fonts/raw/main/ofl/sarabun/Sarabun-Regular.ttf
curl -fsSL -o assets/fonts/Sarabun-Bold.ttf https://github.com/google/fonts/raw/main/ofl/sarabun/Sarabun-Bold.ttf
curl -fsSL -o assets/fonts/OFL.txt https://github.com/google/fonts/raw/main/ofl/sarabun/OFL.txt
```
Expected: three files, the TTFs ~90 KB each. If the download is blocked, stop and report NEEDS_CONTEXT.

- [ ] **Step 2: Write the failing test**

`test/api/summary-pdf.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildSummaryPdf } from '../../src/modules/summaries/pdf.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { acceptedShipment, at, deliveredPod, gps, tap } from '../helpers/execution.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

describe('evidence PDF', () => {
  let app: App;
  let f: PlanningFixtures;
  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('renders Thai text into a PDF', async () => {
    const pdf = await buildSummaryPdf({
      shipmentNo: 'SH-2610-00001', plannedStart: new Date(), closedAt: new Date(), closedBy: 'admin',
      vehicles: ['80-3001'], drivers: ['สมชาย ใจดี'],
      stops: [{ seq: 1, location: 'โรงงานสระบุรี', events: [{ code: 'ARRIVED', at: new Date() }] }],
      dos: [{ doNo: 'DO-2610-00001', client: 'SCG', material: 'ปูนผง', qty: 30, unit: 'ton', outcome: 'DELIVERED', reasonCode: null, receiverName: 'คุณสมศรี', hash: 'a'.repeat(64), images: [] }],
      flags: [],
    });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(5000);
  });

  it('stores the PDF on close and serves it', async () => {
    const { shipment, dos } = await acceptedShipment(app, f);
    for (const code of ['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED']) await tap(app, f, shipment, 0, code);
    for (const code of ['ARRIVED', 'UNLOAD_START', 'UNLOAD_END']) await tap(app, f, shipment, 1, code, gps(13.75, 100.5, at('10:00')));
    const pod = (await deliveredPod(app, f, shipment, dos[0])).json();
    await app.inject({ method: 'POST', url: `/api/v1/pods/${pod.id}/verify`, headers: f.admin });
    const current = (await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}`, headers: f.admin })).json();
    await app.inject({ method: 'POST', url: `/api/v1/shipments/${shipment.id}/close`, headers: f.admin, payload: { version: current.version } });
    const res = await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}/summary.pdf`, headers: f.viewer });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/api/summary-pdf.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the PDF builder**

`src/modules/summaries/pdf.ts`:
```ts
import { fileURLToPath } from 'node:url';
import PdfPrinter from 'pdfmake';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';

const font = (name: string) => fileURLToPath(new URL(`../../../assets/fonts/${name}`, import.meta.url));
const printer = new PdfPrinter({
  Sarabun: { normal: font('Sarabun-Regular.ttf'), bold: font('Sarabun-Bold.ttf'), italics: font('Sarabun-Regular.ttf'), bolditalics: font('Sarabun-Bold.ttf') },
});

export interface SummaryPdfData {
  shipmentNo: string;
  plannedStart: Date;
  closedAt: Date;
  closedBy: string;
  vehicles: string[];
  drivers: string[];
  stops: { seq: number; location: string; events: { code: string; at: Date }[] }[];
  dos: { doNo: string; client: string; material: string; qty: number; unit: string; outcome: string; reasonCode: string | null; receiverName: string | null; hash: string; images: Buffer[] }[];
  flags: string[];
}

const bkk = (d: Date) => d.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });

export function buildSummaryPdf(data: SummaryPdfData): Promise<Buffer> {
  const content: Content[] = [
    { text: `ใบสรุปเที่ยว ${data.shipmentNo}`, style: 'h1' },
    { text: `วันที่วางแผน ${bkk(data.plannedStart)} · ปิดงาน ${bkk(data.closedAt)} โดย ${data.closedBy}` },
    { text: `รถ: ${data.vehicles.join(' + ')}   คนขับ: ${data.drivers.join(', ')}`, margin: [0, 4, 0, 10] },
    { text: 'ลำดับจุดจอด', style: 'h2' },
    {
      table: {
        widths: [24, '*', '*'],
        body: [
          ['#', 'สถานที่', 'ขั้นตอน'],
          ...data.stops.map((s) => [String(s.seq), s.location, s.events.map((e) => `${e.code} ${bkk(e.at)}`).join('\n')]),
        ],
      },
      margin: [0, 0, 0, 10],
    },
    { text: 'หลักฐานการส่งสินค้า (POD)', style: 'h2' },
  ];
  for (const d of data.dos) {
    content.push({
      stack: [
        { text: `${d.doNo} · ${d.client} · ${d.material} ${d.qty} ${d.unit}`, bold: true },
        { text: d.outcome === 'DELIVERED' ? `ส่งสำเร็จ · ผู้รับ ${d.receiverName ?? '-'}` : `ส่งไม่สำเร็จ · เหตุผล ${d.reasonCode ?? '-'}` },
        { text: `ลายนิ้วมือ POD: ${d.hash}`, fontSize: 7, color: '#555555' },
        ...(d.images.length > 0 ? [{ columns: d.images.map((img) => ({ image: `data:image/jpeg;base64,${img.toString('base64')}`, fit: [150, 110] as [number, number] })), columnGap: 8 }] : []),
      ],
      margin: [0, 0, 0, 10],
    });
  }
  if (data.flags.length > 0) content.push({ text: `ข้อสังเกต: ${data.flags.join(', ')}`, color: '#b45309' });
  const doc: TDocumentDefinitions = {
    content,
    defaultStyle: { font: 'Sarabun', fontSize: 10 },
    styles: { h1: { fontSize: 16, bold: true, margin: [0, 0, 0, 4] }, h2: { fontSize: 12, bold: true, margin: [0, 6, 0, 4] } },
    pageMargins: [36, 36, 36, 36],
  };
  return new Promise((resolve, reject) => {
    const pdf = printer.createPdfKitDocument(doc);
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.end();
  });
}
```

Note: pdfmake accepts PNG data URLs under an `image/jpeg` prefix because it sniffs the bytes; if a PNG fails in practice, build the prefix from the stored `contentType`. Only pass JPEG/PNG buffers (skip `image/webp`).

- [ ] **Step 5: Generate on close, serve and regenerate**

In `src/modules/summaries/close.service.ts` add:
```ts
import { buildSummaryPdf } from './pdf.js';

export async function generateSummaryPdf(app: FastifyInstance, summaryId: ObjectId): Promise<string> {
  const summary = await app.db.collection<TripSummaryDoc>(C.tripSummaries).findOne({ _id: summaryId });
  if (!summary) throw notFoundSummary();
  const shipment = (await app.db.collection<ShipmentDoc>(C.shipments).findOne({ _id: summary.shipmentId }))!;
  const vehicleIds = [shipment.head?.vehicleId, shipment.tail?.vehicleId].filter((v): v is ObjectId => !!v);
  const driverIds = [shipment.head?.driverId, shipment.tail?.driverId].filter((v): v is ObjectId => !!v);
  const [vehicles, drivers, locations, events, dos, pods] = await Promise.all([
    app.db.collection(C.vehicles).find({ _id: { $in: vehicleIds } }).toArray(),
    app.db.collection(C.drivers).find({ _id: { $in: driverIds } }).toArray(),
    app.db.collection(C.locations).find({ _id: { $in: shipment.stops.map((s) => s.locationId) } }).toArray(),
    app.db.collection<EventDoc>(C.events).find({ shipmentId: shipment._id }).sort({ deviceTime: 1 }).toArray(),
    app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).find({ _id: { $in: summary.evidence.pods.map((p) => p.doId) } }).toArray(),
    app.db.collection<PodDoc>(C.pods).find({ _id: { $in: summary.evidence.pods.map((p) => p.podId) } }).toArray(),
  ]);
  const clients = await app.db.collection(C.clients).find({ _id: { $in: dos.map((d) => d.clientId) } }).toArray();
  const materials = await app.db.collection(C.materials).find({ _id: { $in: dos.map((d) => d.materialId) } }).toArray();
  const name = <T extends { _id: ObjectId }>(list: T[], id: ObjectId, field: keyof T) => String(list.find((x) => x._id.equals(id))?.[field] ?? '');
  const imagesFor = async (p: PodDoc | undefined) => {
    if (!p) return [];
    const picks = [...p.files.filter((f) => f.mime !== 'image/webp' && f.fieldKey !== 'receiverSign').slice(0, 2), ...p.files.filter((f) => f.fieldKey === 'receiverSign' && f.mime !== 'image/webp')];
    const out: Buffer[] = [];
    for (const f of picks) {
      const o = await app.storage.get(f.key);
      if (o) out.push(o.body);
    }
    return out;
  };
  const pdf = await buildSummaryPdf({
    shipmentNo: shipment.shipmentNo,
    plannedStart: shipment.plannedStart,
    closedAt: summary.lockedAt,
    closedBy: summary.lockedBy,
    vehicles: vehicleIds.map((id) => name(vehicles, id, 'plate')),
    drivers: driverIds.map((id) => name(drivers, id, 'name')),
    stops: shipment.stops.map((s) => ({
      seq: s.seq,
      location: name(locations, s.locationId, 'name'),
      events: events.filter((e) => e.stopId?.equals(s.stopId)).map((e) => ({ code: e.code, at: e.deviceTime })),
    })),
    dos: await Promise.all(
      summary.evidence.pods.map(async (ep) => {
        const d = dos.find((x) => x._id.equals(ep.doId))!;
        const p = pods.find((x) => x._id.equals(ep.podId));
        return {
          doNo: ep.doNo, client: name(clients, d.clientId, 'name'), material: name(materials, d.materialId, 'name'), qty: d.qty, unit: d.unit,
          outcome: ep.outcome, reasonCode: ep.reasonCode, receiverName: typeof p?.answers.receiverName === 'string' ? p.answers.receiverName : null,
          hash: ep.hash, images: await imagesFor(p),
        };
      }),
    ),
    flags: summary.evidence.flags,
  });
  const key = `summaries/${shipment.shipmentNo}.pdf`;
  await app.storage.put(key, pdf, 'application/pdf');
  await app.db.collection<TripSummaryDoc>(C.tripSummaries).updateOne({ _id: summaryId }, { $set: { pdfKey: key } });
  return key;
}

function notFoundSummary() {
  return unprocessable('SUMMARY_MISSING', 'Trip summary not found');
}
```
At the end of `closeShipment`, after the transaction returns `result`, call:
```ts
  try {
    result.summary.pdfKey = await generateSummaryPdf(app, result.summary._id);
  } catch (err) {
    app.log.error({ err, shipmentNo: shipment.shipmentNo }, 'summary PDF generation failed');
  }
  return result;
```
(assign the transaction's return value to `const result = await withTransaction(...)`).

In `summaries.routes.ts` add:
```ts
  app.get('/shipments/:id/summary.pdf', { schema: { tags: ['shipments'], params: IdParams }, preHandler: app.requireRoles(...STAFF_ROLES) }, async (req, reply) => {
    const s = await app.db.collection<TripSummaryDoc>(C.tripSummaries).findOne({ shipmentId: new ObjectId(req.params.id) });
    if (!s) throw notFound('Trip summary');
    if (!s.pdfKey) throw unprocessable('PDF_NOT_READY', 'The PDF is not generated yet');
    const obj = await app.storage.get(s.pdfKey);
    if (!obj) throw unprocessable('PDF_NOT_READY', 'The PDF file is missing; regenerate it');
    return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${s.shipmentNo}.pdf"`).send(obj.body);
  });

  app.post('/shipments/:id/summary.pdf/regenerate', { schema: { tags: ['shipments'], params: IdParams }, preHandler: app.requireRoles('admin') }, async (req) => {
    const s = await app.db.collection<TripSummaryDoc>(C.tripSummaries).findOne({ shipmentId: new ObjectId(req.params.id) });
    if (!s) throw notFound('Trip summary');
    return { pdfKey: await generateSummaryPdf(app, s._id) };
  });
```
(import `unprocessable` and `generateSummaryPdf`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(summaries): Thai evidence PDF generated on close, served and regenerable" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 10: Demo seed and README

**Files:**
- Modify: `src/seed/seed.ts`, `scripts/seed.ts`, `README.md`, `.env.example`
- Test: `test/unit/seed.test.ts`

**Interfaces:**
- Produces: `seedDemo(db, { password })` additionally creates (idempotently): users `demo-admin` (admin), `demo-planner` (planner), `demo-driver1` / `demo-driver2` (driver, linked to drivers `DRV-001` / `DRV-002`); vehicles `70-1001`, `70-1002` (TRAILER heads), `71-2001`, `71-2002` (tails), `80-3001`, `80-3002` (MIXER rigid); locations `DEMO-PLANT` (site), `DEMO-SITE-BKK`, `DEMO-SHOP-KKN`; a published POD template for the demo job group; three UNASSIGNED DOs. `scripts/seed.ts --demo` requires `DEMO_PASSWORD` (≥ 8 chars) and refuses to run when `NODE_ENV=production`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/seed.test.ts` inside the `describe`:
```ts
  it('seeds demo users, fleet and unassigned DOs idempotently', async () => {
    await seedDemo(db, { password: 'Demo-pass-1' });
    await seedDemo(db, { password: 'Demo-pass-1' });
    for (const u of ['demo-admin', 'demo-planner', 'demo-driver1', 'demo-driver2']) {
      const user = await findUserByUsername(db, u);
      expect(user).not.toBeNull();
      expect(await verifyPassword(user!.passwordHash, 'Demo-pass-1')).toBe(true);
    }
    expect((await findUserByUsername(db, 'demo-driver1'))!.driverId).not.toBeNull();
    expect(await db.collection(C.vehicles).countDocuments({ plate: { $in: ['70-1001', '70-1002', '71-2001', '71-2002', '80-3001', '80-3002'] } })).toBe(6);
    expect(await db.collection(C.deliveryOrders).countDocuments({ status: 'UNASSIGNED' })).toBe(3);
  });
```
and change the existing demo test's calls from `seedDemo(db)` to `seedDemo(db, { password: 'Demo-pass-1' })`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/seed.test.ts`
Expected: FAIL — no demo users.

- [ ] **Step 3: Implement**

In `src/seed/seed.ts` change the signature to `seedDemo(db: Db, opts: { password: string })` and append to its body (reuse `upsertByCode`; vehicles upsert by `plateKey` with `plate`, `part`, `truckTypeId`, `gpsVendor: null`, `gpsId: null`):
```ts
  const trailer = (await db.collection(C.truckTypes).findOne({ code: 'TRAILER' }))!._id as ObjectId;
  const kkn = await upsertByCode(db, C.locations, {
    code: 'DEMO-SHOP-KKN', name: 'ร้านวัสดุ ขอนแก่น', clientId, zoneId: zCen, isSite: false, address: 'Khon Kaen',
    geo: { type: 'Point', coordinates: [102.83, 16.43] }, geofenceRadiusM: 300,
  });
  const upsertVehicle = async (plate: string, part: string, truckTypeId: ObjectId) => {
    const now = new Date();
    await db.collection(C.vehicles).updateOne(
      { plateKey: plate.replace(/[\s\-.]/g, '') },
      { $setOnInsert: { plate, plateKey: plate.replace(/[\s\-.]/g, ''), part, truckTypeId, gpsVendor: null, gpsId: null, active: true, createdAt: now, updatedAt: now } },
      { upsert: true },
    );
  };
  await upsertVehicle('70-1001', 'head', trailer);
  await upsertVehicle('70-1002', 'head', trailer);
  await upsertVehicle('71-2001', 'tail', trailer);
  await upsertVehicle('71-2002', 'tail', trailer);
  await upsertVehicle('80-3001', 'rigid', mixer);
  await upsertVehicle('80-3002', 'rigid', mixer);
  const d1 = await upsertByCode(db, C.drivers, { code: 'DRV-001', name: 'สมชาย ใจดี', phone: '0810000001', licenseType: 'ท.4', licenseExpiry: '2030-12-31', weeklyDaysOff: [] });
  const d2 = await upsertByCode(db, C.drivers, { code: 'DRV-002', name: 'สมศักดิ์ ขยัน', phone: '0810000002', licenseType: 'ท.4', licenseExpiry: '2030-12-31', weeklyDaysOff: [0] });
  const ensureUser = async (username: string, roles: Role[], driverId: ObjectId | null) => {
    if (!(await findUserByUsername(db, username))) await createUser(db, { username, password: opts.password, roles, driverId });
  };
  await ensureUser('demo-admin', ['admin'], null);
  await ensureUser('demo-planner', ['planner'], null);
  await ensureUser('demo-driver1', ['driver'], d1);
  await ensureUser('demo-driver2', ['driver'], d2);
  const single = (await db.collection(C.serviceTypes).findOne({ code: 'SINGLE' }))!._id as ObjectId;
  if ((await db.collection(C.deliveryOrders).countDocuments({ clientRef: /^DEMO-/ })) === 0) {
    const plantId = plant;
    const dests = [(await db.collection(C.locations).findOne({ code: 'DEMO-SITE-BKK' }))!._id as ObjectId, kkn, kkn];
    for (const [i, dest] of dests.entries()) {
      const now = new Date();
      await db.collection(C.deliveryOrders).insertOne({
        doNo: await nextNumber(db, 'DO'), clientRef: `DEMO-${i + 1}`, clientId, jobGroupId: group!._id, jobGroupMatch: { status: 'manual', candidates: [group!._id] },
        serviceTypeId: single, materialId: readymix, intendedTruckTypeId: mixer, qty: 6, unit: 'm3', palletPlan: null,
        originLocationId: plantId, destLocationId: dest, pickupWindow: null, dropWindow: null, distance: { clientKm: null },
        shipmentId: null, pickupStopId: null, dropStopId: null, status: 'UNASSIGNED', note: null, cancelledAt: null, cancelReason: null,
        attempts: [], createdBy: 'seed', createdAt: now, updatedBy: 'seed', updatedAt: now,
      });
    }
  }
```
(add imports: `type Role` from `../lib/roles.js`, `nextNumber` from `../lib/counters.js`).

`scripts/seed.ts` — replace the `--demo` branch with:
```ts
  if (process.argv.includes('--demo')) {
    if (config.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');
    const password = process.env.DEMO_PASSWORD;
    if (!password || password.length < 8) throw new Error('Set DEMO_PASSWORD (at least 8 characters) to seed demo users');
    await seedDemo(db, { password });
    console.log('demo data: ok (users demo-admin, demo-planner, demo-driver1, demo-driver2)');
  }
```
Add `DEMO_PASSWORD=` to `.env.example`. README — add a "Driver execution and POD (Plan 3)" section describing: `/uploads/presign` → PUT the file → `/driver/pods`; `/driver/events`; POD review `/pods`; pallets; `POST /shipments/:id/close`; `GET /shipments/:id/summary.pdf`; Spaces settings; and "Demo" instructions (`DEMO_PASSWORD=... npm run seed -- --demo`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(seed): demo users, fleet and unassigned DOs for the end-to-end demo; document Plan 3" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

## Self-review notes (plan author)

- **Spec coverage:** §5.3 stop events + extra steps + reason codes (Tasks 2, 4); §5.4 GPS on every driver action (Tasks 2, 4, 5, 7); §5.6 derived statuses (Task 4 stop/shipment/DO, Task 5 completion); §6.1 POD content per template + automatic evidence (Tasks 3, 5); §6.2 presigned uploads + hash verification (Tasks 1, 5); §6.3 tamper hash (Task 5); §6.4 review (Task 6); §7 pallets (Task 7); §9 close + summary + PDF (Tasks 8, 9). Not in this plan: admin CORRECTION events, geofence suggestions (Plan 4), POD `palletLines` legacy migration (Plan 4).
- **Known limitation:** `recordDriverEvent` resolves POD forms per event for extra steps; fine for the expected tap rate.
