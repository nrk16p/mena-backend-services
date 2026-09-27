# Plan 3 — Driver Execution, ePOD, Pallets & Shipment Close — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A driver runs an accepted shipment end to end — records every stop step with GPS, uploads photos/signatures to DigitalOcean Spaces, submits a POD per delivery order using the client's POD form (or a failed-delivery report with a reason) and records pallet movements — and an admin or planner verifies/rejects PODs and closes the shipment, producing a locked trip summary and an evidence PDF. The plan also clears the two Plan 1 carry-forward items it owns (stale driver links; mutation + audit in one transaction).

**Architecture:** New modules `storage` (S3-compatible adapter + in-memory test adapter), `execution` (event rules + driver events), `pods` (form validation, form resolution, submission, review), `pallets`, and `summaries` (close + PDF). Pure code has no database imports and its own unit tests: `lib/geo.ts`, `lib/gps.ts`, `lib/canonical.ts`, `lib/status.ts` (status derivation, spec §5.6), `execution/event-rules.ts`, `pods/pod-validation.ts`. Driver ownership lives in one exported module (`shipments/driver-access.ts`) used by every driver route. Every write that touches a shipment and its DOs runs in one MongoDB transaction; events, PODs and pallet movements are append-only.

**Tech Stack:** Plan 1–2 stack plus `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`, `pdfmake@^0.2` (+ `@types/pdfmake`), Sarabun TTF fonts (OFL) for Thai text in PDFs.

**Spec:** `docs/superpowers/specs/2026-09-27-phase1-planning-epod-design.md` §5.3–5.6, §6, §7, §9, §13 (performance). Roadmap: `docs/superpowers/plans/2026-09-27-roadmap.md`. Execution ledger rulings P3-R1…P3-R8: `.superpowers/sdd/2026-09-27-plan3-driver-epod-pallets-close/progress.md`.

**Decisions made in this plan (flag to PO at handoff):**
- Driver events, PODs and pallet movements are append-only records that are themselves the audit trail. System-derived status changes (shipment `ACCEPTED → IN_TRANSIT → COMPLETED`, stop status, DO `PICKED_UP` / `DELIVERED` / `FAILED`) are **not** written to `auditLog`; the `events` and `pods` collections are the trail (ruling P3-R7, consistent with the earlier driver-event exemption; cost if wrong: add audit later). Human decisions — POD verify/reject, pallet corrections, shipment close — write exactly one audit entry **inside** their transaction.
- Admin `CORRECTION` events and admin step overrides (spec §5.3) are **not** in this plan; they are a Plan 4 roadmap row (P3-R7), added to the roadmap in Task 11. Until then a wrong tap is fixed by the planner cancelling/re-planning.
- Geofence-suggested events (spec §5.5) need the GPS feed and are in Plan 4.
- Driver events are accepted on `COMPLETED` shipments (spec §5.3: `DEPARTED` follows the POD at the last drop), and `GET /driver/shipments` keeps `COMPLETED` shipments until they are `CLOSED`, so a driver can resubmit a rejected POD from the app (P3-R4).
- A POD with outcome `FAILED` keeps its DO linked to the shipment until close; closing the shipment releases failed DOs back to the pool (`UNASSIGNED`) through the same job-group re-match as `releaseDos`, with the attempt kept in `attempts[]` (spec §5.2; P3-R6).
- `pod.hash` follows spec §6.3 exactly (P3-R7): `outcome`/`reasonCode` are not part of the hash; the canonical form is documented in the README (Task 11) so third parties can re-verify.
- Pallet documents use the spec §3.3 field names (P3-R7): `tailVehicleId` (the shipment's tail, else its head/rigid vehicle — spec §7), `deviceTime`, `stopId`, `locationId`; `palletBalances.tailVehicleId` is unique. Drivers read only their own pallet movements (spec §7, §8.2).
- Legacy DOs (`legacy: true`, from the Plan 4 migration) are exempt from the job-group requirement at close (spec §3.4, §5.1).
- If a client has no published POD template, the built-in default form (goods photo ≥ 1, receiver name, receiver signature) is used.
- Storage: `STORAGE_DRIVER=s3` uses DigitalOcean Spaces via the S3 API (keys from `.env`); the S3 client only adds checksums when an operation requires them, so presigned PUT URLs work from phones (P3-R8). Tests and local development without keys use `STORAGE_DRIVER=memory`.
- Evidence PDF embeds up to two photos per DO and the signature when the stored bytes are a decodable JPEG/PNG (sniffed from magic bytes, not trusted from the declared type); anything else (WebP, broken files) is skipped and counted, so one bad photo never blocks the PDF (P3-R3).
- Only an active user with the `driver` role holds a `driverId`; removing the role or deactivating the user releases the link (Task 10). Deactivating a driver master record does not touch user links (a deactivated driver can no longer be planned; the admin deactivates the account, which releases the link).

## Global Constraints

- Everything in Plan 1 and Plan 2 Global Constraints still applies.
- **Never call `bulkWrite` or `insertMany` inside `withTransaction`** (mongodb 6.21 + client `timeoutMS` rejects them; write documents one at a time inside the transaction). `updateMany` is allowed (P2-R8).
- Every mutation and its audit entry commit in the same transaction (`writeAudit(..., { session })`); Task 12 brings the Plan 1–2 routes in line.
- Every driver event, POD and pallet movement carries `lat`, `lng`, `accuracyM` (all three null together, and only with `noGpsReason: 'NO_GPS'`) and `deviceTime`; the server adds `receivedAt` and flags `NO_GPS`, `LOW_ACCURACY` (> 100 m), `OUTSIDE_GEOFENCE` (> location `geofenceRadiusM`), `LATE_SYNC` (receivedAt − deviceTime > 6 h).
- Driver writes are idempotent: `clientEventId` / `clientPodId` are UUIDs with unique indexes; a replay returns the original result (`duplicate`), never a second record. A driver event that loses a race on the shipment `version` is rejected with `SHIPMENT_CHANGED` and nothing is stored; the app resends it with the same `clientEventId`.
- Uploaded files: only `image/jpeg`, `image/png`, `image/webp`; max `UPLOAD_MAX_BYTES` (default 5 242 880); key prefix `pods/{shipmentId}/{doId}/`; SHA-256 recomputed by the server before a POD is accepted.
- `pod.hash = sha256(canonicalJson({ doId, templateId, templateVersion, answers, files, evidence }))` (spec §6.3) where ids are hex strings (`templateId` null for the default form), `files` is the list of file `sha256` values in key order, `evidence` is the stored evidence object with `deviceTime`/`receivedAt` as ISO-8601 UTC strings, and `canonicalJson` sorts object keys recursively and drops `undefined`.
- Reason codes: `SHORTAGE, OVERAGE, DAMAGED, REFUSED_FULL, REFUSED_PARTIAL, CONSIGNEE_CLOSED, NO_RECEIVER, WRONG_ADDRESS, DOCS_MISSING, TEMP_OUT_OF_RANGE, TRAFFIC, BREAKDOWN, WEATHER, CHECKPOINT, OTHER` (`OTHER` requires a note).
- Stop step order: `ARRIVED` → (drop DOs) `UNLOAD_START` → `UNLOAD_END` → (pickup DOs) `LOAD_START` → `LOAD_END` → `DEPARTED`; a stop cannot be `ARRIVED` before the previous stop is `DEPARTED`; `DEPARTED` at a stop with drops requires a POD for every drop DO.
- Statuses written by driver actions come from the pure functions in `src/lib/status.ts` (`deriveStopStatus`, `deriveDoStatus`, `deriveShipmentStatus`); no route computes a status inline.
- Roles: driver endpoints need role `driver` + linked `driverId` and only reach shipments where the driver is head or tail driver (others → 404). POD review (verify/reject), close and PDF regenerate: `admin` or `planner` (P3-R1); `viewer` → 403. Pallet corrections: `admin`. Reads of events/PODs/summaries/pallets: `admin`, `planner`, `viewer`; drivers also read their own pallet movements.
- Test helpers assert the status of every setup call and throw with the response body (`ok()` in `test/helpers/http.ts`), so a broken precondition fails loudly instead of as `undefined`.

## Review Focus

1. **Phone offline for hours, then syncs a batch of taps twice** → each event stored once (duplicates reported as `duplicate`), in-order taps accepted, `LATE_SYNC` flagged. Test in Task 4.
2. **Driver taps "Departed" before submitting PODs for the drops at that stop** → rejected with `POD_REQUIRED`, nothing stored. Test in Task 4.
3. **A photo uploaded, then replaced in storage with a different file before the POD is submitted** (or the client sends the wrong hash) → `FILE_HASH_MISMATCH`, POD not stored. Test in Task 5.
4. **Admin rejects a POD and the driver resubmits** → the new POD supersedes the old one, the DO returns to `DELIVERED`, and the shipment can close only after the new POD is verified. Tests in Task 6 (supersede + re-verify) and Task 8 (close refused until the resubmitted POD is verified).
5. **Two pallet movements for the same trailer sent at the same moment** → the balance reflects both, each `balanceAfter` is consistent with a serial order. Test in Task 7.

---

## File Structure

```
src/
  config.ts                            + STORAGE_DRIVER, SPACES_*, UPLOAD_MAX_BYTES, PUBLIC_BASE_URL
  lib/geo.ts                           haversineM, gpsFlags
  lib/canonical.ts                     canonicalJson, sha256Hex
  lib/gps.ts                           GpsFields zod
  lib/status.ts                        deriveStopStatus, deriveDoStatus, deriveShipmentStatus, POD_DONE_STATUSES (pure, spec §5.6)
  plugins/storage.ts                   app.storage (S3Storage | MemoryStorage)
  db/collections.ts, db/indexes.ts     + events, pods, palletMovements, palletBalances, tripSummaries, refreshFamilies
  modules/storage/storage.ts           Storage interface, MemoryStorage, S3Storage, createStorage, UPLOAD_TYPES
  modules/storage/uploads.routes.ts    POST /uploads/presign (+ local PUT/GET for memory storage)
  modules/shipments/driver-access.ts   driverIdOf, driverScope, loadDriverShipment (shared by every driver route)
  modules/shipments/driver.routes.ts   uses driver-access; + podForm per DO; lists COMPLETED until CLOSED
  modules/shipments/shipment.service.ts transition(): + inTx hook; releaseDos(): + status filter
  modules/shipments/shipment.types.ts  StopDoc.status: StopStatus; ShipmentDoc close fields
  modules/shipments/shipment.schemas.ts ShipmentItem close fields, stop status enum
  modules/orders/order.types.ts        DeliveryOrderDoc attempts?, legacy?
  modules/pod-templates/pod-templates.service.ts + resolvePodTemplates (one query for many DOs)
  modules/execution/event-rules.ts     pure step rules
  modules/execution/stop-context.ts    doneStepsAt, geofenceTarget (shared by events, PODs, pallets)
  modules/execution/events.service.ts  recordDriverEvent
  modules/execution/events.routes.ts   POST /driver/events, GET /shipments/:id/events
  modules/pods/pod-validation.ts       DEFAULT_POD_FIELDS, validatePodAnswers (pure)
  modules/pods/pod-form.ts             PodForm, podFormsFor, podFormFor
  modules/pods/pods.service.ts         submitPod, podHashOf
  modules/pods/pods.routes.ts          POST /driver/pods, GET /pods, GET /pods/:id, verify, reject
  modules/pallets/pallets.routes.ts    pallet movements + balances
  modules/summaries/close.service.ts   closeShipment, generateSummaryPdf
  modules/summaries/pdf.ts             buildSummaryPdf, embeddableImage
  modules/summaries/summaries.routes.ts POST /shipments/:id/close, GET summary, GET summary.pdf, regenerate
  modules/users/users.routes.ts        driver-link hygiene (Task 10); transactional audit + LAST_ADMIN lock (Task 12)
  modules/auth/refresh-tokens.ts       family document compare-and-set (Task 12)
  modules/{pod-templates,api-keys,availability,master,orders,auth}/…  mutation + audit in one transaction (Task 12)
  seed/seed.ts                         richer demo (users, fleet, DOs)
assets/fonts/Sarabun-Regular.ttf, Sarabun-Bold.ttf, OFL.txt
test/helpers/http.ts                   ok(res, status)
test/helpers/execution.ts              acceptedShipment, tap, at, gps, tinyJpeg, uploadPhoto, deliveredPod, toDropStop
docs/superpowers/plans/2026-09-27-roadmap.md  carry-forward rows updated (Tasks 11, 12)
```

---

### Task 1: Storage adapter, config, upload presign and shared driver access

**Files:**
- Create: `src/modules/storage/storage.ts`, `src/plugins/storage.ts`, `src/modules/storage/uploads.routes.ts`, `src/lib/canonical.ts`, `src/modules/shipments/driver-access.ts`, `test/helpers/http.ts`
- Modify: `src/config.ts`, `src/app.ts`, `src/routes.ts`, `src/types/fastify.d.ts`, `src/modules/shipments/driver.routes.ts`, `.env.example`, `test/unit/config.test.ts`
- Test: `test/unit/storage.test.ts`, `test/api/uploads.test.ts`

**Interfaces:**
- Produces:
  - `interface Storage { presignPut(key, contentType, expiresSec): Promise<string>; presignGet(key, expiresSec): Promise<string>; get(key): Promise<{ body: Buffer; contentType: string } | null>; put(key, body, contentType): Promise<void> }`, `class MemoryStorage implements Storage` (public `objects: Map`; constructed with optional `{ baseUrl, secret }` — with them it returns signed local URLs `${baseUrl}/api/v1/uploads/local?key=…&exp=…&sig=…`, without them `memory://<key>`), `verifyLocalSignature(secret, key, exp, sig): boolean`, `class S3Storage` (its `S3Client` uses `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'`, so presigned PUT URLs carry no `x-amz-checksum-*` parameters a phone could not satisfy — P3-R8), `createStorage(config): Storage`, `UPLOAD_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }`; `app.storage`.
  - Config `PUBLIC_BASE_URL` (default `http://localhost:3000`) — used for local upload links.
  - Only when `STORAGE_DRIVER=memory`: `PUT /uploads/local?key&exp&sig` (raw `image/*` body, ≤ `UPLOAD_MAX_BYTES`) stores the object; `GET /uploads/local?key&exp&sig` streams it. Invalid/expired signature → 403 `INVALID_SIGNATURE`. These let the browser demo work without Spaces keys (data is lost on restart).
  - Config: `STORAGE_DRIVER: 's3' | 'memory'` (default `'memory'`), `SPACES_ENDPOINT?`, `SPACES_REGION` (default `'sgp1'`), `SPACES_BUCKET?`, `SPACES_KEY?`, `SPACES_SECRET?` (all four required when `STORAGE_DRIVER=s3`), `UPLOAD_MAX_BYTES` (default 5242880).
  - `canonicalJson(value: unknown): string`, `sha256Hex(data: string | Buffer): string`.
  - `src/modules/shipments/driver-access.ts` (P3-R6; replaces the local closures in `driver.routes.ts:22-32`): `driverIdOf(req: { principal: unknown }): ObjectId` (403 `NOT_A_DRIVER` without a linked driver), `driverScope(driverId): Filter` (`$or` head/tail driver), `loadDriverShipment(db, id: ObjectId, driverId: ObjectId): Promise<ShipmentDoc>` (404 `NOT_FOUND` when the shipment is not the driver's). Tasks 4, 5 and 7 import these from here.
  - `test/helpers/http.ts`: `ok<T = any>(res, status = 200): T` — returns `res.json()` or throws `expected <status>, got <code>: <body>`.
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
    expect(put).not.toMatch(/x-amz-checksum|x-amz-sdk-checksum/i);
    expect(await s.presignGet('pods/a/b/c.jpg', 300)).toContain('X-Amz-Expires=300');
  });
});
```

`test/api/uploads.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
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

`test/helpers/http.ts`:
```ts
import type { LightMyRequestResponse } from 'fastify';

/** Returns the JSON body when the response has the expected status; otherwise throws with the body so a broken setup step fails loudly. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ok<T = any>(res: LightMyRequestResponse, status = 200): T {
  if (res.statusCode !== status) throw new Error(`expected ${status}, got ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}
```
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts test/unit/storage.test.ts test/api/uploads.test.ts`
Expected: FAIL — config fields, modules, helper and route missing.

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

export const UPLOAD_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;
export type UploadType = keyof typeof UPLOAD_TYPES;

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
    this.client = new S3Client({
      endpoint: o.endpoint,
      region: o.region,
      credentials: { accessKeyId: o.key, secretAccessKey: o.secret },
      // SDK ≥ 3.729 otherwise signs a CRC32 of the (empty) body into presigned PUT URLs, which the
      // phone's real upload can never match; only add checksums when an operation requires them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
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

- [ ] **Step 5: Extract driver access and refactor the driver routes**

`src/modules/shipments/driver-access.ts`:
```ts
import { ObjectId, type Db, type Filter } from 'mongodb';
import { C } from '../../db/collections.js';
import { AppError, notFound } from '../../lib/errors.js';
import type { ShipmentDoc } from './shipment.types.js';

/** The caller's linked driver id; 403 NOT_A_DRIVER for users without one (and for API keys). */
export function driverIdOf(req: { principal: unknown }): ObjectId {
  const p = req.principal as { kind: string; driverId: string | null } | null;
  if (!p || p.kind !== 'user' || !p.driverId) throw new AppError(403, 'NOT_A_DRIVER', 'This user is not linked to a driver');
  return new ObjectId(p.driverId);
}

/** Shipments where the driver is the head or the tail driver. */
export function driverScope(driverId: ObjectId): Filter<ShipmentDoc> {
  return { $or: [{ 'head.driverId': driverId }, { 'tail.driverId': driverId }] };
}

/** Loads a shipment the driver works on; anyone else's shipment is reported as not found (spec §8.2). */
export async function loadDriverShipment(db: Db, id: ObjectId, driverId: ObjectId): Promise<ShipmentDoc> {
  const doc = await db.collection<ShipmentDoc>(C.shipments).findOne({ _id: id, ...driverScope(driverId) });
  if (!doc) throw notFound('Shipment');
  return doc;
}
```

In `src/modules/shipments/driver.routes.ts`:
- delete the local `driverIdOf`, `mine` and `loadMine` closures (lines 22-32) and add `import { driverIdOf, driverScope, loadDriverShipment } from './driver-access.js';`;
- in `GET /driver/shipments` replace `...mine(driverId)` with `...driverScope(driverId)`;
- in accept and decline replace `const existing = await loadMine(req.params.id, driverId);` with `const existing = await loadDriverShipment(app.db, new ObjectId(req.params.id), driverId);`;
- remove the line `import { AppError, notFound } from '../../lib/errors.js';` (neither is used there any more).

Behaviour is unchanged; `test/api/shipments-dispatch.test.ts` covers accept/decline and the job list.

- [ ] **Step 6: Implement the presign route**

`src/modules/storage/uploads.routes.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { AppError, notFound, unprocessable } from '../../lib/errors.js';
import { objectIdString } from '../../lib/ids.js';
import { driverIdOf, loadDriverShipment } from '../shipments/driver-access.js';
import { doIdsOf } from '../shipments/shipment.service.js';
import type { ShipmentStatus } from '../shipments/shipment.types.js';
import { UPLOAD_TYPES, type UploadType, verifyLocalSignature } from './storage.js';

export const ACTIVE_FOR_UPLOAD: ShipmentStatus[] = ['ACCEPTED', 'IN_TRANSIT', 'COMPLETED'];

export const uploadRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/uploads/presign',
    {
      schema: {
        tags: ['driver'],
        body: z.object({
          shipmentId: objectIdString,
          doId: objectIdString,
          contentType: z.enum(Object.keys(UPLOAD_TYPES) as [UploadType, ...UploadType[]]),
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
      if (!ACTIVE_FOR_UPLOAD.includes(shipment.status)) {
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

  // Local upload links (memory storage only) so the browser demo works without Spaces keys.
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
};
```
The browser must be able to PUT to this URL: in the demo the Vite dev servers proxy `/api` to the API, and `PUBLIC_BASE_URL` can be set to the Vite origin so links stay same-origin.

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

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(storage): Spaces/memory storage adapter, canonical hashing, upload presign and shared driver access" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 2: GPS evidence helpers, step rules and status derivation (pure)

**Files:**
- Create: `src/lib/geo.ts`, `src/lib/gps.ts`, `src/lib/status.ts`, `src/modules/execution/event-rules.ts`
- Test: `test/unit/geo.test.ts`, `test/unit/event-rules.test.ts`, `test/unit/status.test.ts`

**Interfaces:**
- Produces:
  - `haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number`.
  - `gpsFlags(i: { lat: number | null; lng: number | null; accuracyM: number | null; deviceTime: Date; receivedAt: Date; target?: { lat: number; lng: number; radiusM: number } }): { flags: string[]; distanceM: number | null }`.
  - `GpsFields` (zod object: `lat`, `lng`, `accuracyM` nullable; `noGpsReason: 'NO_GPS' | null` default null; `deviceTime` ISO) refined so `lat`, `lng` and `accuracyM` are null together, and a missing position needs `noGpsReason: 'NO_GPS'`; `type GpsInput`.
  - `STOP_EVENTS`, `EXTRA_EVENTS`, `GLOBAL_EVENTS`, `EVENT_CODES`, `REASON_CODES`, types `StopEventCode`, `ExtraEventCode`, `EventCode`, `ReasonCode`.
  - `stopSequence(hasDrops, hasPickups): StopEventCode[]`, `checkStopEvent(state: StopState, code: StopEventCode, prevStopDeparted: boolean): Issue | null`, `checkExtraEvent(state: StopState, code: ExtraEventCode, allowed: string[]): Issue | null`, `interface StopState { hasDrops: boolean; hasPickups: boolean; done: Set<string>; allDropsHavePod: boolean }`.
  - `src/lib/status.ts` (spec §5.6, P3-R7 — the only place a driver-driven status is computed): `STOP_STATUSES`, `type StopStatus = 'PENDING' | 'ARRIVED' | 'WORKING' | 'DONE'`, `POD_DONE_STATUSES: readonly DoStatus[]` (`DELIVERED`, `FAILED`, `POD_VERIFIED`, `POD_REJECTED`), `deriveStopStatus(done: ReadonlySet<string>): StopStatus`, `deriveDoStatus(current: DoStatus, facts: { loaded: boolean; latestPod: { outcome: 'DELIVERED' | 'FAILED'; status: 'submitted' | 'verified' | 'rejected' } | null }): DoStatus`, `deriveShipmentStatus(current: ShipmentStatus, facts: { driverEvents: number; doStatuses: readonly DoStatus[] }): ShipmentStatus`. Tasks 4, 5 and 6 write only what these return; Task 3 types `StopDoc.status` as `StopStatus`.

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
    expect(GpsFields.safeParse({ lat: 13.7, lng: 100.5, accuracyM: null, deviceTime: '2026-10-05T08:00:00+07:00' }).success).toBe(false);
    expect(GpsFields.safeParse({ lat: null, lng: null, accuracyM: 12, noGpsReason: 'NO_GPS', deviceTime: '2026-10-05T08:00:00+07:00' }).success).toBe(false);
  });
});
```

`test/unit/event-rules.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { checkExtraEvent, checkStopEvent, stopSequence } from '../../src/modules/execution/event-rules.js';

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
});
```

`test/unit/status.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { deriveDoStatus, deriveShipmentStatus, deriveStopStatus } from '../../src/lib/status.js';

describe('status derivation (spec §5.6)', () => {
  it('derives the stop status from the steps done there', () => {
    expect(deriveStopStatus(new Set())).toBe('PENDING');
    expect(deriveStopStatus(new Set(['ARRIVED']))).toBe('ARRIVED');
    expect(deriveStopStatus(new Set(['ARRIVED', 'UNLOAD_START']))).toBe('WORKING');
    expect(deriveStopStatus(new Set(['ARRIVED', 'DOCS_SUBMITTED']))).toBe('ARRIVED');
    expect(deriveStopStatus(new Set(['ARRIVED', 'DEPARTED']))).toBe('DONE');
  });

  it('derives the DO status from pickup and its latest POD', () => {
    expect(deriveDoStatus('PLANNED', { loaded: false, latestPod: null })).toBe('PLANNED');
    expect(deriveDoStatus('PLANNED', { loaded: true, latestPod: null })).toBe('PICKED_UP');
    expect(deriveDoStatus('PICKED_UP', { loaded: true, latestPod: { outcome: 'DELIVERED', status: 'submitted' } })).toBe('DELIVERED');
    expect(deriveDoStatus('DELIVERED', { loaded: true, latestPod: { outcome: 'DELIVERED', status: 'verified' } })).toBe('POD_VERIFIED');
    expect(deriveDoStatus('DELIVERED', { loaded: true, latestPod: { outcome: 'DELIVERED', status: 'rejected' } })).toBe('POD_REJECTED');
    expect(deriveDoStatus('PLANNED', { loaded: false, latestPod: { outcome: 'FAILED', status: 'submitted' } })).toBe('FAILED');
    expect(deriveDoStatus('FAILED', { loaded: false, latestPod: { outcome: 'FAILED', status: 'verified' } })).toBe('FAILED');
    expect(deriveDoStatus('UNASSIGNED', { loaded: true, latestPod: null })).toBe('UNASSIGNED');
  });

  it('derives only the system shipment transitions', () => {
    expect(deriveShipmentStatus('ACCEPTED', { driverEvents: 0, doStatuses: ['PLANNED'] })).toBe('ACCEPTED');
    expect(deriveShipmentStatus('ACCEPTED', { driverEvents: 1, doStatuses: ['PLANNED'] })).toBe('IN_TRANSIT');
    expect(deriveShipmentStatus('IN_TRANSIT', { driverEvents: 5, doStatuses: ['DELIVERED', 'PICKED_UP'] })).toBe('IN_TRANSIT');
    expect(deriveShipmentStatus('IN_TRANSIT', { driverEvents: 5, doStatuses: ['DELIVERED', 'FAILED'] })).toBe('COMPLETED');
    expect(deriveShipmentStatus('IN_TRANSIT', { driverEvents: 5, doStatuses: [] })).toBe('IN_TRANSIT');
    expect(deriveShipmentStatus('COMPLETED', { driverEvents: 9, doStatuses: ['POD_REJECTED'] })).toBe('COMPLETED');
    expect(deriveShipmentStatus('DISPATCHED', { driverEvents: 1, doStatuses: ['DELIVERED'] })).toBe('DISPATCHED');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/geo.test.ts test/unit/event-rules.test.ts test/unit/status.test.ts`
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
  .refine((g) => (g.lat === null) === (g.accuracyM === null), { message: 'accuracyM must be sent with a position and be null without one', path: ['accuracyM'] })
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
```

`src/lib/status.ts`:
```ts
import type { DoStatus } from '../modules/orders/order.types.js';
import type { ShipmentStatus } from '../modules/shipments/shipment.types.js';

// Spec §5.6: statuses are derived from the event log (and the latest POD per DO) by these pure
// functions and stored denormalised for queries. Routes never compute a driver-driven status inline.

export const STOP_STATUSES = ['PENDING', 'ARRIVED', 'WORKING', 'DONE'] as const;
export type StopStatus = (typeof STOP_STATUSES)[number];

/** DO statuses that count as "has a POD": they allow departing a drop stop and complete a shipment. */
export const POD_DONE_STATUSES: readonly DoStatus[] = ['DELIVERED', 'FAILED', 'POD_VERIFIED', 'POD_REJECTED'];

export interface LatestPodFact {
  outcome: 'DELIVERED' | 'FAILED';
  status: 'submitted' | 'verified' | 'rejected';
}

export function deriveStopStatus(done: ReadonlySet<string>): StopStatus {
  if (done.has('DEPARTED')) return 'DONE';
  if (['UNLOAD_START', 'UNLOAD_END', 'LOAD_START', 'LOAD_END'].some((c) => done.has(c))) return 'WORKING';
  if (done.has('ARRIVED')) return 'ARRIVED';
  return 'PENDING';
}

/** `loaded` = LOAD_END recorded at the DO's pickup stop; `latestPod` = the DO's newest POD, if any. */
export function deriveDoStatus(current: DoStatus, facts: { loaded: boolean; latestPod: LatestPodFact | null }): DoStatus {
  const pod = facts.latestPod;
  if (pod) {
    if (pod.status === 'rejected') return 'POD_REJECTED';
    if (pod.outcome === 'FAILED') return 'FAILED';
    return pod.status === 'verified' ? 'POD_VERIFIED' : 'DELIVERED';
  }
  if (facts.loaded && current === 'PLANNED') return 'PICKED_UP';
  return current;
}

/**
 * The system transitions of spec §5.1: the first driver event starts the trip, and the trip is
 * complete once every DO has a POD. Planner/driver/admin transitions are not derived here.
 */
export function deriveShipmentStatus(current: ShipmentStatus, facts: { driverEvents: number; doStatuses: readonly DoStatus[] }): ShipmentStatus {
  let status = current;
  if (status === 'ACCEPTED' && facts.driverEvents > 0) status = 'IN_TRANSIT';
  if (status === 'IN_TRANSIT' && facts.doStatuses.length > 0 && facts.doStatuses.every((s) => POD_DONE_STATUSES.includes(s))) status = 'COMPLETED';
  return status;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(execution): GPS evidence flags, GPS payload schema, stop step rules and status derivation" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 3: POD form validation (pure), POD form resolution and the driver job list

**Files:**
- Create: `src/modules/pods/pod-validation.ts`, `src/modules/pods/pod-form.ts`
- Modify: `src/modules/pod-templates/pod-templates.service.ts`, `src/modules/shipments/driver.routes.ts`, `src/modules/shipments/shipment.types.ts`, `src/modules/shipments/shipment.schemas.ts`
- Test: `test/unit/pod-validation.test.ts`, `test/unit/pod-form.test.ts`, `test/api/driver-pod-form.test.ts`

**Interfaces:**
- Consumes: `PodField`, `PodTemplateDoc`, `StopStatus` (Task 2), `driverScope` (Task 1).
- Produces:
  - `src/modules/pods/pod-validation.ts` — pure, no database imports: `DEFAULT_POD_FIELDS: PodField[]` (`goodsPhoto` photo required min 1 max 5; `receiverName` text required; `receiverSign` signature required); `interface PodFileRef { fieldKey: string; key: string; sha256: string; mime: string; bytes: number }`; `validatePodAnswers(fields: PodField[], answers: Record<string, unknown>, files: PodFileRef[], outcome: 'DELIVERED' | 'FAILED'): Issue[]` — codes `UNKNOWN_FIELD`, `FIELD_REQUIRED`, `INVALID_TYPE`, `OUT_OF_RANGE`, `INVALID_OPTION`, `PHOTO_COUNT`, `SIGNATURE_COUNT`, `FILE_FIELD_MISMATCH`. For `FAILED`, required-ness is not enforced (given values are still type-checked).
  - `resolvePodTemplates(db, pairs: { clientId: ObjectId; jobGroupId: ObjectId | null }[]): Promise<Map<string, PodTemplateDoc | null>>` keyed by `podTemplateKey(clientId, jobGroupId)` — one `find({ clientId: { $in }, status: 'published' })` for any number of DOs, latest version per `(client, jobGroup)`, falling back to the client default (spec §13.2 rule 8). `resolvePodTemplate(db, clientId, jobGroupId)` keeps its signature and delegates to it.
  - `src/modules/pods/pod-form.ts` (preflight S24 — keeps `pod-validation.ts` pure and avoids a `pods.service` ↔ `events.service` cycle): `interface PodForm { templateId: ObjectId | null; version: number; fields: PodField[]; extraSteps: string[] }`, `podFormsFor(db, dos): Promise<Map<doIdHex, PodForm>>` (one template query), `podFormFor(db, d): Promise<PodForm>`.
  - `StopDoc.status: StopStatus`; `ShipmentDoc` gains optional `closedAt?: Date | null`, `closedBy?: string | null`, `summaryId?: ObjectId | null` (optional so existing creators compile); `ShipmentItem` gains `closedAt`, `closedBy`, `summaryId` (all `z.string().nullable().default(null)`) and the stop `status` becomes `z.enum(STOP_STATUSES)`.
  - `GET /driver/shipments` → lists `DISPATCHED`, `ACCEPTED`, `IN_TRANSIT` **and `COMPLETED`** shipments (a completed shipment stays until it is `CLOSED`, so a rejected POD can be resubmitted — P3-R4); each delivery order also carries `podForm: { templateId: string | null; version: number; fields: PodField[]; extraSteps: string[] }`, resolved with one template query per request.

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

`test/unit/pod-form.test.ts`:
```ts
import { ObjectId, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { C } from '../../src/db/collections.js';
import { podFormsFor } from '../../src/modules/pods/pod-form.js';
import { testDb } from '../helpers/db.js';

describe('podFormsFor', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await testDb());
  });
  afterAll(async () => close());

  it('picks the latest published template per client and job group, else the client default, else the built-in form', async () => {
    const clientX = new ObjectId();
    const clientY = new ObjectId();
    const group = new ObjectId();
    const tpl = (clientId: ObjectId, jobGroupId: ObjectId | null, version: number | null, status: 'draft' | 'published') => ({
      _id: new ObjectId(), clientId, jobGroupId, name: `v${version}`, status, version, extraSteps: version === 2 ? ['SEAL_CHECKED'] : [],
      fields: [{ key: `f${version}`, label: 'x', type: 'text', required: true }],
    });
    const defaultV1 = tpl(clientX, null, 1, 'published');
    const defaultV2 = tpl(clientX, null, 2, 'published');
    const groupV1 = tpl(clientX, group, 1, 'published');
    const draft = tpl(clientX, group, null, 'draft');
    for (const t of [defaultV1, defaultV2, groupV1, draft]) await db.collection(C.podTemplates).insertOne(t);
    const doOf = (clientId: ObjectId, jobGroupId: ObjectId | null) => ({ _id: new ObjectId(), clientId, jobGroupId });
    const inGroup = doOf(clientX, group);
    const otherGroup = doOf(clientX, new ObjectId());
    const noGroup = doOf(clientX, null);
    const noTemplates = doOf(clientY, null);
    const forms = await podFormsFor(db, [inGroup, otherGroup, noGroup, noTemplates]);
    expect(forms.get(inGroup._id.toHexString())).toMatchObject({ templateId: groupV1._id, version: 1, extraSteps: [] });
    expect(forms.get(otherGroup._id.toHexString())).toMatchObject({ templateId: defaultV2._id, version: 2, extraSteps: ['SEAL_CHECKED'] });
    expect(forms.get(noGroup._id.toHexString())).toMatchObject({ templateId: defaultV2._id, version: 2 });
    expect(forms.get(noTemplates._id.toHexString())).toMatchObject({ templateId: null, version: 0, extraSteps: [] });
    expect(forms.get(noTemplates._id.toHexString())!.fields.map((f) => f.key)).toEqual(['goodsPhoto', 'receiverName', 'receiverSign']);
  });
});
```

The "reports every problem" case expects exactly one issue per problem: `receiverName` missing (`FIELD_REQUIRED`), signature missing (`SIGNATURE_COUNT`), 6 photos > max 5 (`PHOTO_COUNT`), `tempC` 20 > 10 (`OUT_OF_RANGE`), `condition` not an option (`INVALID_OPTION`), `sealOk` not boolean (`INVALID_TYPE`), answer key `extra` (`UNKNOWN_FIELD`), file with fieldKey `unknown` (`FILE_FIELD_MISMATCH`).

`test/api/driver-pod-form.test.ts`:
```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/pod-validation.test.ts test/unit/pod-form.test.ts test/api/driver-pod-form.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement validation (pure)**

`src/modules/pods/pod-validation.ts`:
```ts
import type { Issue } from '../../lib/issues.js';
import type { PodField } from '../pod-templates/pod-templates.schemas.js';

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

- [ ] **Step 4: Resolve POD forms in one query**

In `src/modules/pod-templates/pod-templates.service.ts` replace `resolvePodTemplate` with:
```ts
export const podTemplateKey = (clientId: ObjectId, jobGroupId: ObjectId | null) => `${clientId.toHexString()}|${jobGroupId?.toHexString() ?? ''}`;

/**
 * Latest published template per (client, job group) for many DOs at once, falling back to the
 * client's default (jobGroupId null) template. One query per call (spec §13.2 rule 8); published
 * templates per client are few, so loading them all is bounded.
 */
export async function resolvePodTemplates(
  db: Db,
  pairs: { clientId: ObjectId; jobGroupId: ObjectId | null }[],
): Promise<Map<string, PodTemplateDoc | null>> {
  const out = new Map<string, PodTemplateDoc | null>();
  if (pairs.length === 0) return out;
  const clientIds = [...new Map(pairs.map((p) => [p.clientId.toHexString(), p.clientId])).values()];
  const published = await db.collection<PodTemplateDoc>(C.podTemplates).find({ clientId: { $in: clientIds }, status: 'published' }).toArray();
  const latest = new Map<string, PodTemplateDoc>();
  for (const t of published) {
    const key = podTemplateKey(t.clientId, t.jobGroupId);
    const current = latest.get(key);
    if (!current || (t.version ?? 0) > (current.version ?? 0)) latest.set(key, t);
  }
  for (const p of pairs) {
    const specific = p.jobGroupId ? latest.get(podTemplateKey(p.clientId, p.jobGroupId)) : undefined;
    out.set(podTemplateKey(p.clientId, p.jobGroupId), specific ?? latest.get(podTemplateKey(p.clientId, null)) ?? null);
  }
  return out;
}

export async function resolvePodTemplate(db: Db, clientId: ObjectId, jobGroupId: ObjectId | null): Promise<PodTemplateDoc | null> {
  return (await resolvePodTemplates(db, [{ clientId, jobGroupId }])).get(podTemplateKey(clientId, jobGroupId)) ?? null;
}
```
(`test/api/pod-templates.test.ts` keeps covering `resolvePodTemplate`.)

`src/modules/pods/pod-form.ts`:
```ts
import type { Db, ObjectId } from 'mongodb';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import type { PodField } from '../pod-templates/pod-templates.schemas.js';
import { type PodTemplateDoc, podTemplateKey, resolvePodTemplates } from '../pod-templates/pod-templates.service.js';
import { DEFAULT_POD_FIELDS } from './pod-validation.js';

export interface PodForm {
  templateId: ObjectId | null;
  version: number;
  fields: PodField[];
  extraSteps: string[];
}

type DoRef = Pick<DeliveryOrderDoc, '_id' | 'clientId' | 'jobGroupId'>;

const formOf = (tpl: PodTemplateDoc | null): PodForm =>
  tpl
    ? { templateId: tpl._id, version: tpl.version ?? 0, fields: tpl.fields, extraSteps: tpl.extraSteps }
    : { templateId: null, version: 0, fields: DEFAULT_POD_FIELDS, extraSteps: [] };

/** POD form per DO (keyed by DO id hex), with one template query for the whole list. */
export async function podFormsFor(db: Db, dos: DoRef[]): Promise<Map<string, PodForm>> {
  const templates = await resolvePodTemplates(db, dos.map((d) => ({ clientId: d.clientId, jobGroupId: d.jobGroupId })));
  return new Map(dos.map((d) => [d._id.toHexString(), formOf(templates.get(podTemplateKey(d.clientId, d.jobGroupId)) ?? null)]));
}

export async function podFormFor(db: Db, d: DoRef): Promise<PodForm> {
  return (await podFormsFor(db, [d])).get(d._id.toHexString())!;
}
```

- [ ] **Step 5: Extend shipment types/schemas and the driver list**

`src/modules/shipments/shipment.types.ts`: `import type { StopStatus } from '../../lib/status.js';`, change `StopDoc.status` to `StopStatus`; add to `ShipmentDoc`: `closedAt?: Date | null; closedBy?: string | null; summaryId?: ObjectId | null;` (optional so existing creators compile).

`src/modules/shipments/shipment.schemas.ts` — in `ShipmentItem` add:
```ts
  closedAt: z.string().nullable().default(null),
  closedBy: z.string().nullable().default(null),
  summaryId: z.string().nullable().default(null),
```
and change the stop `status` schema to `z.enum(STOP_STATUSES)` (import `STOP_STATUSES` from `../../lib/status.js`).

`src/modules/shipments/driver.routes.ts` — add `import { podFormsFor } from '../pods/pod-form.js';` and define
```ts
const PodFormOut = z.object({
  templateId: z.string().nullable(),
  version: z.number(),
  extraSteps: z.array(z.string()),
  fields: z.array(z.object({ key: z.string(), label: z.string(), type: z.string(), required: z.boolean(), min: z.number().optional(), max: z.number().optional(), unit: z.string().optional(), options: z.array(z.string()).optional() })),
});
const DriverShipment = ShipmentItem.extend({ deliveryOrders: z.array(DoItem.extend({ podForm: PodFormOut })), locations: z.array(LocationLite) });
```
and change the list handler to:
```ts
  app.get('/driver/shipments', { schema: { tags: ['driver'], response: { 200: z.object({ items: z.array(DriverShipment) }) } }, preHandler: driverOnly }, async (req) => {
    const driverId = driverIdOf(req);
    // COMPLETED stays listed until the shipment is CLOSED so the driver can resubmit a rejected POD (P3-R4).
    const docs = await coll()
      .find({ status: { $in: ['DISPATCHED', 'ACCEPTED', 'IN_TRANSIT', 'COMPLETED'] }, ...driverScope(driverId) })
      .sort({ plannedStart: 1 })
      .limit(50)
      .toArray();
    const allDoIds = docs.flatMap((d) => doIdsOf(d.stops));
    const allLocIds = docs.flatMap((d) => d.stops.map((s) => s.locationId));
    const [dos, locs] = await Promise.all([
      app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).find({ _id: { $in: allDoIds } }).toArray(),
      app.db.collection(C.locations).find({ _id: { $in: allLocIds } }).toArray(),
    ]);
    const forms = await podFormsFor(app.db, dos);
    const doById = new Map(dos.map((d) => [d._id.toHexString(), d]));
    const locById = new Map(locs.map((l) => [l._id.toHexString(), l]));
    const items = docs.map((doc) => ({
      ...shipmentView(doc),
      deliveryOrders: doIdsOf(doc.stops)
        .map((id) => doById.get(id.toHexString()))
        .filter((d): d is DeliveryOrderDoc => !!d)
        .map((d) => ({ ...toApi(d), podForm: toApi(forms.get(d._id.toHexString())!) })),
      locations: [...new Set(doc.stops.map((s) => s.locationId.toHexString()))]
        .map((id) => locById.get(id))
        .filter((l): l is NonNullable<typeof l> => !!l)
        .map((l) => ({ id: l._id.toHexString(), code: l.code, name: l.name, lat: l.geo.coordinates[1], lng: l.geo.coordinates[0], geofenceRadiusM: l.geofenceRadiusM })),
    }));
    return { items };
  });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS (existing shipment tests still pass with the new nullable fields).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(pods): POD form validation, batched POD form resolution and POD form in the driver job list" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 4: Driver events (`POST /driver/events`) and shipment timeline

**Files:**
- Create: `src/modules/execution/stop-context.ts`, `src/modules/execution/events.service.ts`, `src/modules/execution/events.routes.ts`, `test/helpers/execution.ts`
- Modify: `src/db/collections.ts`, `src/db/indexes.ts`, `src/routes.ts`
- Test: `test/api/driver-events.test.ts`

**Interfaces:**
- Consumes: step rules (Task 2), `deriveStopStatus`, `deriveDoStatus`, `deriveShipmentStatus`, `POD_DONE_STATUSES` (Task 2 `lib/status.ts`), `gpsFlags`, `GpsFields`, `driverIdOf`, `loadDriverShipment` (Task 1 `shipments/driver-access.ts`), `withTransaction`, `podFormsFor` (Task 3, for allowed extra steps), `ok` (Task 1).
- Produces:
  - `C.events`; indexes `events { clientEventId: 1 } unique`, `{ shipmentId: 1, deviceTime: 1 }`.
  - `src/modules/execution/stop-context.ts` (shared by Tasks 4, 5 and 7): `doneStepsAt(db, shipmentId, stopId): Promise<Set<string>>` (event codes recorded at the stop), `interface GeofenceTarget { lat; lng; radiusM }`, `geofenceTarget(db, locationId): Promise<GeofenceTarget | undefined>`.
  - `interface EventDoc { _id; clientEventId; shipmentId; stopId: ObjectId | null; doId: ObjectId | null; code; reasonCode: string | null; note: string | null; deviceTime; receivedAt; lat; lng; accuracyM; noGpsReason; geofenceDistanceM: number | null; source: 'app'; by: string; flags: string[] }`.
  - `EVENT_ACTIVE_STATUSES: ShipmentStatus[] = ['ACCEPTED', 'IN_TRANSIT', 'COMPLETED']` — events on a `COMPLETED` shipment are accepted and change no shipment status (P3-R4: `DEPARTED` follows the POD at the last drop, spec §5.3).
  - `recordDriverEvent(app, by: string, driverId: ObjectId, input: EventInputT): Promise<EventResult>` where `EventResult = { clientEventId: string; status: 'accepted' | 'duplicate' | 'rejected'; eventId: string | null; flags: string[]; code?: string; message?: string }`.
  - Effects of an accepted event (one transaction): event inserted; stop `status` = `deriveStopStatus(steps done)`; shipment `status` = `deriveShipmentStatus(current, { driverEvents: 1, doStatuses: [] })` (only `ACCEPTED → IN_TRANSIT` can follow from an event); `version` incremented with a `{ _id, version }` guard — a concurrent change rejects the event with `SHIPMENT_CHANGED` and nothing is stored (the app resends with the same `clientEventId`); on `LOAD_END` every DO picked up at that stop gets `deriveDoStatus(current, { loaded: true, latestPod: null })` (`PLANNED → PICKED_UP`).
  - `POST /driver/events` body `{ events: EventInput[] }` (1–100) → `{ results: EventResult[] }` (always 200; each event handled in order).
  - `EventInput = { clientEventId: uuid, shipmentId, stopId?: id | null, code: EventCode, reasonCode?: ReasonCode | null, note?: string | null } & GpsFields`. `EXCEPTION` requires `reasonCode`; `reasonCode: 'OTHER'` requires `note`.
  - `GET /shipments/:id/events` (staff) → `{ items: EventItem[] }` ordered by `deviceTime`, then `receivedAt`, then `_id`.
  - Test helpers `at(hhmm, day?)`, `gps(lat?, lng?, time?)`, `acceptedShipment(app, f, opts?)` (creates DO(s), shipment on M1/D1, plans, dispatches, accepts — every step asserted with `ok()`; returns `{ shipment, dos }`) and `tap(app, f, shipment, stopIndex, code, extra?)`.

- [ ] **Step 1: Write the test helpers**

`test/helpers/execution.ts`:
```ts
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
```

- [ ] **Step 2: Write the failing test**

`test/api/driver-events.test.ts`:
```ts
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
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/api/driver-events.test.ts`
Expected: FAIL — `/driver/events` 404 (`ok()` throws `expected 200, got 404`).

- [ ] **Step 4: Implement the stop context and the service**

Add `events: 'events'` to `C`; add indexes `[C.events]: [{ key: { clientEventId: 1 }, unique: true }, { key: { shipmentId: 1, deviceTime: 1 } }]`.

`src/modules/execution/stop-context.ts`:
```ts
import type { Db, ObjectId } from 'mongodb';
import { C } from '../../db/collections.js';

/** Event codes already recorded at a stop (served by the events { shipmentId, deviceTime } index). */
export async function doneStepsAt(db: Db, shipmentId: ObjectId, stopId: ObjectId): Promise<Set<string>> {
  const rows = await db.collection<{ code: string }>(C.events).find({ shipmentId, stopId }, { projection: { code: 1 } }).toArray();
  return new Set(rows.map((e) => e.code));
}

export interface GeofenceTarget {
  lat: number;
  lng: number;
  radiusM: number;
}

/** The stop location's geofence, used for the OUTSIDE_GEOFENCE flag (spec §5.4). */
export async function geofenceTarget(db: Db, locationId: ObjectId): Promise<GeofenceTarget | undefined> {
  const loc = await db.collection(C.locations).findOne({ _id: locationId }, { projection: { geo: 1, geofenceRadiusM: 1 } });
  return loc ? { lat: loc.geo.coordinates[1], lng: loc.geo.coordinates[0], radiusM: loc.geofenceRadiusM } : undefined;
}
```

`src/modules/execution/events.service.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { AppError, conflict, unprocessable } from '../../lib/errors.js';
import { gpsFlags } from '../../lib/geo.js';
import { GpsFields } from '../../lib/gps.js';
import { objectIdString } from '../../lib/ids.js';
import type { Issue } from '../../lib/issues.js';
import { POD_DONE_STATUSES, deriveDoStatus, deriveShipmentStatus, deriveStopStatus } from '../../lib/status.js';
import { withTransaction } from '../../lib/tx.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import { podFormsFor } from '../pods/pod-form.js';
import { loadDriverShipment } from '../shipments/driver-access.js';
import type { ShipmentDoc, ShipmentStatus } from '../shipments/shipment.types.js';
import {
  EVENT_CODES, EXTRA_EVENTS, GLOBAL_EVENTS, REASON_CODES, STOP_EVENTS,
  type ExtraEventCode, type StopEventCode, checkExtraEvent, checkStopEvent,
} from './event-rules.js';
import { type GeofenceTarget, doneStepsAt, geofenceTarget } from './stop-context.js';

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

/** Driver events are accepted from acceptance until close; COMPLETED allows the last DEPARTED (P3-R4, spec §5.3). */
export const EVENT_ACTIVE_STATUSES: ShipmentStatus[] = ['ACCEPTED', 'IN_TRANSIT', 'COMPLETED'];

export async function recordDriverEvent(app: FastifyInstance, by: string, driverId: ObjectId, input: EventInputT): Promise<EventResult> {
  const base = { clientEventId: input.clientEventId, flags: [] as string[] };
  const events = app.db.collection<EventDoc>(C.events);
  const orders = app.db.collection<DeliveryOrderDoc>(C.deliveryOrders);
  const existing = await events.findOne({ clientEventId: input.clientEventId });
  if (existing) return { ...base, status: 'duplicate', eventId: existing._id.toHexString(), flags: existing.flags };
  try {
    const shipment = await loadDriverShipment(app.db, new ObjectId(input.shipmentId), driverId);
    if (!EVENT_ACTIVE_STATUSES.includes(shipment.status)) {
      throw unprocessable('SHIPMENT_NOT_ACTIVE', `Cannot record events on a ${shipment.status} shipment`);
    }
    if (input.code === 'EXCEPTION' && !input.reasonCode) throw unprocessable('REASON_REQUIRED', 'Choose a reason for the exception');
    if (input.reasonCode === 'OTHER' && !input.note) throw unprocessable('NOTE_REQUIRED', 'Describe the reason');

    const isGlobal = (GLOBAL_EVENTS as readonly string[]).includes(input.code);
    const stopIndex = input.stopId ? shipment.stops.findIndex((s) => s.stopId.toHexString() === input.stopId) : -1;
    if (!isGlobal && stopIndex === -1) throw unprocessable('STOP_REQUIRED', 'Choose the stop for this step');
    const stop = stopIndex >= 0 ? shipment.stops[stopIndex]! : null;

    let target: GeofenceTarget | undefined;
    let doneAfter: Set<string> | null = null;
    if (stop) {
      target = await geofenceTarget(app.db, stop.locationId);
      const done = await doneStepsAt(app.db, shipment._id, stop.stopId);
      const related = await orders.find({ _id: { $in: [...stop.dropDoIds, ...stop.pickupDoIds] } }).toArray();
      const drops = related.filter((d) => stop.dropDoIds.some((id) => id.equals(d._id)));
      const state = {
        hasDrops: stop.dropDoIds.length > 0,
        hasPickups: stop.pickupDoIds.length > 0,
        done,
        allDropsHavePod: drops.every((d) => POD_DONE_STATUSES.includes(d.status)),
      };
      let problem: Issue | null = null;
      if ((STOP_EVENTS as readonly string[]).includes(input.code)) {
        const prev = stopIndex > 0 ? shipment.stops[stopIndex - 1]! : null;
        const prevDeparted = prev ? (await doneStepsAt(app.db, shipment._id, prev.stopId)).has('DEPARTED') : true;
        problem = checkStopEvent(state, input.code as StopEventCode, prevDeparted);
      } else if ((EXTRA_EVENTS as readonly string[]).includes(input.code)) {
        const allowed = new Set<string>();
        for (const form of (await podFormsFor(app.db, related)).values()) for (const s of form.extraSteps) allowed.add(s);
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
      // An event never finishes a DO, so the only system transition it can cause is ACCEPTED → IN_TRANSIT.
      const set: Record<string, unknown> = {
        status: deriveShipmentStatus(shipment.status, { driverEvents: 1, doStatuses: [] }),
        updatedAt: receivedAt,
        updatedBy: by,
      };
      if (stop && doneAfter) set[`stops.${stopIndex}.status`] = deriveStopStatus(doneAfter);
      // The step checks above read outside the transaction; the version guard makes a concurrent
      // tap (head + tail driver, or a retry under a new UUID) lose instead of storing a second step.
      const res = await app.db
        .collection<ShipmentDoc>(C.shipments)
        .updateOne({ _id: shipment._id, version: shipment.version }, { $set: set, $inc: { version: 1 } }, { session });
      if (res.matchedCount === 0) throw conflict('SHIPMENT_CHANGED', 'The shipment changed while this step was being recorded; send it again');
      if (stop && input.code === 'LOAD_END') {
        for (const d of await orders.find({ _id: { $in: stop.pickupDoIds } }, { session }).toArray()) {
          const next = deriveDoStatus(d.status, { loaded: true, latestPod: null });
          if (next !== d.status) {
            await orders.updateOne({ _id: d._id, status: d.status }, { $set: { status: next, updatedAt: receivedAt, updatedBy: by } }, { session });
          }
        }
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
```

Note: DO updates inside the transaction are single `updateOne` calls (`bulkWrite`/`insertMany` are banned there). A `notFound` from `loadDriverShipment` becomes `{ status: 'rejected', code: 'NOT_FOUND' }`.

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
import { driverIdOf } from '../shipments/driver-access.js';
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
  lat: z.number().nullable(), lng: z.number().nullable(), accuracyM: z.number().nullable(), noGpsReason: z.string().nullable(),
  geofenceDistanceM: z.number().nullable(), source: z.string(), by: z.string(), flags: z.array(z.string()),
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
      const items = await app.db
        .collection<EventDoc>(C.events)
        .find({ shipmentId: id })
        .sort({ deviceTime: 1, receivedAt: 1, _id: 1 })
        .limit(1000)
        .toArray();
      return { items: items.map(toApi) };
    },
  );
};
```

Register `eventRoutes` in `src/routes.ts`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`; then run the race test 10× (`for i in $(seq 1 10); do npx vitest run test/api/driver-events.test.ts || break; done`).
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(execution): idempotent driver step events with GPS flags, version guard and shipment timeline" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 5: POD submission (`POST /driver/pods`)

**Files:**
- Create: `src/modules/pods/pods.service.ts`, `src/modules/pods/pods.routes.ts`
- Modify: `src/db/collections.ts`, `src/db/indexes.ts`, `src/routes.ts`, `src/modules/orders/order.types.ts`, `src/modules/orders/orders.schemas.ts`, `test/helpers/execution.ts`
- Test: `test/api/pods-submit.test.ts`

**Interfaces:**
- Consumes: `validatePodAnswers`, `PodFileRef` (Task 3 `pod-validation.ts`), `podFormFor` (Task 3 `pod-form.ts`), `deriveDoStatus`, `deriveShipmentStatus` (Task 2), `doneStepsAt`, `geofenceTarget` (Task 4 `stop-context.ts`), `gpsFlags`, `canonicalJson`, `sha256Hex`, `UPLOAD_TYPES`, `app.storage` (Task 1), `loadDriverShipment`, `driverIdOf` (Task 1 `driver-access.ts`).
- Produces:
  - `C.pods`; indexes `pods { clientPodId: 1 } unique`, `{ status: 1, _id: 1 }` (review queue, paginated by `_id` = arrival order), `{ doId: 1, _id: -1 }` (latest POD per DO), `{ shipmentId: 1, _id: 1 }` (P3-R8).
  - `DeliveryOrderDoc.attempts?: { shipmentId: ObjectId; reasonCode: string; podId: ObjectId; at: Date }[]` (`$push` on failed PODs); `DoItem` exposes `attempts` (default `[]`, spec §3.3).
  - `interface PodDoc { _id; clientPodId; doId; shipmentId; stopId; templateId: ObjectId | null; templateVersion: number; outcome: 'DELIVERED' | 'FAILED'; reasonCode: string | null; note: string | null; answers; files: PodFileRef[] (sorted by key); evidence: { deviceTime; receivedAt; lat; lng; accuracyM; noGpsReason; geofenceDistanceM; device: string | null; appVersion: string | null; offline: boolean }; hash: string; flags: string[]; status: 'submitted' | 'verified' | 'rejected'; review: { by: string; at: Date; reason: string | null } | null; supersedesPodId: ObjectId | null; by: string }`.
  - `podHashOf(p: Pick<PodDoc, 'doId' | 'templateId' | 'templateVersion' | 'answers' | 'files' | 'evidence'>): string` — spec §6.3 exactly (P3-R7): `sha256(canonicalJson({ doId, templateId, templateVersion, answers, files: sha256 values in key order, evidence (dates as ISO strings) }))`.
  - `POD_ACTIVE_STATUSES: ShipmentStatus[] = ['IN_TRANSIT', 'COMPLETED']`.
  - `submitPod(app, by, driverId, input): Promise<{ pod: PodDoc; duplicate: boolean }>`; errors (422) in check order: `SHIPMENT_NOT_ACTIVE`, `DO_NOT_READY` (DELIVERED needs DO `PICKED_UP` or `POD_REJECTED`; FAILED needs `PLANNED`, `PICKED_UP` or `POD_REJECTED`), `STEP_REQUIRED` (DELIVERED needs `UNLOAD_END` at the drop stop; FAILED needs `ARRIVED` there), `REASON_REQUIRED`, `NOTE_REQUIRED`, then the cheap file-reference checks `FILE_KEY_INVALID` (key outside `pods/{shipmentId}/{doId}/`), `FILE_TYPE_INVALID` (mime not in `UPLOAD_TYPES`), then `POD_INVALID` (details `{ issues }` = form issues), then the storage checks `FILE_MISSING`, `FILE_TOO_LARGE`, `FILE_HASH_MISMATCH` (P3-R3).
  - Effects (one transaction): pod inserted; DO status = `deriveDoStatus(current, { loaded, latestPod: { outcome, status: 'submitted' } })` (`DELIVERED` / `FAILED`, + `attempts` push on FAILED); `supersedesPodId` = previous latest pod of the DO when it was `rejected`; the shipment is re-read inside the transaction and its `status` set to `deriveShipmentStatus(current, { driverEvents: 1, doStatuses })` with `version` + 1 on every POD — two PODs that finish the last DOs together conflict on the shipment document, so the retried one sees both DOs done and completion is never missed.
  - Route `POST /driver/pods` → 201 `PodItem` (200 with the original pod when `clientPodId` was already used).
  - `PodItem` zod schema (API shape of `PodDoc`, dates as strings) exported for Task 6.
  - Test helpers `tinyJpeg(tag?) → Buffer` (a decodable 1×1 JPEG made unique by a COM segment — P3-R3), `uploadPhoto(app, f, shipmentId, doId, body = tinyJpeg()) → { key, sha256, mime, bytes }` (presign asserted with `ok()` + `MemoryStorage.put`), `deliveredPod(app, f, shipment, doc, extra?)` (returns the raw response) and `toDropStop(app, f, shipment)`.

- [ ] **Step 1: Extend the test helpers**

In `test/helpers/execution.ts` replace the import block at the top with:
```ts
import { createHash, randomUUID } from 'node:crypto';
import type { App } from '../../src/app.js';
import type { MemoryStorage } from '../../src/modules/storage/storage.js';
import { ok } from './http.js';
import { type PlanningFixtures, createDo, postShipment } from './planning.js';
```
and append:
```ts
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
```

- [ ] **Step 2: Write the failing test**

`test/api/pods-submit.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { canonicalJson, sha256Hex } from '../../src/lib/canonical.js';
import type { MemoryStorage } from '../../src/modules/storage/storage.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { acceptedShipment, at, deliveredPod, gps, tap, tinyJpeg, toDropStop, uploadPhoto } from '../helpers/execution.js';
import { ok } from '../helpers/http.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

describe('POD submission', () => {
  let app: App;
  let f: PlanningFixtures;
  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('accepts a delivered POD, hashes it per spec §6.3, completes the shipment and still takes the last DEPARTED', async () => {
    const { shipment, dos } = await acceptedShipment(app, f);
    expect((await deliveredPod(app, f, shipment, dos[0])).json().code).toBe('SHIPMENT_NOT_ACTIVE'); // ACCEPTED: the trip has not started
    for (const code of ['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED']) await tap(app, f, shipment, 0, code);
    await tap(app, f, shipment, 1, 'ARRIVED', gps(13.75, 100.5, at('10:00')));
    expect((await deliveredPod(app, f, shipment, dos[0])).json().code).toBe('STEP_REQUIRED'); // UNLOAD_END not recorded yet
    await tap(app, f, shipment, 1, 'UNLOAD_START', gps(13.75, 100.5, at('10:10')));
    await tap(app, f, shipment, 1, 'UNLOAD_END', gps(13.75, 100.5, at('10:40')));
    const pod = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    expect(pod).toMatchObject({ outcome: 'DELIVERED', status: 'submitted', templateId: null, templateVersion: 0, supersedesPodId: null });
    const stored = (await app.db.collection(C.pods).findOne({ _id: new ObjectId(pod.id) }))!;
    const expectedHash = sha256Hex(
      canonicalJson({
        doId: dos[0].id,
        templateId: null,
        templateVersion: 0,
        answers: { receiverName: 'คุณสมศรี' },
        files: [...stored.files].sort((a, b) => (a.key < b.key ? -1 : 1)).map((x: { sha256: string }) => x.sha256),
        evidence: { ...stored.evidence, deviceTime: stored.evidence.deviceTime.toISOString(), receivedAt: stored.evidence.receivedAt.toISOString() },
      }),
    );
    expect(pod.hash).toBe(expectedHash);
    expect(pod.evidence.geofenceDistanceM).toBeLessThan(300);
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo })).toMatchObject({ status: 'DELIVERED' });
    expect(await app.db.collection(C.shipments).findOne({ shipmentNo: shipment.shipmentNo })).toMatchObject({ status: 'COMPLETED' });
    // A COMPLETED shipment still takes the DEPARTED after the last POD (spec §5.3, P3-R4).
    expect((await tap(app, f, shipment, 1, 'DEPARTED', gps(13.75, 100.5, at('11:30')))).status).toBe('accepted');
    const after = await app.db.collection(C.shipments).findOne({ shipmentNo: shipment.shipmentNo });
    expect(after).toMatchObject({ status: 'COMPLETED' });
    expect(after?.stops[1].status).toBe('DONE');
  });

  it('rejects incomplete forms and tampered, foreign, mistyped or missing files', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-06' });
    await toDropStop(app, f, shipment);
    expect((await deliveredPod(app, f, shipment, dos[0], { answers: {} })).json().code).toBe('POD_INVALID');
    const photo = await uploadPhoto(app, f, shipment.id, dos[0].id);
    const sign = await uploadPhoto(app, f, shipment.id, dos[0].id, tinyJpeg('sig'));
    const submit = (files: object[]) =>
      app.inject({
        method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1,
        payload: { clientPodId: randomUUID(), doId: dos[0].id, outcome: 'DELIVERED', answers: { receiverName: 'x' }, files, ...gps(13.75, 100.5, at('11:00', '2026-10-06')) },
      });
    await (app.storage as MemoryStorage).put(photo.key, tinyJpeg('swapped'), 'image/jpeg');
    expect((await submit([{ fieldKey: 'goodsPhoto', ...photo }, { fieldKey: 'receiverSign', ...sign }])).json().code).toBe('FILE_HASH_MISMATCH');
    const foreign = await deliveredPod(app, f, shipment, dos[0], { files: [{ fieldKey: 'goodsPhoto', key: 'pods/other/x.jpg', sha256: 'a'.repeat(64), mime: 'image/jpeg', bytes: 1 }] });
    expect(foreign.json().code).toBe('FILE_KEY_INVALID'); // reference checks run before the form check
    expect((await submit([{ fieldKey: 'goodsPhoto', ...photo, mime: 'application/pdf' }, { fieldKey: 'receiverSign', ...sign }])).json().code).toBe('FILE_TYPE_INVALID');
    const missing = { fieldKey: 'goodsPhoto', key: `pods/${shipment.id}/${dos[0].id}/${randomUUID()}.jpg`, sha256: 'b'.repeat(64), mime: 'image/jpeg', bytes: 10 };
    expect((await submit([missing, { fieldKey: 'receiverSign', ...sign }])).json().code).toBe('FILE_MISSING');
    const doId = (await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo }))!._id;
    expect(await app.db.collection(C.pods).countDocuments({ doId })).toBe(0);
  });

  it('records a failed delivery with a reason and returns the same POD on replay', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-07' });
    for (const code of ['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED']) await tap(app, f, shipment, 0, code);
    await tap(app, f, shipment, 1, 'ARRIVED', gps(13.75, 100.5, at('10:00', '2026-10-07')));
    const payload = { clientPodId: randomUUID(), doId: dos[0].id, outcome: 'FAILED', answers: {}, files: [], ...gps(13.75, 100.5, at('10:05', '2026-10-07')) };
    const noReason = await app.inject({ method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1, payload });
    expect(noReason.json().code).toBe('REASON_REQUIRED');
    const failed = ok(await app.inject({ method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1, payload: { ...payload, reasonCode: 'CONSIGNEE_CLOSED' } }), 201);
    const replay = ok(await app.inject({ method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1, payload: { ...payload, reasonCode: 'CONSIGNEE_CLOSED' } }), 200);
    expect(replay.id).toBe(failed.id);
    const d = await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo });
    expect(d).toMatchObject({ status: 'FAILED' });
    expect(d?.attempts).toHaveLength(1);
    const api = ok(await app.inject({ method: 'GET', url: `/api/v1/delivery-orders/${dos[0].id}`, headers: f.viewer }));
    expect(api.attempts).toEqual([expect.objectContaining({ reasonCode: 'CONSIGNEE_CLOSED', podId: failed.id, shipmentId: shipment.id })]);
    expect(await app.db.collection(C.shipments).findOne({ shipmentNo: shipment.shipmentNo })).toMatchObject({ status: 'COMPLETED' });
  });

  it('completes the shipment when the last two PODs arrive at the same moment', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-08', doOverrides: [{}, {}] });
    await toDropStop(app, f, shipment);
    const [a, b] = await Promise.all([deliveredPod(app, f, shipment, dos[0]), deliveredPod(app, f, shipment, dos[1])]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(await app.db.collection(C.shipments).findOne({ shipmentNo: shipment.shipmentNo })).toMatchObject({ status: 'COMPLETED' });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/api/pods-submit.test.ts`
Expected: FAIL — `/driver/pods` 404.

- [ ] **Step 4: Implement the service**

Add `pods: 'pods'` to `C`; add indexes:
```ts
  [C.pods]: [
    { key: { clientPodId: 1 }, unique: true },
    { key: { status: 1, _id: 1 } },
    { key: { doId: 1, _id: -1 } },
    { key: { shipmentId: 1, _id: 1 } },
  ],
```
In `order.types.ts` add `attempts?: { shipmentId: ObjectId; reasonCode: string; podId: ObjectId; at: Date }[];` to `DeliveryOrderDoc`. In `orders.schemas.ts` add to `DoItem`:
```ts
  attempts: z.array(z.object({ shipmentId: z.string(), reasonCode: z.string(), podId: z.string(), at: z.string() })).default([]),
```

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
import { deriveDoStatus, deriveShipmentStatus } from '../../lib/status.js';
import { withTransaction } from '../../lib/tx.js';
import { REASON_CODES } from '../execution/event-rules.js';
import { doneStepsAt, geofenceTarget } from '../execution/stop-context.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import { loadDriverShipment } from '../shipments/driver-access.js';
import { doIdsOf } from '../shipments/shipment.service.js';
import type { ShipmentDoc, ShipmentStatus } from '../shipments/shipment.types.js';
import { UPLOAD_TYPES } from '../storage/storage.js';
import { podFormFor } from './pod-form.js';
import { type PodFileRef, validatePodAnswers } from './pod-validation.js';

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

export const POD_ACTIVE_STATUSES: ShipmentStatus[] = ['IN_TRANSIT', 'COMPLETED'];

const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Tamper-evidence hash, spec §6.3: SHA-256 of the canonical JSON of { doId, templateId, templateVersion, answers, files[].sha256, evidence }. */
export function podHashOf(p: Pick<PodDoc, 'doId' | 'templateId' | 'templateVersion' | 'answers' | 'files' | 'evidence'>): string {
  return sha256Hex(
    canonicalJson({
      doId: p.doId.toHexString(),
      templateId: p.templateId?.toHexString() ?? null,
      templateVersion: p.templateVersion,
      answers: p.answers,
      files: [...p.files].sort(byKey).map((f) => f.sha256),
      evidence: { ...p.evidence, deviceTime: p.evidence.deviceTime.toISOString(), receivedAt: p.evidence.receivedAt.toISOString() },
    }),
  );
}

export async function submitPod(app: FastifyInstance, by: string, driverId: ObjectId, input: PodInputT): Promise<{ pod: PodDoc; duplicate: boolean }> {
  const pods = app.db.collection<PodDoc>(C.pods);
  const orders = app.db.collection<DeliveryOrderDoc>(C.deliveryOrders);
  const shipments = app.db.collection<ShipmentDoc>(C.shipments);
  const dup = await pods.findOne({ clientPodId: input.clientPodId });
  if (dup) return { pod: dup, duplicate: true };

  const d = await orders.findOne({ _id: new ObjectId(input.doId) });
  if (!d || !d.shipmentId) throw notFound('Delivery order');
  const shipment = await loadDriverShipment(app.db, d.shipmentId, driverId);
  if (!POD_ACTIVE_STATUSES.includes(shipment.status)) throw unprocessable('SHIPMENT_NOT_ACTIVE', `Cannot submit a POD on a ${shipment.status} shipment`);

  const allowed: DeliveryOrderDoc['status'][] = input.outcome === 'DELIVERED' ? ['PICKED_UP', 'POD_REJECTED'] : ['PLANNED', 'PICKED_UP', 'POD_REJECTED'];
  if (!allowed.includes(d.status)) throw unprocessable('DO_NOT_READY', `A ${d.status} delivery order cannot take a ${input.outcome} POD`);
  const stop = shipment.stops.find((s) => s.dropDoIds.some((id) => id.equals(d._id)))!;
  const done = await doneStepsAt(app.db, shipment._id, stop.stopId);
  const needed = input.outcome === 'DELIVERED' ? 'UNLOAD_END' : 'ARRIVED';
  if (!done.has(needed)) throw unprocessable('STEP_REQUIRED', `Record ${needed} at the drop stop first`);
  if (input.outcome === 'FAILED' && !input.reasonCode) throw unprocessable('REASON_REQUIRED', 'Choose why the delivery failed');
  if (input.reasonCode === 'OTHER' && !input.note) throw unprocessable('NOTE_REQUIRED', 'Describe the reason');

  // Cheap reference checks first, so a foreign key or a non-image type is reported as such rather
  // than hidden behind a form problem; storage reads (existence, size, hash) come after the form check.
  const prefix = `pods/${shipment._id.toHexString()}/${d._id.toHexString()}/`;
  for (const file of input.files) {
    if (!file.key.startsWith(prefix)) throw unprocessable('FILE_KEY_INVALID', `${file.key} does not belong to this delivery order`);
    if (!(file.mime in UPLOAD_TYPES)) throw unprocessable('FILE_TYPE_INVALID', `${file.mime} is not an allowed image type`);
  }

  const form = await podFormFor(app.db, d);
  const formIssues = validatePodAnswers(form.fields, input.answers, input.files, input.outcome);
  if (formIssues.length > 0) throw unprocessable('POD_INVALID', 'The POD form is incomplete or invalid', { issues: formIssues });

  for (const file of input.files) {
    const stored = await app.storage.get(file.key);
    if (!stored) throw unprocessable('FILE_MISSING', `${file.key} was not uploaded`);
    if (stored.body.length > app.config.UPLOAD_MAX_BYTES) throw unprocessable('FILE_TOO_LARGE', `${file.key} is larger than ${app.config.UPLOAD_MAX_BYTES} bytes`);
    if (sha256Hex(stored.body) !== file.sha256) throw unprocessable('FILE_HASH_MISMATCH', `${file.key} does not match its fingerprint`);
  }

  const receivedAt = new Date();
  const deviceTime = new Date(input.deviceTime);
  const { flags, distanceM } = gpsFlags({
    lat: input.lat, lng: input.lng, accuracyM: input.accuracyM, deviceTime, receivedAt,
    target: await geofenceTarget(app.db, stop.locationId),
  });
  const evidence: PodDoc['evidence'] = {
    deviceTime, receivedAt, lat: input.lat, lng: input.lng, accuracyM: input.accuracyM, noGpsReason: input.noGpsReason,
    geofenceDistanceM: distanceM, device: input.device, appVersion: input.appVersion, offline: input.offline,
  };
  const previous = await pods.find({ doId: d._id }).sort({ _id: -1 }).limit(1).next();
  const files = [...input.files].sort(byKey);
  const hashed = { doId: d._id, templateId: form.templateId, templateVersion: form.version, answers: input.answers, files, evidence };
  const pod: PodDoc = {
    ...hashed,
    _id: new ObjectId(), clientPodId: input.clientPodId, shipmentId: shipment._id, stopId: stop.stopId,
    outcome: input.outcome, reasonCode: input.reasonCode, note: input.note,
    hash: podHashOf(hashed), flags, status: 'submitted', review: null,
    supersedesPodId: previous?.status === 'rejected' ? previous._id : null, by,
  };

  try {
    await withTransaction(app.mongo, async (session) => {
      await pods.insertOne(pod, { session });
      const nextStatus = deriveDoStatus(d.status, { loaded: d.status !== 'PLANNED', latestPod: { outcome: input.outcome, status: 'submitted' } });
      const update: Record<string, unknown> = { $set: { status: nextStatus, updatedAt: receivedAt, updatedBy: by } };
      if (input.outcome === 'FAILED') update.$push = { attempts: { shipmentId: shipment._id, reasonCode: input.reasonCode!, podId: pod._id, at: receivedAt } };
      const res = await orders.updateOne({ _id: d._id, status: d.status }, update, { session });
      if (res.matchedCount === 0) throw unprocessable('DO_NOT_READY', 'The delivery order changed; reload');
      // Re-read the shipment and its DOs inside the transaction and always bump the shipment version:
      // two PODs finishing the last DOs together then conflict on the shipment document, MongoDB
      // retries the loser, and the retry sees both DOs done (no missed completion by write skew).
      const current = (await shipments.findOne({ _id: shipment._id }, { session }))!;
      const all = await orders.find({ _id: { $in: doIdsOf(current.stops) } }, { session }).toArray();
      const status = deriveShipmentStatus(current.status, { driverEvents: 1, doStatuses: all.map((x) => x.status) });
      await shipments.updateOne(
        { _id: current._id, version: current.version },
        { $set: { status, updatedAt: receivedAt, updatedBy: by }, $inc: { version: 1 } },
        { session },
      );
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
import { driverIdOf } from '../shipments/driver-access.js';
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

Run: `npx vitest run && npm run typecheck`; then run the concurrent-completion test 10× (`for i in $(seq 1 10); do npx vitest run test/api/pods-submit.test.ts || break; done`).
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(pods): POD submission with form rules, file fingerprints, spec hash, GPS evidence and completion" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 6: POD review (list, detail with file links, verify, reject, resubmission)

**Files:**
- Modify: `src/modules/pods/pods.routes.ts`
- Test: `test/api/pods-review.test.ts`

**Interfaces:**
- Consumes: `PodDoc`, `PodItem` (Task 5), `deriveDoStatus` (Task 2), `withTransaction`, `writeAudit`, `app.storage.presignGet`, `ok` (Task 1).
- Produces:
  - `GET /pods?status=&shipmentId=&doId=&flagged=true` (staff; paginated, oldest first) → `pageResponse(PodItem)`.
  - `GET /pods/:id` (staff) → `PodItem & { fileUrls: { key: string; url: string }[] }` (5-minute GET links).
  - `POST /pods/:id/verify` (admin, planner — P3-R1) → pod `verified`; the DO status becomes `deriveDoStatus(current, { loaded: true, latestPod: { outcome, status: 'verified' } })`: a DELIVERED pod moves its DO to `POD_VERIFIED`, a FAILED pod leaves it `FAILED`.
  - `POST /pods/:id/reject` (admin, planner — P3-R1) `{ reason }` → pod `rejected`; DO → `POD_REJECTED` (the pod is always the DO's latest, see below).
  - Only a `submitted` pod can be verified/rejected (422 `POD_ALREADY_REVIEWED`). A pod that is not the DO's latest → 422 `POD_SUPERSEDED`; this is defensive only — Task 5 supersedes only `rejected` pods, so `POD_ALREADY_REVIEWED` fires first today. Each review writes exactly one audit entry inside its transaction.

- [ ] **Step 1: Write the failing test**

`test/api/pods-review.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { acceptedShipment, deliveredPod, toDropStop } from '../helpers/execution.js';
import { ok } from '../helpers/http.js';
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
    const pod = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    const queue = ok(await app.inject({ method: 'GET', url: '/api/v1/pods?status=submitted', headers: f.viewer }));
    expect(queue.items.map((p: { id: string }) => p.id)).toContain(pod.id);
    const detail = ok(await app.inject({ method: 'GET', url: `/api/v1/pods/${pod.id}`, headers: f.viewer }));
    expect(detail.fileUrls).toHaveLength(2);
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
    const first = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    const rejected = ok(await post(`/pods/${first.id}/reject`, { reason: 'รูปไม่ชัด' }));
    expect(rejected).toMatchObject({ status: 'rejected', review: { reason: 'รูปไม่ชัด' } });
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo })).toMatchObject({ status: 'POD_REJECTED' });
    const second = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    expect(second.supersedesPodId).toBe(first.id);
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo })).toMatchObject({ status: 'DELIVERED' });
    expect((await post(`/pods/${first.id}/verify`)).json().code).toBe('POD_ALREADY_REVIEWED');
    expect(ok(await post(`/pods/${second.id}/verify`)).status).toBe('verified');
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[0].doNo })).toMatchObject({ status: 'POD_VERIFIED' });
    expect(await app.db.collection(C.auditLog).countDocuments({ entity: 'pod', entityId: { $in: [first.id, second.id] } })).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/pods-review.test.ts`
Expected: FAIL — 404 routes.

- [ ] **Step 3: Implement**

Add to `podRoutes` (imports: `ObjectId`, `type Filter` from `mongodb`; `C` from `../../db/collections.js`; `writeAudit` from `../../lib/audit.js` (next to `actorOf`); `notFound`, `unprocessable` from `../../lib/errors.js`; `IdParams`, `objectIdString` from `../../lib/ids.js`; `PageQuery`, `pageResponse`, `paginate` from `../../lib/pagination.js`; `STAFF_ROLES` from `../../lib/roles.js`; `deriveDoStatus` from `../../lib/status.js`; `withTransaction` from `../../lib/tx.js`; `type DeliveryOrderDoc` from `../orders/order.types.js`; `type PodDoc` from `./pods.service.js`):
```ts
  const staff = app.requireRoles(...STAFF_ROLES);
  const reviewer = app.requireRoles('admin', 'planner'); // POD review: admin or planner (P3-R1)
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
    // Defensive: Task 5 supersedes only rejected PODs, so a submitted POD is always its DO's latest today.
    const latest = await pods().find({ doId: p.doId }).sort({ _id: -1 }).limit(1).next();
    if (!latest?._id.equals(p._id)) throw unprocessable('POD_SUPERSEDED', 'A newer POD exists for this delivery order');
    return withTransaction(app.mongo, async (session) => {
      const updated = await pods().findOneAndUpdate(
        { _id: p._id, status: 'submitted' },
        { $set: { status: decision, review: { by, at: new Date(), reason } } },
        { returnDocument: 'after', session },
      );
      if (!updated) throw unprocessable('POD_ALREADY_REVIEWED', 'This POD was reviewed meanwhile');
      const orders = app.db.collection<DeliveryOrderDoc>(C.deliveryOrders);
      const d = (await orders.findOne({ _id: p.doId }, { session }))!;
      const next = deriveDoStatus(d.status, { loaded: true, latestPod: { outcome: p.outcome, status: decision } });
      if (next !== d.status) {
        await orders.updateOne({ _id: d._id, status: d.status }, { $set: { status: next, updatedAt: new Date(), updatedBy: by } }, { session });
      }
      await writeAudit(app.db, { entity: 'pod', entityId: id, action: decision === 'verified' ? 'verify' : 'reject', by, after: { reason } }, { session });
      return updated;
    });
  }

  app.post('/pods/:id/verify', { schema: { tags: ['pods'], params: IdParams, response: { 200: PodItem } }, preHandler: reviewer }, async (req) =>
    toApi(await review(req.params.id, actorOf(req), 'verified', null)),
  );

  app.post(
    '/pods/:id/reject',
    { schema: { tags: ['pods'], params: IdParams, body: z.object({ reason: z.string().trim().min(3).max(500) }), response: { 200: PodItem } }, preHandler: reviewer },
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
- Consumes: `driverIdOf`, `loadDriverShipment` (Task 1 `driver-access.ts`), `geofenceTarget` (Task 4), `gpsFlags`, `GpsFields`, `doIdsOf`, `withTransaction`, `writeAudit`, `paginate`, `ok` (Task 1).
- Produces:
  - `C.palletMovements`, `C.palletBalances`; indexes `palletMovements { clientEventId: 1 } unique (partial: clientEventId string)`, `{ tailVehicleId: 1, _id: 1 }`, `{ driverId: 1, _id: 1 }`; `palletBalances { tailVehicleId: 1 } unique` (P3-R8: each serves a query below).
  - Movement doc (spec §3.3 names, P3-R7) `{ _id, clientEventId: string | null, tailVehicleId, driverId: ObjectId | null, shipmentId: ObjectId | null, doId: ObjectId | null, stopId: ObjectId | null, locationId: ObjectId | null, typeCode, sign, qty, remark: string | null, deviceTime: Date, receivedAt: Date, lat, lng, accuracyM, noGpsReason, geofenceDistanceM: number | null, flags, balanceAfter, source: 'app' | 'admin', by }`; balance doc `{ tailVehicleId, balance, lastMovementAt }`.
  - `POST /driver/pallet-movements` (driver) `{ movements: ({ clientEventId, shipmentId, stopId?, doId?, typeCode, qty (int ≥ 1), remark? } & GpsFields)[] }` (1–50) → `{ results: { clientEventId, status: 'accepted'|'duplicate'|'rejected', balanceAfter: number | null, code?, message? }[] }`. `tailVehicleId` = the shipment's tail, else its head (rigid) vehicle (spec §7). Shipment must be ACCEPTED/IN_TRANSIT/COMPLETED. `stopId`/`doId` must belong to the shipment (422 `INVALID_REFERENCE`); with a `stopId` the movement gets the stop's `locationId` and a geofence check.
  - `POST /pallet-movements` (admin correction) `{ tailVehicleId, typeCode, qty, remark }` → 201 movement; the movement, the balance and **one audit entry** commit in the same transaction (P3-R5).
  - `GET /pallet-balances?tailVehicleId=` (staff) → `{ items: { tailVehicleId, plate, balance, lastMovementAt }[] }`.
  - `GET /pallet-movements?tailVehicleId=&driverId=` (staff and driver; paginated, oldest first by `_id` like every `paginate` list) — a driver always gets only their own movements (the `driverId` filter is forced to theirs; spec §7, §8.2).
  - Each movement: one transaction — upsert `palletBalances` with `$inc: { balance: sign × qty }` and `$max: { lastMovementAt }` (returnDocument after) and insert the movement with `balanceAfter`. A duplicate-key error is reported as `duplicate` only when it is on `clientEventId`; a first-movement race on the balance upsert (`tailVehicleId`) is retried once.

- [ ] **Step 1: Write the failing test**

`test/api/pallets.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { acceptedShipment, gps } from '../helpers/execution.js';
import { ok } from '../helpers/http.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

describe('pallets', () => {
  let app: App;
  let f: PlanningFixtures;
  let shipment: { id: string; stops: { stopId: string }[] };
  const move = (typeCode: string, qty: number, id = randomUUID(), extra: object = {}) => ({ clientEventId: id, shipmentId: shipment.id, typeCode, qty, ...gps(), ...extra });
  const send = (movements: object[]) => app.inject({ method: 'POST', url: '/api/v1/driver/pallet-movements', headers: f.driver1, payload: { movements } });
  const balances = async () => ok(await app.inject({ method: 'GET', url: `/api/v1/pallet-balances?tailVehicleId=${f.ids.m1}`, headers: f.viewer })).items;

  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
    shipment = (await acceptedShipment(app, f)).shipment;
  });
  afterAll(async () => closeTestApp(app));

  it('keeps a running balance per vehicle, records the stop, and is idempotent', async () => {
    const id = randomUUID();
    const res = ok(await send([move('RETURN_IN', 10, id, { stopId: shipment.stops[0].stopId }), move('DEPOSIT', 3)])).results;
    expect(res.map((r: { balanceAfter: number }) => r.balanceAfter)).toEqual([10, 7]);
    expect(ok(await send([move('RETURN_IN', 10, id)])).results[0].status).toBe('duplicate');
    expect(ok(await send([move('NOPE', 1)])).results[0].code).toBe('INVALID_REFERENCE');
    expect(ok(await send([move('DEPOSIT', 1, randomUUID(), { stopId: new ObjectId().toHexString() })])).results[0]).toMatchObject({ status: 'rejected', code: 'INVALID_REFERENCE' });
    expect(await balances()).toEqual([expect.objectContaining({ tailVehicleId: f.ids.m1, plate: '80-3001', balance: 7 })]);
    const first = (await app.db.collection(C.palletMovements).findOne({ clientEventId: id }))!;
    expect(first.tailVehicleId.toHexString()).toBe(f.ids.m1); // rigid mixer: no tail, so the head vehicle carries the pallets
    expect(first.stopId.toHexString()).toBe(shipment.stops[0].stopId);
    expect(first.locationId).toBeInstanceOf(ObjectId);
    expect(first.flags).toEqual([]); // tapped inside plant A's geofence
  });

  it('serialises concurrent movements on the same vehicle', async () => {
    const before = (await balances())[0].balance;
    const results = await Promise.all(Array.from({ length: 5 }, () => send([move('RETURN_IN', 2)])));
    const afters = results.map((r) => ok(r).results[0].balanceAfter).sort((a: number, b: number) => a - b);
    expect(afters).toEqual([before + 2, before + 4, before + 6, before + 8, before + 10]);
  });

  it('lets an admin correct the balance with one audit entry, and lets drivers read only their own movements', async () => {
    const correction = { tailVehicleId: f.ids.m1, typeCode: 'DEPOSIT', qty: 1, remark: 'นับสต็อกจริง' };
    expect((await app.inject({ method: 'POST', url: '/api/v1/pallet-movements', headers: f.planner, payload: correction })).statusCode).toBe(403);
    const res = ok(await app.inject({ method: 'POST', url: '/api/v1/pallet-movements', headers: f.admin, payload: correction }), 201);
    expect(res).toMatchObject({ source: 'admin', remark: 'นับสต็อกจริง', driverId: null });
    expect(await app.db.collection(C.auditLog).countDocuments({ entity: 'palletMovement', entityId: res.id })).toBe(1);
    const all = ok(await app.inject({ method: 'GET', url: `/api/v1/pallet-movements?tailVehicleId=${f.ids.m1}`, headers: f.viewer }));
    expect(all.items).toHaveLength(8); // 2 + 5 driver movements + 1 correction
    const mine = ok(await app.inject({ method: 'GET', url: '/api/v1/pallet-movements', headers: f.driver1 }));
    expect(mine.items).toHaveLength(7);
    expect(mine.items.every((m: { driverId: string }) => m.driverId === f.ids.d1)).toBe(true);
    expect(ok(await app.inject({ method: 'GET', url: `/api/v1/pallet-movements?driverId=${f.ids.d1}`, headers: f.driver2 })).items).toEqual([]);
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
    { key: { tailVehicleId: 1, _id: 1 } },
    { key: { driverId: 1, _id: 1 } },
  ],
  [C.palletBalances]: [{ key: { tailVehicleId: 1 }, unique: true }],
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
import type { UserPrincipal } from '../../lib/principal.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import { withTransaction } from '../../lib/tx.js';
import { geofenceTarget } from '../execution/stop-context.js';
import { driverIdOf, loadDriverShipment } from '../shipments/driver-access.js';
import { doIdsOf } from '../shipments/shipment.service.js';
import type { ShipmentStatus } from '../shipments/shipment.types.js';

interface MovementDoc {
  _id: ObjectId; clientEventId: string | null; tailVehicleId: ObjectId; driverId: ObjectId | null; shipmentId: ObjectId | null; doId: ObjectId | null;
  stopId: ObjectId | null; locationId: ObjectId | null; typeCode: string; sign: number; qty: number; remark: string | null;
  deviceTime: Date; receivedAt: Date; lat: number | null; lng: number | null; accuracyM: number | null; noGpsReason: string | null;
  geofenceDistanceM: number | null; flags: string[]; balanceAfter: number; source: 'app' | 'admin'; by: string;
}

interface BalanceDoc {
  _id: ObjectId;
  tailVehicleId: ObjectId;
  balance: number;
  lastMovementAt: Date;
}

const MovementItem = z.object({
  id: z.string(), clientEventId: z.string().nullable(), tailVehicleId: z.string(), driverId: z.string().nullable(), shipmentId: z.string().nullable(),
  doId: z.string().nullable(), stopId: z.string().nullable(), locationId: z.string().nullable(), typeCode: z.string(), sign: z.number(), qty: z.number(),
  remark: z.string().nullable(), deviceTime: z.string(), receivedAt: z.string(), lat: z.number().nullable(), lng: z.number().nullable(),
  accuracyM: z.number().nullable(), noGpsReason: z.string().nullable(), geofenceDistanceM: z.number().nullable(), flags: z.array(z.string()),
  balanceAfter: z.number(), source: z.enum(['app', 'admin']), by: z.string(),
});

const PALLET_ACTIVE_STATUSES: ShipmentStatus[] = ['ACCEPTED', 'IN_TRANSIT', 'COMPLETED'];

const isDuplicateKey = (e: unknown, field: string) =>
  (e as { code?: unknown }).code === 11000 && !!(e as { keyPattern?: Record<string, unknown> }).keyPattern?.[field];

async function applyMovement(
  app: FastifyInstance,
  m: Omit<MovementDoc, '_id' | 'sign' | 'balanceAfter'>,
  audit?: { action: string },
): Promise<MovementDoc> {
  const type = await app.db.collection(C.palletMovementTypes).findOne({ code: m.typeCode, active: true });
  if (!type) throw unprocessable('INVALID_REFERENCE', `Unknown pallet movement type ${m.typeCode}`, { field: 'typeCode' });
  const sign = type.sign as number;
  const run = () =>
    withTransaction(app.mongo, async (session) => {
      const bal = await app.db.collection<BalanceDoc>(C.palletBalances).findOneAndUpdate(
        { tailVehicleId: m.tailVehicleId },
        { $inc: { balance: sign * m.qty }, $max: { lastMovementAt: m.deviceTime } },
        { upsert: true, returnDocument: 'after', session },
      );
      const doc: MovementDoc = { ...m, _id: new ObjectId(), sign, balanceAfter: bal!.balance };
      await app.db.collection<MovementDoc>(C.palletMovements).insertOne(doc, { session });
      if (audit) {
        await writeAudit(app.db, { entity: 'palletMovement', entityId: doc._id.toHexString(), action: audit.action, by: m.by, after: toApi(doc) }, { session });
      }
      return doc;
    });
  try {
    return await run();
  } catch (e) {
    // The first two movements of a vehicle can race on the balance upsert; the loser finds the row on a second try.
    if (isDuplicateKey(e, 'tailVehicleId')) return run();
    throw e;
  }
}

const DriverMovement = z
  .object({
    clientEventId: z.string().uuid(),
    shipmentId: objectIdString,
    stopId: objectIdString.nullable().default(null),
    doId: objectIdString.nullable().default(null),
    typeCode: z.string().trim().min(1).max(40),
    qty: z.number().int().min(1),
    remark: z.string().trim().max(200).nullable().default(null),
  })
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
          if (!PALLET_ACTIVE_STATUSES.includes(sh.status)) throw unprocessable('SHIPMENT_NOT_ACTIVE', `Cannot record pallets on a ${sh.status} shipment`);
          const stop = m.stopId ? sh.stops.find((s) => s.stopId.toHexString() === m.stopId) : null;
          if (m.stopId && !stop) throw unprocessable('INVALID_REFERENCE', 'stopId is not a stop of this shipment', { field: 'stopId' });
          if (m.doId && !doIdsOf(sh.stops).some((id) => id.toHexString() === m.doId)) {
            throw unprocessable('INVALID_REFERENCE', 'doId is not on this shipment', { field: 'doId' });
          }
          const deviceTime = new Date(m.deviceTime);
          const receivedAt = new Date();
          const { flags, distanceM } = gpsFlags({
            lat: m.lat, lng: m.lng, accuracyM: m.accuracyM, deviceTime, receivedAt,
            target: stop ? await geofenceTarget(app.db, stop.locationId) : undefined,
          });
          const doc = await applyMovement(app, {
            clientEventId: m.clientEventId, tailVehicleId: sh.tail?.vehicleId ?? sh.head!.vehicleId, driverId, shipmentId: sh._id,
            doId: m.doId ? new ObjectId(m.doId) : null, stopId: stop?.stopId ?? null, locationId: stop?.locationId ?? null,
            typeCode: m.typeCode, qty: m.qty, remark: m.remark, deviceTime, receivedAt, lat: m.lat, lng: m.lng, accuracyM: m.accuracyM,
            noGpsReason: m.noGpsReason, geofenceDistanceM: distanceM, flags, source: 'app', by,
          });
          results.push({ clientEventId: m.clientEventId, status: 'accepted' as const, balanceAfter: doc.balanceAfter });
        } catch (e) {
          if (isDuplicateKey(e, 'clientEventId')) {
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
      schema: {
        tags: ['pallets'],
        body: z.object({ tailVehicleId: objectIdString, typeCode: z.string().trim().min(1).max(40), qty: z.number().int().min(1), remark: z.string().trim().min(3).max(200) }),
        response: { 201: MovementItem },
      },
      preHandler: app.requireRoles('admin'),
    },
    async (req, reply) => {
      const tailVehicleId = new ObjectId(req.body.tailVehicleId);
      if (!(await app.db.collection(C.vehicles).countDocuments({ _id: tailVehicleId }, { limit: 1 }))) throw notFound('Vehicle');
      const now = new Date();
      const doc = await applyMovement(
        app,
        {
          clientEventId: null, tailVehicleId, driverId: null, shipmentId: null, doId: null, stopId: null, locationId: null,
          typeCode: req.body.typeCode, qty: req.body.qty, remark: req.body.remark, deviceTime: now, receivedAt: now,
          lat: null, lng: null, accuracyM: null, noGpsReason: null, geofenceDistanceM: null, flags: [], source: 'admin', by: actorOf(req),
        },
        { action: 'correct' },
      );
      return reply.status(201).send(toApi(doc));
    },
  );

  app.get(
    '/pallet-balances',
    {
      schema: {
        tags: ['pallets'],
        querystring: z.object({ tailVehicleId: objectIdString.optional() }),
        response: { 200: z.object({ items: z.array(z.object({ tailVehicleId: z.string(), plate: z.string(), balance: z.number(), lastMovementAt: z.string().nullable() })) }) },
      },
      preHandler: staff,
    },
    async (req) => {
      const f: Filter<BalanceDoc> = req.query.tailVehicleId ? { tailVehicleId: new ObjectId(req.query.tailVehicleId) } : {};
      const bals = await app.db.collection<BalanceDoc>(C.palletBalances).find(f).limit(2000).toArray();
      const vehicles = await app.db.collection(C.vehicles).find({ _id: { $in: bals.map((b) => b.tailVehicleId) } }, { projection: { plate: 1 } }).toArray();
      const plate = new Map(vehicles.map((v) => [v._id.toHexString(), v.plate as string]));
      return {
        items: bals.map((b) => ({
          tailVehicleId: b.tailVehicleId.toHexString(),
          plate: plate.get(b.tailVehicleId.toHexString()) ?? '',
          balance: b.balance,
          lastMovementAt: b.lastMovementAt ? b.lastMovementAt.toISOString() : null,
        })),
      };
    },
  );

  app.get(
    '/pallet-movements',
    {
      schema: {
        tags: ['pallets'],
        querystring: PageQuery.extend({ tailVehicleId: objectIdString.optional(), driverId: objectIdString.optional() }),
        response: { 200: pageResponse(MovementItem) },
      },
      preHandler: app.requireRoles(...STAFF_ROLES, 'driver'),
    },
    async (req) => {
      const q = req.query;
      const filter: Filter<MovementDoc> = {};
      if (q.tailVehicleId) filter.tailVehicleId = new ObjectId(q.tailVehicleId);
      if (q.driverId) filter.driverId = new ObjectId(q.driverId);
      // Drivers see only their own movements (spec §7, §8.2), whatever filter they send.
      const roles = (req.principal as UserPrincipal).roles;
      if (!roles.some((r) => STAFF_ROLES.includes(r))) filter.driverId = driverIdOf(req);
      const page = await paginate(moves(), filter, q);
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
git commit -m "feat(pallets): pallet movements with running per-vehicle balance, transactional admin corrections and driver reads" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 8: Close shipment and trip summary

**Files:**
- Create: `src/modules/summaries/close.service.ts`, `src/modules/summaries/summaries.routes.ts`
- Modify: `src/modules/shipments/shipment.service.ts`, `src/modules/orders/order.types.ts`, `src/db/collections.ts`, `src/db/indexes.ts`, `src/routes.ts`
- Test: `test/api/shipment-close.test.ts`

**Interfaces:**
- Consumes: `transition`, `releaseDos`, `doIdsOf`, `shipmentView` (Plan 2 `shipment.service.ts`), `PodDoc` (Task 5), `EventDoc` (Task 4), `ok`, `acceptedShipment`, `tap`, `deliveredPod`, `toDropStop` (test helpers).
- Produces:
  - `transition(app, existing, opts)` gains `inTx?: (session: ClientSession, updated: ShipmentDoc) => Promise<void>`, run inside the same transaction after the status update and before the audit entry (P3-R6: close reuses the status/version guard and the audit of `transition`).
  - `releaseDos(db, shipmentId, session, opts: { status?: DoStatus } = {})` — with `status` it releases only the DOs in that status; the per-DO job-group re-match on `intendedTruckTypeId` is unchanged (P3-R6).
  - `DeliveryOrderDoc.legacy?: boolean` (set by the Plan 4 migration; legacy DOs are exempt from the job-group requirement, spec §3.4).
  - `C.tripSummaries`; index `{ shipmentId: 1 } unique`.
  - `interface TripSummaryDoc { _id; shipmentId; shipmentNo; lockedAt: Date; lockedBy: string; evidence: { pods: { doId; doNo; podId; hash; outcome; reasonCode }[]; eventCount: number; flags: string[]; distances: { legs: { fromStopId; toStopId; loaded: boolean; mapKm: number | null; gpsKm: number | null }[]; clientKmByDo: { doNo: string; clientKm: number | null }[] } }; lines: never[]; adjustments: never[]; pdfKey: string | null }`.
  - `closeShipment(app, shipment, version, by): Promise<{ shipment: ShipmentDoc; summary: TripSummaryDoc }>` — 422 `SHIPMENT_NOT_COMPLETED`, `PODS_NOT_VERIFIED` (details `{ doNos }`: DOs whose **latest** POD is not `verified`), `JOB_GROUP_REQUIRED` (details `{ doNos }`, non-legacy DOs only), 409 `VERSION_CONFLICT`. One transaction via `transition` (`from: ['COMPLETED']`, action `close`): shipment → `CLOSED` with `closedAt`, `closedBy`, `summaryId`, version +1; summary inserted; FAILED DOs released with `releaseDos(..., { status: 'FAILED' })` (`attempts` kept); exactly one audit entry `close`.
  - `POST /shipments/:id/close` (admin, planner — P3-R1) `{ version }` → `ShipmentItem`; `GET /shipments/:id/summary` (staff) → `TripSummaryItem` (404 if not closed).

- [ ] **Step 1: Write the failing test**

`test/api/shipment-close.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { acceptedShipment, at, deliveredPod, gps, tap, toDropStop } from '../helpers/execution.js';
import { ok } from '../helpers/http.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

describe('close shipment', () => {
  let app: App;
  let f: PlanningFixtures;
  const admin = (url: string, payload: object = {}) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: f.admin, payload });
  const versionOf = async (id: string) => ok(await app.inject({ method: 'GET', url: `/api/v1/shipments/${id}`, headers: f.admin })).version as number;
  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('closes a completed shipment once every POD is verified, releasing failed DOs', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { doOverrides: [{}, { destLocationId: f.ids.locC }] });
    for (const code of ['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED']) await tap(app, f, shipment, 0, code);
    for (const code of ['ARRIVED', 'UNLOAD_START', 'UNLOAD_END']) await tap(app, f, shipment, 1, code, gps(13.75, 100.5, at('10:00')));
    const good = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    await tap(app, f, shipment, 1, 'DEPARTED', gps(13.75, 100.5, at('11:30')));
    await tap(app, f, shipment, 2, 'ARRIVED', gps(16.43, 102.83, at('15:00')));
    const failed = ok(await app.inject({
      method: 'POST', url: '/api/v1/driver/pods', headers: f.driver1,
      payload: { clientPodId: randomUUID(), doId: dos[1].id, outcome: 'FAILED', reasonCode: 'CONSIGNEE_CLOSED', answers: {}, files: [], ...gps(16.43, 102.83, at('15:05')) },
    }), 201);
    const current = ok(await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}`, headers: f.admin }));
    expect(current.status).toBe('COMPLETED');
    const early = await admin(`/shipments/${shipment.id}/close`, { version: current.version });
    expect(early.json()).toMatchObject({ code: 'PODS_NOT_VERIFIED', details: { doNos: [dos[0].doNo, dos[1].doNo].sort() } });
    ok(await admin(`/pods/${good.id}/verify`));
    ok(await admin(`/pods/${failed.id}/verify`));
    const closeAs = async (h: { authorization: string }) =>
      app.inject({ method: 'POST', url: `/api/v1/shipments/${shipment.id}/close`, headers: h, payload: { version: await versionOf(shipment.id) } });
    expect((await closeAs(f.viewer)).statusCode).toBe(403);
    const closed = ok(await closeAs(f.planner)); // admin or planner may close (P3-R1)
    expect(closed).toMatchObject({ status: 'CLOSED', closedBy: expect.any(String) });
    expect(await app.db.collection(C.auditLog).countDocuments({ entity: 'shipment', entityId: shipment.id, action: 'close' })).toBe(1);
    const summary = ok(await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}/summary`, headers: f.viewer }));
    expect(summary.evidence.pods.map((p: { outcome: string }) => p.outcome).sort()).toEqual(['DELIVERED', 'FAILED']);
    expect(summary.evidence.eventCount).toBeGreaterThanOrEqual(8);
    expect(summary.lines).toEqual([]);
    const released = await app.db.collection(C.deliveryOrders).findOne({ doNo: dos[1].doNo });
    expect(released).toMatchObject({ status: 'UNASSIGNED', shipmentId: null });
    expect(released?.attempts).toHaveLength(1);
    expect((await admin(`/shipments/${shipment.id}/close`, { version: closed.version })).json().code).toBe('SHIPMENT_NOT_COMPLETED');
  });

  it('requires a job group on every non-legacy DO', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-08', doOverrides: [{ materialId: f.ids.bag }] });
    for (const code of ['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED']) await tap(app, f, shipment, 0, code);
    for (const code of ['ARRIVED', 'UNLOAD_START', 'UNLOAD_END']) await tap(app, f, shipment, 1, code, gps(13.75, 100.5, at('10:00', '2026-10-08')));
    const pod = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    ok(await admin(`/pods/${pod.id}/verify`));
    const refused = await admin(`/shipments/${shipment.id}/close`, { version: await versionOf(shipment.id) });
    expect(refused.json()).toMatchObject({ code: 'JOB_GROUP_REQUIRED', details: { doNos: [dos[0].doNo] } });
    // Legacy DOs (Plan 4 migration) are exempt from the job-group requirement (spec §3.4).
    await app.db.collection(C.deliveryOrders).updateOne({ doNo: dos[0].doNo }, { $set: { legacy: true } });
    expect(ok(await admin(`/shipments/${shipment.id}/close`, { version: await versionOf(shipment.id) })).status).toBe('CLOSED');
  });

  it('closes only after the resubmitted POD is verified', async () => {
    const { shipment, dos } = await acceptedShipment(app, f, { day: '2026-10-09' });
    await toDropStop(app, f, shipment);
    const first = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    ok(await admin(`/pods/${first.id}/reject`, { reason: 'ลายเซ็นไม่ชัด' }));
    const second = ok(await deliveredPod(app, f, shipment, dos[0]), 201);
    expect(second.supersedesPodId).toBe(first.id);
    const refused = await admin(`/shipments/${shipment.id}/close`, { version: await versionOf(shipment.id) });
    expect(refused.json()).toMatchObject({ code: 'PODS_NOT_VERIFIED', details: { doNos: [dos[0].doNo] } });
    ok(await admin(`/pods/${second.id}/verify`));
    expect(ok(await admin(`/shipments/${shipment.id}/close`, { version: await versionOf(shipment.id) })).status).toBe('CLOSED');
    const summary = ok(await app.inject({ method: 'GET', url: `/api/v1/shipments/${shipment.id}/summary`, headers: f.viewer }));
    expect(summary.evidence.pods).toEqual([expect.objectContaining({ podId: second.id, hash: second.hash, outcome: 'DELIVERED' })]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/shipment-close.test.ts`
Expected: FAIL — close route 404.

- [ ] **Step 3: Extend `transition` and `releaseDos`**

In `src/modules/shipments/shipment.service.ts`:
- add `DoStatus` to the order-types import: `import type { DeliveryOrderDoc, DoStatus } from '../orders/order.types.js';`
- replace `releaseDos` with:
```ts
export async function releaseDos(db: Db, shipmentId: ObjectId, session: ClientSession, opts: { status?: DoStatus } = {}): Promise<void> {
  const coll = db.collection<DeliveryOrderDoc>(C.deliveryOrders);
  const dos = await coll.find({ shipmentId, ...(opts.status ? { status: opts.status } : {}) }, { session }).toArray();
  const now = new Date();
  for (const d of dos) {
    // Same rule as `linkDos`: once the shipment releases the DO (cancel, or a failed attempt at close),
    // its truck type can only come from `intendedTruckTypeId`, never the (now moot) shipment vehicle.
    const rematched = await rematchJobGroup(db, d, d.intendedTruckTypeId ?? null);
    await coll.updateOne(
      { _id: d._id, shipmentId },
      { $set: { status: 'UNASSIGNED', shipmentId: null, pickupStopId: null, dropStopId: null, updatedAt: now, ...(rematched ?? {}) } },
      { session },
    );
  }
}
```
- replace the `transition` signature and body with:
```ts
export async function transition(
  app: FastifyInstance,
  existing: ShipmentDoc,
  opts: {
    version: number;
    from: ShipmentStatus[];
    set: Partial<ShipmentDoc>;
    action: string;
    by: string;
    notAllowedCode: string;
    releaseDos?: boolean;
    /** Extra writes that must commit with the transition (e.g. the trip summary on close). */
    inTx?: (session: ClientSession, updated: ShipmentDoc) => Promise<void>;
  },
): Promise<ShipmentDoc> {
  if (!opts.from.includes(existing.status)) {
    throw unprocessable(opts.notAllowedCode, `Cannot ${opts.action} a ${existing.status} shipment`);
  }
  if (opts.version !== existing.version) throw versionConflict();
  return withTransaction(app.mongo, async (session) => {
    const coll = app.db.collection<ShipmentDoc>(C.shipments);
    const updated = await coll.findOneAndUpdate(
      { _id: existing._id, version: existing.version, status: existing.status },
      { $set: { ...opts.set, updatedBy: opts.by, updatedAt: new Date() }, $inc: { version: 1 } },
      { returnDocument: 'after', session },
    );
    if (!updated) throw versionConflict();
    if (opts.releaseDos) await releaseDos(app.db, existing._id, session);
    if (opts.inTx) await opts.inTx(session, updated);
    // `after` includes every field the caller actually set (e.g. `driverResponse` with a decline
    // reason, or `dispatch`), not just `status`, so the audit trail shows what changed.
    const changed = Object.fromEntries(Object.keys(opts.set).map((k) => [k, (updated as unknown as Record<string, unknown>)[k]]));
    await writeAudit(
      app.db,
      { entity: 'shipment', entityId: existing._id.toHexString(), action: opts.action, by: opts.by, before: { status: existing.status }, after: toApi(changed) },
      { session },
    );
    return updated;
  });
}
```
Existing callers (plan, dispatch, cancel, accept, decline) are unchanged.

In `src/modules/orders/order.types.ts` add `legacy?: boolean;` to `DeliveryOrderDoc`.

- [ ] **Step 4: Implement close and the summary routes**

Add `tripSummaries: 'tripSummaries'` to `C` and index `[C.tripSummaries]: [{ key: { shipmentId: 1 }, unique: true }]`.

`src/modules/summaries/close.service.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { C } from '../../db/collections.js';
import { unprocessable } from '../../lib/errors.js';
import type { EventDoc } from '../execution/events.service.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import type { PodDoc } from '../pods/pods.service.js';
import { doIdsOf, releaseDos, transition } from '../shipments/shipment.service.js';
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

export async function closeShipment(
  app: FastifyInstance,
  shipment: ShipmentDoc,
  version: number,
  by: string,
): Promise<{ shipment: ShipmentDoc; summary: TripSummaryDoc }> {
  // Fail fast before assembling evidence; `transition` re-checks status and version atomically.
  if (shipment.status !== 'COMPLETED') throw unprocessable('SHIPMENT_NOT_COMPLETED', `Cannot close a ${shipment.status} shipment`);
  const dos = await app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).find({ _id: { $in: doIdsOf(shipment.stops) } }).toArray();
  const latest = new Map<string, PodDoc>();
  for (const p of await app.db.collection<PodDoc>(C.pods).find({ shipmentId: shipment._id }).sort({ _id: 1 }).toArray()) latest.set(p.doId.toHexString(), p);
  const unverified = dos.filter((d) => latest.get(d._id.toHexString())?.status !== 'verified').map((d) => d.doNo).sort();
  if (unverified.length > 0) throw unprocessable('PODS_NOT_VERIFIED', 'Verify every POD before closing', { doNos: unverified });
  const noGroup = dos.filter((d) => !d.jobGroupId && !d.legacy).map((d) => d.doNo).sort();
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
  const updated = await transition(app, shipment, {
    version,
    from: ['COMPLETED'],
    set: { status: 'CLOSED', closedAt: now, closedBy: by, summaryId: summary._id },
    action: 'close',
    by,
    notAllowedCode: 'SHIPMENT_NOT_COMPLETED',
    inTx: async (session) => {
      await app.db.collection<TripSummaryDoc>(C.tripSummaries).insertOne(summary, { session });
      // Failed DOs go back to the pool through the same job-group re-match as any release (P3-R6); attempts[] is kept.
      await releaseDos(app.db, shipment._id, session, { status: 'FAILED' });
    },
  });
  return { shipment: updated, summary };
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

const TripSummaryItem = z.object({
  id: z.string(),
  shipmentId: z.string(),
  shipmentNo: z.string(),
  lockedAt: z.string(),
  lockedBy: z.string(),
  evidence: z.object({
    pods: z.array(z.object({ doId: z.string(), doNo: z.string(), podId: z.string(), hash: z.string(), outcome: z.string(), reasonCode: z.string().nullable() })),
    eventCount: z.number(),
    flags: z.array(z.string()),
    distances: z.object({
      legs: z.array(z.object({ fromStopId: z.string(), toStopId: z.string(), loaded: z.boolean(), mapKm: z.number().nullable(), gpsKm: z.number().nullable() })),
      clientKmByDo: z.array(z.object({ doNo: z.string(), clientKm: z.number().nullable() })),
    }),
  }),
  lines: z.array(z.unknown()),
  adjustments: z.array(z.unknown()),
  pdfKey: z.string().nullable(),
});

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
    { schema: { tags: ['shipments'], params: IdParams, response: { 200: TripSummaryItem } }, preHandler: app.requireRoles(...STAFF_ROLES) },
    async (req) => {
      const s = await app.db.collection<TripSummaryDoc>(C.tripSummaries).findOne({ shipmentId: new ObjectId(req.params.id) });
      if (!s) throw notFound('Trip summary');
      return toApi(s);
    },
  );
};
```
Register `summaryRoutes` in `src/routes.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS (existing dispatch/cancel/accept tests still pass through the extended `transition`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(summaries): close shipment into a locked trip summary via transition, releasing failed DOs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 9: Evidence PDF

**Files:**
- Create: `src/modules/summaries/pdf.ts`, `assets/fonts/Sarabun-Regular.ttf`, `assets/fonts/Sarabun-Bold.ttf`, `assets/fonts/OFL.txt`
- Modify: `src/modules/summaries/close.service.ts`, `src/modules/summaries/summaries.routes.ts`, `package.json` / `package-lock.json` (dependencies only — there is no `files` field, and Render deploys the repository, so `assets/` ships with it)
- Test: `test/api/summary-pdf.test.ts`

**Interfaces:**
- Consumes: `TripSummaryDoc`, `closeShipment` (Task 8), `PodDoc` (Task 5), `DEFAULT_POD_FIELDS` (Task 3), `PodTemplateDoc`, `PodField`, `tinyJpeg`, `ok` (test helpers).
- Produces:
  - `buildSummaryPdf(data: SummaryPdfData): Promise<Buffer>` where `SummaryPdfData = { shipmentNo; plannedStart: Date; closedAt: Date; closedBy: string; vehicles: string[]; drivers: string[]; stops: { seq: number; location: string; events: { code: string; at: Date }[] }[]; dos: { doNo: string; client: string; material: string; qty: number; unit: string; outcome: string; reasonCode: string | null; answers: { label: string; value: string }[]; hash: string; images: Buffer[] }[]; flags: string[] }`. The receiver name and every other text/number/select/checkbox answer are printed as `label: value` lines from the POD's own template, so no field key is hard-coded.
  - `embeddableImage(buf: Buffer): string | null` — sniffs JPEG (`FF D8 FF`) / PNG (`89 50 4E 47 0D 0A 1A 0A`) magic bytes, returns the matching data URL only when pdfmake can decode it, else `null` (P3-R3). `buildSummaryPdf` skips `null` images and prints how many were skipped, so one bad photo never kills the evidence PDF.
  - After a successful close, the service builds the PDF (per DO: up to two files of the template's `photo` fields + the files of its `signature` fields), stores it at `summaries/{shipmentNo}.pdf` and sets `tripSummaries.pdfKey`. A PDF failure is logged and leaves `pdfKey: null`; `POST /shipments/:id/summary.pdf/regenerate` (admin, planner — same roles as close, P3-R1) rebuilds it → `{ pdfKey }`.
  - `GET /shipments/:id/summary.pdf` (staff) → `application/pdf` body streamed from storage; 404 `NOT_FOUND` if the shipment has no summary; 422 `PDF_NOT_READY` if `pdfKey` is null or the file is missing (the summary exists but its PDF does not yet).

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
import { type SummaryPdfData, buildSummaryPdf, embeddableImage } from '../../src/modules/summaries/pdf.js';
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
  dos: {
    doNo: string; client: string; material: string; qty: number; unit: string; outcome: string; reasonCode: string | null;
    answers: { label: string; value: string }[]; hash: string; images: Buffer[];
  }[];
  flags: string[];
}

const SIGNATURES: { magic: number[]; mime: 'image/jpeg' | 'image/png' }[] = [
  { magic: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: 'image/png' },
];

/**
 * A data URL pdfmake can embed, or null when the stored bytes are not a decodable JPEG/PNG (WebP,
 * text, truncated or corrupt files). The type comes from the magic bytes, never the declared mime.
 */
export function embeddableImage(buf: Buffer): string | null {
  const sig = SIGNATURES.find((s) => buf.length > s.magic.length && s.magic.every((b, i) => buf[i] === b));
  if (!sig) return null;
  const url = `data:${sig.mime};base64,${buf.toString('base64')}`;
  try {
    // pdfmake decodes images synchronously while laying out; a one-image probe catches corrupt files.
    printer.createPdfKitDocument({ content: [{ image: url, width: 1 }], defaultStyle: { font: 'Sarabun' } }).end();
    return url;
  } catch {
    return null;
  }
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
    const images = d.images.map(embeddableImage).filter((u): u is string => u !== null);
    const skipped = d.images.length - images.length;
    const stack: Content[] = [
      { text: `${d.doNo} · ${d.client} · ${d.material} ${d.qty} ${d.unit}`, bold: true },
      { text: d.outcome === 'DELIVERED' ? 'ส่งสำเร็จ' : `ส่งไม่สำเร็จ · เหตุผล ${d.reasonCode ?? '-'}` },
      ...d.answers.map((a): Content => ({ text: `${a.label}: ${a.value}` })),
      { text: `ลายนิ้วมือ POD: ${d.hash}`, fontSize: 7, color: '#555555' },
    ];
    if (images.length > 0) stack.push({ columns: images.map((image) => ({ image, fit: [150, 110] as [number, number] })), columnGap: 8 });
    if (skipped > 0) stack.push({ text: `แสดงรูปไม่ได้ ${skipped} รูป (ไม่ใช่ JPEG/PNG หรือไฟล์เสีย)`, fontSize: 8, color: '#b45309' });
    content.push({ stack, margin: [0, 0, 0, 10] });
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

- [ ] **Step 5: Generate on close, serve and regenerate**

In `src/modules/summaries/close.service.ts` change the errors import to `import { notFound, unprocessable } from '../../lib/errors.js';`, add the imports
```ts
import type { PodField } from '../pod-templates/pod-templates.schemas.js';
import type { PodTemplateDoc } from '../pod-templates/pod-templates.service.js';
import { DEFAULT_POD_FIELDS } from '../pods/pod-validation.js';
import { buildSummaryPdf } from './pdf.js';
```
and add:
```ts
const MAX_PHOTOS_PER_DO = 2;

/** Printable `label: value` lines for the non-file answers, in template order. */
function answerLines(fields: PodField[], answers: Record<string, unknown>): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = [];
  for (const f of fields) {
    const v = answers[f.key];
    if (v === undefined || v === null || v === '') continue;
    if (f.type === 'text' || f.type === 'select') lines.push({ label: f.label, value: String(v) });
    else if (f.type === 'number') lines.push({ label: f.label, value: f.unit ? `${String(v)} ${f.unit}` : String(v) });
    else if (f.type === 'checkbox') lines.push({ label: f.label, value: v === true ? 'ใช่' : 'ไม่ใช่' });
    else if (f.type === 'qtyLines' || f.type === 'palletLines') lines.push({ label: f.label, value: `${Array.isArray(v) ? v.length : 0} รายการ` });
  }
  return lines;
}

export async function generateSummaryPdf(app: FastifyInstance, summaryId: ObjectId): Promise<string> {
  const summary = await app.db.collection<TripSummaryDoc>(C.tripSummaries).findOne({ _id: summaryId });
  if (!summary) throw notFound('Trip summary');
  const shipment = (await app.db.collection<ShipmentDoc>(C.shipments).findOne({ _id: summary.shipmentId }))!;
  const vehicleIds = [shipment.head?.vehicleId, shipment.tail?.vehicleId].filter((v): v is ObjectId => !!v);
  const driverIds = [shipment.head?.driverId, shipment.tail?.driverId].filter((v): v is ObjectId => !!v);
  const [vehicles, drivers, locations, events, dos, pods] = await Promise.all([
    app.db.collection(C.vehicles).find({ _id: { $in: vehicleIds } }).toArray(),
    app.db.collection(C.drivers).find({ _id: { $in: driverIds } }).toArray(),
    app.db.collection(C.locations).find({ _id: { $in: shipment.stops.map((s) => s.locationId) } }).toArray(),
    app.db.collection<EventDoc>(C.events).find({ shipmentId: shipment._id }).sort({ deviceTime: 1, receivedAt: 1, _id: 1 }).toArray(),
    app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).find({ _id: { $in: summary.evidence.pods.map((p) => p.doId) } }).toArray(),
    app.db.collection<PodDoc>(C.pods).find({ _id: { $in: summary.evidence.pods.map((p) => p.podId) } }).toArray(),
  ]);
  const [clients, materials, templates] = await Promise.all([
    app.db.collection(C.clients).find({ _id: { $in: dos.map((d) => d.clientId) } }).toArray(),
    app.db.collection(C.materials).find({ _id: { $in: dos.map((d) => d.materialId) } }).toArray(),
    app.db.collection<PodTemplateDoc>(C.podTemplates).find({ _id: { $in: pods.map((p) => p.templateId).filter((id): id is ObjectId => !!id) } }).toArray(),
  ]);
  const name = <T extends { _id: ObjectId }>(list: T[], id: ObjectId, field: keyof T) => String(list.find((x) => x._id.equals(id))?.[field] ?? '');
  const fieldsOf = (p: PodDoc): PodField[] => (p.templateId ? templates.find((t) => t._id.equals(p.templateId!))?.fields : undefined) ?? DEFAULT_POD_FIELDS;
  const imagesFor = async (p: PodDoc | undefined): Promise<Buffer[]> => {
    if (!p) return [];
    const typeOf = new Map(fieldsOf(p).map((f) => [f.key, f.type]));
    const photos = p.files.filter((file) => typeOf.get(file.fieldKey) === 'photo').slice(0, MAX_PHOTOS_PER_DO);
    const signatures = p.files.filter((file) => typeOf.get(file.fieldKey) === 'signature');
    const out: Buffer[] = [];
    for (const file of [...photos, ...signatures]) {
      const o = await app.storage.get(file.key);
      if (o) out.push(o.body); // undecodable bytes are skipped (and counted) by buildSummaryPdf
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
          outcome: ep.outcome, reasonCode: ep.reasonCode, answers: p ? answerLines(fieldsOf(p), p.answers) : [],
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
```
At the end of `closeShipment` replace `return { shipment: updated, summary };` with:
```ts
  // The PDF is built after the close commits: a PDF failure must never undo a close; it is logged
  // and can be rebuilt with POST /shipments/:id/summary.pdf/regenerate.
  try {
    summary.pdfKey = await generateSummaryPdf(app, summary._id);
  } catch (err) {
    app.log.error({ err, shipmentNo: shipment.shipmentNo }, 'summary PDF generation failed');
  }
  return { shipment: updated, summary };
```

In `summaries.routes.ts` change the errors import to `import { notFound, unprocessable } from '../../lib/errors.js';`, import `generateSummaryPdf` next to `closeShipment` (`import { type TripSummaryDoc, closeShipment, generateSummaryPdf } from './close.service.js';`) and add inside `summaryRoutes`:
```ts
  app.get('/shipments/:id/summary.pdf', { schema: { tags: ['shipments'], params: IdParams }, preHandler: app.requireRoles(...STAFF_ROLES) }, async (req, reply) => {
    const s = await app.db.collection<TripSummaryDoc>(C.tripSummaries).findOne({ shipmentId: new ObjectId(req.params.id) });
    if (!s) throw notFound('Trip summary');
    if (!s.pdfKey) throw unprocessable('PDF_NOT_READY', 'The PDF is not generated yet');
    const obj = await app.storage.get(s.pdfKey);
    if (!obj) throw unprocessable('PDF_NOT_READY', 'The PDF file is missing; regenerate it');
    return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${s.shipmentNo}.pdf"`).send(obj.body);
  });

  app.post(
    '/shipments/:id/summary.pdf/regenerate',
    { schema: { tags: ['shipments'], params: IdParams, response: { 200: z.object({ pdfKey: z.string() }) } }, preHandler: app.requireRoles('admin', 'planner') },
    async (req) => {
      const s = await app.db.collection<TripSummaryDoc>(C.tripSummaries).findOne({ shipmentId: new ObjectId(req.params.id) });
      if (!s) throw notFound('Trip summary');
      return { pdfKey: await generateSummaryPdf(app, s._id) };
    },
  );
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(summaries): Thai evidence PDF generated on close, image-safe, served and regenerable" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 10: Driver link hygiene (release stale `users.driverId`)

Roadmap carry-forward (Plan 1 → "Plan 3, before driver onboarding"; P3-R5): a user keeps its `driverId` after the `driver` role is removed or the account is deactivated, and the unique partial index `users { driverId }` then blocks linking that driver to a new account. This task must land before Task 11 onboards demo driver accounts.

**Files:**
- Modify: `src/modules/users/users.routes.ts`
- Test: `test/api/driver-link.test.ts`

**Interfaces:**
- Consumes: `UserDoc`, `createUser` (Plan 1 `users.repo.ts`), `conflict`, `unprocessable`, `ok` (Task 1).
- Produces (rule: only an **active** user with the **`driver` role** holds a `driverId`):
  - `POST /users`: `driverId` on a user without the `driver` role → 422 `DRIVER_LINK_NOT_ALLOWED`; a driver already linked to another user → 409 `DRIVER_ALREADY_LINKED` (details `{ username }`); the unique index stays the race guard (409 `DUPLICATE_KEY`).
  - `PATCH /users/:id`: when the resulting roles drop `driver` or the resulting `active` is `false`, `driverId` is set to `null` (the link is released); sending a non-null `driverId` in that case → 422 `DRIVER_LINK_NOT_ALLOWED`; re-activating a driver account without sending a `driverId` → 422 `DRIVER_LINK_REQUIRED` (it must be re-linked). `DRIVER_LINK_REQUIRED` and `INVALID_REFERENCE` keep their Plan 1 meaning.
  - `assertDriverLink(db, roles, driverId, active, userId: ObjectId | null): Promise<void>` (module-private) replaces the Plan 1 helper.
  - Deactivating a driver master record (`DELETE /drivers/:id`) does not touch user links: a deactivated driver can no longer be planned (Plan 2), and deactivating the account releases the link.

- [ ] **Step 1: Write the failing test**

`test/api/driver-link.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';
import { ok } from '../helpers/http.js';

describe('driver link hygiene', () => {
  let app: App;
  let admin: { authorization: string };
  const newDriver = async (code: string) => (await app.db.collection(C.drivers).insertOne({ code, name: `Driver ${code}`, active: true })).insertedId.toHexString();
  const createUser = (username: string, body: object) =>
    app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload: { username, password: 'Passw0rd!', ...body } });
  const patchUser = (id: string, body: object) => app.inject({ method: 'PATCH', url: `/api/v1/users/${id}`, headers: admin, payload: body });

  beforeAll(async () => {
    app = await buildTestApp();
    admin = (await createUserAndLogin(app, ['admin'])).headers;
  });
  afterAll(async () => closeTestApp(app));

  it('releases the link when the driver role is removed, so the driver can be linked to a new account', async () => {
    const driverId = await newDriver('L100');
    const first = ok(await createUser('drv-a', { roles: ['driver'], driverId }), 201);
    const taken = await createUser('drv-b', { roles: ['driver'], driverId });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: 'DRIVER_ALREADY_LINKED', details: { username: 'drv-a' } });
    expect(ok(await patchUser(first.id, { roles: ['viewer'] }))).toMatchObject({ roles: ['viewer'], driverId: null });
    expect(ok(await createUser('drv-b', { roles: ['driver'], driverId }), 201).driverId).toBe(driverId);
  });

  it('releases the link when the account is deactivated and requires re-linking on reactivation', async () => {
    const driverId = await newDriver('L101');
    const user = ok(await createUser('drv-c', { roles: ['driver'], driverId }), 201);
    expect(ok(await patchUser(user.id, { active: false }))).toMatchObject({ active: false, driverId: null });
    expect(ok(await createUser('drv-d', { roles: ['driver'], driverId }), 201).driverId).toBe(driverId);
    expect((await patchUser(user.id, { active: true })).json().code).toBe('DRIVER_LINK_REQUIRED');
    const other = await newDriver('L102');
    expect(ok(await patchUser(user.id, { active: true, driverId: other }))).toMatchObject({ active: true, driverId: other });
  });

  it('refuses a driver link on a non-driver or inactive account', async () => {
    const driverId = await newDriver('L103');
    expect((await createUser('plan-x', { roles: ['planner'], driverId })).json().code).toBe('DRIVER_LINK_NOT_ALLOWED');
    const user = ok(await createUser('drv-e', { roles: ['driver'], driverId }), 201);
    expect((await patchUser(user.id, { active: false, driverId })).json().code).toBe('DRIVER_LINK_NOT_ALLOWED');
    expect((await patchUser(user.id, { roles: ['viewer'], driverId })).json().code).toBe('DRIVER_LINK_NOT_ALLOWED');
    expect(await app.db.collection(C.users).findOne({ username: 'drv-e' })).toMatchObject({ active: true, roles: ['driver'] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/driver-link.test.ts`
Expected: FAIL — the second `drv-b` create returns 409 `DUPLICATE_KEY`, and demoting `drv-a` keeps its `driverId`.

- [ ] **Step 3: Implement**

In `src/modules/users/users.routes.ts` change the errors import to `import { conflict, notFound, unprocessable } from '../../lib/errors.js';` and replace `assertDriverLink` with:
```ts
/**
 * Only an active user with the driver role holds a driverId (roadmap carry-forward: a stale link on
 * a demoted or deactivated account would otherwise block linking the driver to a new account).
 */
async function assertDriverLink(db: Db, roles: Role[], driverId: ObjectId | null, active: boolean, userId: ObjectId | null): Promise<void> {
  const isDriver = roles.includes('driver');
  if (isDriver && active && !driverId) {
    throw unprocessable('DRIVER_LINK_REQUIRED', 'Users with the driver role must be linked to a driver');
  }
  if (!driverId) return;
  if (!isDriver || !active) {
    throw unprocessable('DRIVER_LINK_NOT_ALLOWED', 'Only an active user with the driver role can be linked to a driver');
  }
  if (!(await db.collection(C.drivers).countDocuments({ _id: driverId }, { limit: 1 }))) {
    throw unprocessable('INVALID_REFERENCE', 'driverId does not exist', { field: 'driverId' });
  }
  const holder = await db
    .collection<UserDoc>(C.users)
    .findOne({ driverId, ...(userId ? { _id: { $ne: userId } } : {}) }, { projection: { username: 1 } });
  if (holder) throw conflict('DRIVER_ALREADY_LINKED', `This driver is already linked to user ${holder.username}`, { username: holder.username });
}
```
In `POST /users` replace `await assertDriverLink(app.db, req.body.roles, driverId);` with `await assertDriverLink(app.db, req.body.roles, driverId, true, null);`.

In `PATCH /users/:id` replace the lines from `const roles = req.body.roles ?? existing.roles;` through `const willBeActive = req.body.active ?? existing.active;` with:
```ts
    const roles = req.body.roles ?? existing.roles;
    const willBeActive = req.body.active ?? existing.active;
    const requested = req.body.driverId === undefined ? undefined : req.body.driverId ? new ObjectId(req.body.driverId) : null;
    // Keep the link only on an active driver account; otherwise release it so the driver can be linked again.
    const driverId = requested !== undefined ? requested : roles.includes('driver') && willBeActive ? existing.driverId : null;
    await assertDriverLink(app.db, roles, driverId, willBeActive, _id);
```
(the rest of the handler — the LAST_ADMIN check, `set`, the update, token revocation and audit — is unchanged here; Task 12 moves it into one transaction).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS (`test/api/users-admin.test.ts` still gets `DRIVER_LINK_REQUIRED`, `INVALID_REFERENCE` and 409 for a second link to the same driver).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(users): release driver links on role removal or deactivation and report taken drivers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 11: Demo seed, README and roadmap

**Files:**
- Modify: `src/seed/seed.ts`, `scripts/seed.ts`, `README.md`, `.env.example`, `docs/superpowers/plans/2026-09-27-roadmap.md`
- Test: `test/unit/seed.test.ts`

**Interfaces:**
- Consumes: `createUser`, `findUserByUsername` (Plan 1), `plateKey`, `normalizePlate` (Plan 1 `master/fleet.ts`), `nextNumber`; the driver-link rule of Task 10 (the seeded driver accounts are active and hold the `driver` role).
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

In `src/seed/seed.ts` change the signature to `seedDemo(db: Db, opts: { password: string })` and append to its body (reuse `upsertByCode`; vehicles upsert by `plateKey()` with the `normalizePlate()` display form, `part`, `truckTypeId`, `gpsVendor: null`, `gpsId: null` — the same normalisation as `POST /vehicles`):
```ts
  const trailer = (await db.collection(C.truckTypes).findOne({ code: 'TRAILER' }))!._id as ObjectId;
  const kkn = await upsertByCode(db, C.locations, {
    code: 'DEMO-SHOP-KKN', name: 'ร้านวัสดุ ขอนแก่น', clientId, zoneId: zCen, isSite: false, address: 'Khon Kaen',
    geo: { type: 'Point', coordinates: [102.83, 16.43] }, geofenceRadiusM: 300,
  });
  const upsertVehicle = async (plate: string, part: string, truckTypeId: ObjectId) => {
    const now = new Date();
    await db.collection(C.vehicles).updateOne(
      { plateKey: plateKey(plate) },
      { $setOnInsert: { plate: normalizePlate(plate), plateKey: plateKey(plate), part, truckTypeId, gpsVendor: null, gpsId: null, active: true, createdAt: now, updatedAt: now } },
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
(add imports: `type Role` from `../lib/roles.js`, `nextNumber` from `../lib/counters.js`, `normalizePlate`, `plateKey` from `../modules/master/fleet.js`).

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
Add `DEMO_PASSWORD=` to `.env.example`.

README — add a "Driver execution and POD (Plan 3)" section describing: `/uploads/presign` → PUT the file → `/driver/pods`; `/driver/events` (idempotent batches; `SHIPMENT_CHANGED` means resend with the same `clientEventId`); POD review `/pods` (admin, planner); pallets (`tailVehicleId`, drivers read their own movements); `POST /shipments/:id/close`; `GET /shipments/:id/summary.pdf`; Spaces settings; driver accounts (only an active user with the `driver` role holds a `driverId`); and "Demo" instructions (`DEMO_PASSWORD=... npm run seed -- --demo`). Include this subsection verbatim so third parties can re-verify a POD (spec §6.3):
```markdown
### Verifying a POD hash

`pod.hash` is the SHA-256 (hex) of the canonical JSON of:

    { doId, templateId, templateVersion, answers, files, evidence }

- `doId`, `templateId`: 24-character hex strings; `templateId` is `null` when the built-in default form was used.
- `files`: the `sha256` of each file, ordered by the file `key` (ascending).
- `evidence`: the POD's `evidence` object as returned by `GET /pods/:id`, with `deviceTime` and `receivedAt` as ISO-8601 UTC strings.
- Canonical JSON: `JSON.stringify` of each value with object keys sorted ascending at every level (all keys are ASCII), no whitespace, `undefined` members omitted, arrays in their given order.

`outcome` and `reasonCode` are not part of the hash (spec §6.3); they are stored on the append-only POD record.
```

In `docs/superpowers/plans/2026-09-27-roadmap.md`, under "Carry-forward from Plan 1":
- change the owner cell of the row "Stale `users.driverId` after driver role removal/deactivation blocks re-linking" to `Done — Plan 3 Task 10`;
- append these rows:
```markdown
| Admin `CORRECTION` events (`correctsEventId`) and admin step override with a reason (spec §5.3, ruling P3-R7) | Plan 4 |
| `submitPod` downloads every file (≤ 30 × 5 MB) to re-hash it — measure in the load test; consider S3 checksums or streaming hashes | Plan 4 (perf) |
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(seed): demo users, fleet and unassigned DOs for the end-to-end demo; document Plan 3 and the POD hash" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 12: Mutation + audit in one transaction, LAST_ADMIN under concurrency, refresh-token race

Roadmap carry-forward owned by Plan 3 (P3-R5): 18 Plan 1–2 routes write their audit entry after the mutation has committed (`pod-templates.routes.ts` ×4, `api-keys.routes.ts` ×2, `blocks.routes.ts` ×3, `master/resource.ts` ×3, `users.routes.ts` ×2, `orders.routes.ts` ×3, `auth.routes.ts` ×1), so a failed audit leaves an unaudited change; the LAST_ADMIN check counts outside any transaction, so two concurrent demotions can remove every admin; and `issueRefreshToken` guards a concurrent family revoke with a read-after-write check. This task is last so it does not disturb Tasks 1–11.

**Files:**
- Modify: `src/lib/audit.ts`, `src/modules/pod-templates/pod-templates.routes.ts`, `src/modules/api-keys/api-keys.routes.ts`, `src/modules/api-keys/api-keys.service.ts`, `src/modules/availability/blocks.routes.ts`, `src/modules/master/resource.ts`, `src/modules/users/users.routes.ts`, `src/modules/users/users.repo.ts`, `src/modules/orders/orders.routes.ts`, `src/modules/orders/orders.service.ts`, `src/modules/auth/auth.routes.ts`, `src/modules/auth/refresh-tokens.ts`, `src/db/collections.ts`, `src/db/indexes.ts`, `docs/superpowers/plans/2026-09-27-roadmap.md`
- Test: `test/api/audit-transactions.test.ts`

**Interfaces:**
- Consumes: `withTransaction`, `writeAudit`, the Task 10 `assertDriverLink` and PATCH driver-link lines, `createUserAndLogin`, `TEST_PASSWORD`, `setupPlanning`.
- Produces:
  - `writeAudit(db, entry, opts: { session: ClientSession })` — the session is **required**, so `npm run typecheck` rejects any audit written outside a transaction from now on.
  - Every mutation route writes its document(s) and its audit entry inside one `withTransaction`; if the audit insert fails the mutation is rolled back (500, nothing stored).
  - `createUser(db, input, opts: { session?: ClientSession } = {})`, `createApiKey(db, pepper, input, opts: { session?: ClientSession } = {})`, `updateDoIfUnchanged(db, existing, set, session?: ClientSession)`, `revokeAllForUser(db, userId, session?: ClientSession)` — optional sessions, existing callers unchanged.
  - LAST_ADMIN: when a PATCH would demote or deactivate an active admin, the transaction first increments the lock document `counters { _id: 'lock:admins' }`, then updates the user, then counts active admins inside the transaction; zero → 422 `LAST_ADMIN` and the transaction aborts. Two concurrent demotions both write the lock document, so MongoDB serialises them and the second one sees the first.
  - `C.refreshFamilies` `{ _id: familyId, userId, revokedAt: Date | null, expiresAt }` (indexes `{ userId: 1 }`, TTL `{ expiresAt: 1 }`). `issueRefreshToken` upserts the family document and inserts the token in one transaction, creating the token already revoked when the family is revoked; `revokeFamily` sets the family's `revokedAt` and revokes its tokens in one transaction. Both write the family document, so a concurrent issue and revoke are serialised (compare-and-set; replaces the read-after-write check).

- [ ] **Step 1: Write the failing test**

`test/api/audit-transactions.test.ts`:
```ts
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { issueRefreshToken, revokeRefreshToken } from '../../src/modules/auth/refresh-tokens.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { TEST_PASSWORD, createUserAndLogin } from '../helpers/auth.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

/** Makes every auditLog insert fail validation, so a mutation that shares a transaction with its audit must roll back. */
const breakAudit = (app: App) =>
  app.db.command({ collMod: C.auditLog, validator: { entity: { $in: [] } }, validationLevel: 'strict', validationAction: 'error' });
const fixAudit = (app: App) => app.db.command({ collMod: C.auditLog, validator: {} });

describe('mutation and audit commit together', () => {
  let app: App;
  let f: PlanningFixtures;
  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('rolls the mutation back when its audit entry cannot be written', async () => {
    const viewer = await createUserAndLogin(app, ['viewer']);
    const post = (url: string, payload: object, headers = f.admin) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers, payload });
    await breakAudit(app);
    try {
      expect((await post('/clients', { code: 'TXN', name: 'Txn' })).statusCode).toBe(500);
      expect((await post('/pod-templates', { clientId: f.ids.scg, name: 'Txn POD', extraSteps: [], fields: [{ key: 'x', label: 'x', type: 'text', required: true }] })).statusCode).toBe(500);
      expect((await post('/resource-blocks', { resourceType: 'vehicle', resourceId: f.ids.h2, statusCode: 'PM', from: '2026-11-01T00:00:00+07:00', to: '2026-11-02T00:00:00+07:00', note: 'txn' })).statusCode).toBe(500);
      expect((await post('/delivery-orders', { clientId: f.ids.scg, clientRef: 'TXN-1', serviceTypeId: f.ids.single, materialId: f.ids.bulk, qty: 1, originLocationId: f.ids.locA, destLocationId: f.ids.locB })).statusCode).toBe(500);
      expect((await post('/api-keys', { name: 'txn-key', scopes: ['gps:write'] })).statusCode).toBe(500);
      expect((await post('/users', { username: 'txn-user', password: 'Passw0rd!', roles: ['viewer'] })).statusCode).toBe(500);
      expect((await post('/me/password', { currentPassword: TEST_PASSWORD, newPassword: 'Brand-new-9' }, viewer.headers)).statusCode).toBe(500);
    } finally {
      await fixAudit(app);
    }
    expect(await app.db.collection(C.clients).countDocuments({ code: 'TXN' })).toBe(0);
    expect(await app.db.collection(C.podTemplates).countDocuments({ name: 'Txn POD' })).toBe(0);
    expect(await app.db.collection(C.resourceBlocks).countDocuments({ note: 'txn' })).toBe(0);
    expect(await app.db.collection(C.deliveryOrders).countDocuments({ clientRef: 'TXN-1' })).toBe(0);
    expect(await app.db.collection(C.apiKeys).countDocuments({ name: 'txn-key' })).toBe(0);
    expect(await app.db.collection(C.users).countDocuments({ username: 'txn-user' })).toBe(0);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: viewer.user.username, password: TEST_PASSWORD } });
    expect(login.statusCode).toBe(200); // the password change was rolled back with its audit
  });
});

describe('concurrency guards', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => closeTestApp(app));

  it('never leaves zero active admins when two admins are demoted at the same moment', async () => {
    let keeper = await createUserAndLogin(app, ['admin']);
    for (let i = 0; i < 5; i++) {
      const other = await createUserAndLogin(app, ['admin']);
      const demote = (id: ObjectId) =>
        app.inject({ method: 'PATCH', url: `/api/v1/users/${id.toHexString()}`, headers: keeper.headers, payload: { roles: ['viewer'] } });
      const [self, peer] = await Promise.all([demote(keeper.user._id), demote(other.user._id)]);
      expect([self, peer].filter((r) => r.statusCode === 200)).toHaveLength(1);
      // The loser sees LAST_ADMIN (422), or 403 when the winner demoted the caller before its request was authorised.
      for (const r of [self, peer].filter((x) => x.statusCode !== 200)) expect([403, 422]).toContain(r.statusCode);
      expect(await app.db.collection(C.users).countDocuments({ active: true, roles: 'admin' })).toBe(1);
      if (self.statusCode === 200) keeper = other;
    }
  });

  it('never lets a refresh token issued during a family revoke survive it', async () => {
    for (let i = 0; i < 10; i++) {
      const { user, refreshToken } = await createUserAndLogin(app, ['viewer']);
      const familyId = (await app.db.collection(C.refreshTokens).findOne({ _id: new ObjectId(refreshToken.split('.')[0]) }))!.familyId as ObjectId;
      const [issued] = await Promise.all([issueRefreshToken(app.db, user._id, 1, familyId), revokeRefreshToken(app.db, refreshToken)]);
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: issued } });
      expect(res.statusCode).toBe(401);
      expect(await app.db.collection(C.refreshFamilies).findOne({ _id: familyId })).toMatchObject({ revokedAt: expect.any(Date) });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/audit-transactions.test.ts`
Expected: FAIL — the rollback test finds the client/template/block/DO/key/user it created (the mutations committed before their audit failed), and `C.refreshFamilies` does not exist (typecheck error in the test). The LAST_ADMIN race may pass by luck on the old code; it must pass every time after Step 5.

- [ ] **Step 3: Require a session for audit entries and thread optional sessions**

`src/lib/audit.ts` — replace `writeAudit` with:
```ts
export async function writeAudit(
  db: Db,
  entry: { entity: string; entityId: string; action: string; by: string; before?: unknown; after?: unknown },
  opts: { session: ClientSession },
): Promise<void> {
  // The session is required: an audit entry always commits (or rolls back) with its mutation.
  await db.collection(C.auditLog).insertOne(
    {
      entity: entry.entity,
      entityId: entry.entityId,
      action: entry.action,
      by: entry.by,
      before: entry.before ?? null,
      after: entry.after ?? null,
      at: new Date(),
    },
    { session: opts.session },
  );
}
```

`src/modules/users/users.repo.ts` — `createUser` gains a third parameter and passes it to the insert:
```ts
export async function createUser(
  db: Db,
  input: { username: string; password: string; roles: Role[]; driverId?: ObjectId | null },
  opts: { session?: ClientSession } = {},
): Promise<UserDoc> {
  const now = new Date();
  const doc: Omit<UserDoc, '_id'> = {
    username: input.username.trim(),
    passwordHash: await hashPassword(input.password),
    roles: input.roles,
    driverId: input.driverId ?? null,
    active: true,
    lastLogin: null,
    createdAt: now,
    updatedAt: now,
  };
  const res = await db.collection<UserDoc>(C.users).insertOne({ ...doc } as UserDoc, { session: opts.session });
  return { ...doc, _id: res.insertedId };
}
```
(change the first import to `import type { ClientSession, Db, ObjectId } from 'mongodb';`).

`src/modules/api-keys/api-keys.service.ts` — `createApiKey(db, pepper, input, opts: { session?: ClientSession } = {})` and `await db.collection<ApiKeyDoc>(C.apiKeys).insertOne(doc, { session: opts.session });` (import `type ClientSession` from `mongodb`).

`src/modules/orders/orders.service.ts` — `updateDoIfUnchanged(db, existing, set, session?: ClientSession)` passing `{ returnDocument: 'after', session }` to `findOneAndUpdate` (import `type ClientSession` from `mongodb`).

- [ ] **Step 4: Wrap every mutation route in one transaction**

Add `import { withTransaction } from '../../lib/tx.js';` to each routes file below that lacks it (`pod-templates.routes.ts`, `api-keys.routes.ts`, `blocks.routes.ts`, `master/resource.ts`, `users.routes.ts`, `auth.routes.ts`; `orders.routes.ts` already has it).

`src/modules/pod-templates/pod-templates.routes.ts`
- create — replace the lines from `const res = await coll().insertOne(doc as PodTemplateDoc);` to `return reply.status(201).send(toApi(saved));` with:
```ts
    const saved = await withTransaction(app.mongo, async (session) => {
      const res = await coll().insertOne({ ...doc } as PodTemplateDoc, { session });
      const created = { ...doc, _id: res.insertedId };
      await writeAudit(app.db, { entity: 'podTemplate', entityId: res.insertedId.toHexString(), action: 'create', by, after: toApi(created) }, { session });
      return created;
    });
    return reply.status(201).send(toApi(saved));
```
- patch — replace the lines from `const updated = await coll().findOneAndUpdate(` to `return toApi(updated);` with:
```ts
    const updated = await withTransaction(app.mongo, async (session) => {
      const u = await coll().findOneAndUpdate(
        { _id: existing._id, status: 'draft' },
        { $set: { ...req.body, updatedAt: new Date() } },
        { returnDocument: 'after', session },
      );
      if (!u) throw published();
      await writeAudit(app.db, { entity: 'podTemplate', entityId: req.params.id, action: 'update', by: actorOf(req), before: toApi(existing), after: toApi(u) }, { session });
      return u;
    });
    return toApi(updated);
```
- publish — replace the lines from `const updated = await coll().findOneAndUpdate(` to `return toApi(updated);` with:
```ts
    const updated = await withTransaction(app.mongo, async (session) => {
      const u = await coll().findOneAndUpdate(
        { _id: draft._id, status: 'draft' },
        { $set: { status: 'published', version: (last?.version ?? 0) + 1, publishedAt: new Date(), publishedBy: by, updatedAt: new Date() } },
        { returnDocument: 'after', session },
      );
      if (!u) throw published();
      await writeAudit(app.db, { entity: 'podTemplate', entityId: req.params.id, action: 'publish', by, after: toApi(u) }, { session });
      return u;
    });
    return toApi(updated);
```
- clone — replace the lines from `const res = await coll().insertOne(doc as PodTemplateDoc);` to `return reply.status(201).send(toApi(saved));` with:
```ts
    const saved = await withTransaction(app.mongo, async (session) => {
      const res = await coll().insertOne({ ...doc } as PodTemplateDoc, { session });
      await writeAudit(app.db, { entity: 'podTemplate', entityId: res.insertedId.toHexString(), action: 'clone', by, after: { from: req.params.id } }, { session });
      return { ...doc, _id: res.insertedId };
    });
    return reply.status(201).send(toApi(saved));
```

`src/modules/api-keys/api-keys.routes.ts`
- create — replace the two lines `const { doc, key } = await createApiKey(...)` and its `writeAudit(...)` with:
```ts
      const { doc, key } = await withTransaction(app.mongo, async (session) => {
        const created = await createApiKey(app.db, app.config.API_KEY_PEPPER, { ...req.body, createdBy: by }, { session });
        await writeAudit(app.db, { entity: 'apiKey', entityId: created.doc._id.toHexString(), action: 'create', by, after: publicKey(created.doc) }, { session });
        return created;
      });
```
- revoke — replace the handler body with:
```ts
    const updated = await withTransaction(app.mongo, async (session) => {
      const u = await app.db
        .collection<ApiKeyDoc>(C.apiKeys)
        .findOneAndUpdate({ _id: new ObjectId(req.params.id) }, { $set: { active: false } }, { returnDocument: 'after', session });
      if (!u) throw notFound('API key');
      await writeAudit(app.db, { entity: 'apiKey', entityId: req.params.id, action: 'revoke', by: actorOf(req) }, { session });
      return u;
    });
    return publicKey(updated);
```

`src/modules/availability/blocks.routes.ts`
- create — replace `await coll().insertOne(doc);` and the following `writeAudit(...)` with:
```ts
      await withTransaction(app.mongo, async (session) => {
        await coll().insertOne(doc, { session });
        await writeAudit(app.db, { entity: 'resourceBlock', entityId: doc._id.toHexString(), action: 'create', by, after: toApi(doc) }, { session });
      });
```
- update — replace the lines from `const updated = await coll().findOneAndUpdate(` to the `writeAudit(...)` line with:
```ts
      const updated = await withTransaction(app.mongo, async (session) => {
        const u = await coll().findOneAndUpdate({ _id: existing._id, cancelledAt: null }, { $set: set }, { returnDocument: 'after', session });
        if (!u) throw unprocessable('BLOCK_CANCELLED', 'A cancelled block cannot be changed');
        await writeAudit(app.db, { entity: 'resourceBlock', entityId: req.params.id, action: 'update', by, before: toApi(existing), after: toApi(u) }, { session });
        return u;
      });
```
- cancel — replace the lines from `const updated = await coll().findOneAndUpdate(` to the `writeAudit(...)` line with:
```ts
    const updated = await withTransaction(app.mongo, async (session) => {
      const u = await coll().findOneAndUpdate(
        { _id: existing._id, cancelledAt: null },
        { $set: { cancelledAt: new Date(), updatedBy: by, updatedAt: new Date() } },
        { returnDocument: 'after', session },
      );
      if (!u) throw unprocessable('BLOCK_CANCELLED', 'The block is already cancelled');
      await writeAudit(app.db, { entity: 'resourceBlock', entityId: req.params.id, action: 'cancel', by, before: toApi(existing), after: toApi(u) }, { session });
      return u;
    });
```

`src/modules/master/resource.ts`
- create — replace the lines from `const res = await coll().insertOne(doc);` to `return reply.status(201).send(out(saved));` with:
```ts
      const saved = await withTransaction(app.mongo, async (session) => {
        const res = await coll().insertOne({ ...doc }, { session });
        const created = { ...doc, _id: res.insertedId };
        await writeAudit(app.db, { entity: def.name, entityId: res.insertedId.toHexString(), action: 'create', by: actorOf(req), after: toApi(created) }, { session });
        return created;
      });
      return reply.status(201).send(out(saved));
```
- update — replace the lines from `const updated = await coll().findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after' });` to `return out(updated);` with:
```ts
      const updated = await withTransaction(app.mongo, async (session) => {
        const u = await coll().findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after', session });
        if (!u) throw notFound(def.name);
        await writeAudit(app.db, { entity: def.name, entityId: params.id, action: 'update', by: actorOf(req), before: toApi(existing), after: toApi(u) }, { session });
        return u;
      });
      return out(updated);
```
- deactivate — replace the handler body after `const pf = await parentFilter(params);` with:
```ts
      const updated = await withTransaction(app.mongo, async (session) => {
        const u = await coll().findOneAndUpdate(
          { _id: new ObjectId(params.id), ...pf },
          { $set: { active: false, updatedAt: new Date() } },
          { returnDocument: 'after', session },
        );
        if (!u) throw notFound(def.name);
        await writeAudit(app.db, { entity: def.name, entityId: params.id, action: 'deactivate', by: actorOf(req) }, { session });
        return u;
      });
      return out(updated);
```

`src/modules/orders/orders.routes.ts`
- create — replace `await coll().insertOne(doc);` and the following `writeAudit(...)` with:
```ts
    await withTransaction(app.mongo, async (session) => {
      await coll().insertOne(doc, { session });
      await writeAudit(app.db, { entity: 'deliveryOrder', entityId: doc._id.toHexString(), action: 'create', by, after: toApi(doc) }, { session });
    });
```
- patch — replace the lines from `const updated = await updateDoIfUnchanged(` to the `writeAudit(...)` line with:
```ts
      const updated = await withTransaction(app.mongo, async (session) => {
        const u = await updateDoIfUnchanged(app.db, existing, { ...set, updatedBy: by, updatedAt: new Date() }, session);
        if (!u) throw conflict('DO_CHANGED', 'The delivery order changed; reload and try again');
        await writeAudit(app.db, { entity: 'deliveryOrder', entityId: req.params.id, action: 'update', by, before: toApi(existing), after: toApi(u) }, { session });
        return u;
      });
```
- cancel — replace the lines from `const updated = await coll().findOneAndUpdate(` to the `writeAudit(...)` line with:
```ts
      const updated = await withTransaction(app.mongo, async (session) => {
        const u = await coll().findOneAndUpdate(
          { _id: existing._id, status: 'UNASSIGNED', shipmentId: null },
          { $set: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: req.body.reason, updatedBy: by, updatedAt: new Date() } },
          { returnDocument: 'after', session },
        );
        if (!u) throw unprocessable('DO_NOT_CANCELLABLE', 'The delivery order changed; reload and try again');
        await writeAudit(app.db, { entity: 'deliveryOrder', entityId: req.params.id, action: 'cancel', by, before: toApi(existing), after: toApi(u) }, { session });
        return u;
      });
```

`src/modules/auth/auth.routes.ts` (`POST /me/password`) — replace the lines from `await app.db` (the `passwordHash` update) through the `writeAudit({...})` call with:
```ts
      const passwordHash = await hashPassword(req.body.newPassword);
      await withTransaction(app.mongo, async (session) => {
        await app.db.collection(C.users).updateOne({ _id: user._id }, { $set: { passwordHash, updatedAt: new Date() } }, { session });
        await revokeAllForUser(app.db, user._id, session);
        await writeAudit(app.db, { entity: 'user', entityId: user._id.toHexString(), action: 'password-change', by: actorOf(req) }, { session });
      });
```

`src/modules/users/users.routes.ts` — add `import { withTransaction } from '../../lib/tx.js';` and the module-level constant `const ADMIN_LOCK = 'lock:admins';`; then
- create — replace `const u = await createUser(app.db, { ...req.body, driverId });` and its `writeAudit(...)` with:
```ts
    const by = actorOf(req);
    const u = await withTransaction(app.mongo, async (session) => {
      const created = await createUser(app.db, { ...req.body, driverId }, { session });
      await writeAudit(app.db, { entity: 'user', entityId: created._id.toHexString(), action: 'create', by, after: safeUser(created) }, { session });
      return created;
    });
```
- replace the whole `PATCH /users/:id` handler body (it keeps the Task 10 driver-link lines) with:
```ts
    const _id = new ObjectId(req.params.id);
    const existing = await users().findOne({ _id });
    if (!existing) throw notFound('User');
    const roles = req.body.roles ?? existing.roles;
    const willBeActive = req.body.active ?? existing.active;
    const requested = req.body.driverId === undefined ? undefined : req.body.driverId ? new ObjectId(req.body.driverId) : null;
    // Keep the link only on an active driver account; otherwise release it so the driver can be linked again.
    const driverId = requested !== undefined ? requested : roles.includes('driver') && willBeActive ? existing.driverId : null;
    await assertDriverLink(app.db, roles, driverId, willBeActive, _id);
    const losesAdmin = existing.active && existing.roles.includes('admin') && !(willBeActive && roles.includes('admin'));
    const set: Partial<UserDoc> = { roles, driverId, updatedAt: new Date() };
    if (req.body.active !== undefined) set.active = req.body.active;
    if (req.body.password) set.passwordHash = await hashPassword(req.body.password);
    const by = actorOf(req);
    const locks = app.db.collection<{ _id: string; seq: number }>(C.counters);
    if (losesAdmin) await locks.updateOne({ _id: ADMIN_LOCK }, { $setOnInsert: { seq: 0 } }, { upsert: true });
    const updated = await withTransaction(app.mongo, async (session) => {
      // Every demotion/deactivation of an admin writes the same lock document first, so concurrent
      // ones conflict and MongoDB retries the loser, which then counts the winner's change.
      if (losesAdmin) await locks.updateOne({ _id: ADMIN_LOCK }, { $inc: { seq: 1 } }, { session });
      const u = await users().findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after', session });
      if (!u) throw notFound('User');
      if (losesAdmin && (await users().countDocuments({ active: true, roles: 'admin' }, { session, limit: 1 })) === 0) {
        throw unprocessable('LAST_ADMIN', 'Cannot deactivate or demote the last active admin');
      }
      if (req.body.password || req.body.active === false) await revokeAllForUser(app.db, _id, session);
      await writeAudit(app.db, { entity: 'user', entityId: req.params.id, action: 'update', by, before: safeUser(existing), after: safeUser(u) }, { session });
      return u;
    });
    return safeUser(updated);
```

- [ ] **Step 5: Serialise refresh-token issue and family revoke**

Add `refreshFamilies: 'refreshFamilies'` to `C` and indexes `[C.refreshFamilies]: [{ key: { userId: 1 } }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }]`.

Replace `src/modules/auth/refresh-tokens.ts` with:
```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ObjectId, type ClientSession, type Db } from 'mongodb';
import { C } from '../../db/collections.js';
import { AppError } from '../../lib/errors.js';
import { withTransaction } from '../../lib/tx.js';

export interface RefreshTokenDoc {
  _id: ObjectId;
  userId: ObjectId;
  familyId: ObjectId;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  replacedAt: Date | null;
  revokedAt: Date | null;
}

/** One document per rotation family; issue and revoke both write it, so MongoDB serialises them. */
export interface RefreshFamilyDoc {
  _id: ObjectId;
  userId: ObjectId;
  revokedAt: Date | null;
  expiresAt: Date;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function issueRefreshToken(
  db: Db,
  userId: ObjectId,
  ttlDays: number,
  familyId: ObjectId = new ObjectId(),
): Promise<string> {
  const _id = new ObjectId();
  const secret = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000);
  await withTransaction(db.client, async (session) => {
    // Compare-and-set on the family document: a concurrent revoke either commits first (and this
    // token is born revoked) or conflicts with this write and is retried after it (and revokes it).
    const family = await db.collection<RefreshFamilyDoc>(C.refreshFamilies).findOneAndUpdate(
      { _id: familyId },
      { $setOnInsert: { userId, revokedAt: null }, $max: { expiresAt } },
      { upsert: true, returnDocument: 'after', session },
    );
    await db.collection<RefreshTokenDoc>(C.refreshTokens).insertOne(
      { _id, userId, familyId, tokenHash: sha256(secret), expiresAt, createdAt: now, replacedAt: null, revokedAt: family?.revokedAt ? now : null },
      { session },
    );
  });
  return `${_id.toHexString()}.${secret}`;
}

function parseToken(token: string): { id: ObjectId; secret: string } | null {
  const dot = token.indexOf('.');
  if (dot !== 24) return null;
  const id = token.slice(0, 24);
  const secret = token.slice(25);
  if (!/^[a-f0-9]{24}$/.test(id) || secret.length === 0) return null;
  return { id: new ObjectId(id), secret };
}

function hashMatches(stored: string, secret: string): boolean {
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(sha256(secret), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const invalid = () => new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token');
const reused = () => new AppError(401, 'REFRESH_TOKEN_REUSED', 'Refresh token was already used; please log in again');

async function revokeFamily(db: Db, token: Pick<RefreshTokenDoc, 'familyId' | 'userId' | 'expiresAt'>): Promise<void> {
  await withTransaction(db.client, async (session) => {
    const now = new Date();
    await db.collection<RefreshFamilyDoc>(C.refreshFamilies).updateOne(
      { _id: token.familyId },
      { $set: { revokedAt: now }, $setOnInsert: { userId: token.userId }, $max: { expiresAt: token.expiresAt } },
      { upsert: true, session },
    );
    await db
      .collection<RefreshTokenDoc>(C.refreshTokens)
      .updateMany({ familyId: token.familyId, revokedAt: null }, { $set: { revokedAt: now } }, { session });
  });
}

// Shared decision for a token that has already been replaced or revoked, used both
// by the sequential path (doc read as already-used) and the race path (this call
// lost the atomic claim to a concurrent rotation). Keeping this in one place means
// the two paths can't silently drift apart.
// - revoked                          -> revoke the family, reject as reused
// - replaced within the grace window -> a quick retry; return the same result
// - replaced outside the grace window -> revoke the family, reject as reused
//
// graceSec === 0 means zero tolerance: this must NEVER depend on millisecond-level
// timing (two callers can legitimately observe the same `replacedAt` timestamp when
// they lose a race within the same tick), so a lost race is unconditionally reuse
// when there is no grace window at all.
async function resolveReplayState(
  db: Db,
  doc: RefreshTokenDoc,
  now: Date,
  graceSec: number,
): Promise<{ userId: ObjectId; familyId: ObjectId }> {
  if (
    graceSec > 0 &&
    !doc.revokedAt &&
    doc.replacedAt &&
    now.getTime() - doc.replacedAt.getTime() <= graceSec * 1000
  ) {
    return { userId: doc.userId, familyId: doc.familyId };
  }
  await revokeFamily(db, doc);
  throw reused();
}

export async function rotateRefreshToken(
  db: Db,
  token: string,
  graceSec: number,
): Promise<{ userId: ObjectId; familyId: ObjectId }> {
  const coll = db.collection<RefreshTokenDoc>(C.refreshTokens);
  const parsed = parseToken(token);
  if (!parsed) throw invalid();
  const doc = await coll.findOne({ _id: parsed.id });
  if (!doc || !hashMatches(doc.tokenHash, parsed.secret)) throw invalid();
  const now = new Date();
  if (doc.revokedAt) return resolveReplayState(db, doc, now, graceSec);
  if (doc.expiresAt <= now) throw invalid();
  if (doc.replacedAt) return resolveReplayState(db, doc, now, graceSec);

  const updated = await coll.findOneAndUpdate(
    { _id: doc._id, replacedAt: null, revokedAt: null },
    { $set: { replacedAt: now } },
  );
  if (updated) return { userId: doc.userId, familyId: doc.familyId };

  // Lost the race: another concurrent call claimed this token first. Re-read its
  // current state and apply the same replay rules instead of assuming success.
  const fresh = await coll.findOne({ _id: doc._id });
  if (!fresh) throw invalid();
  return resolveReplayState(db, fresh, new Date(), graceSec);
}

export async function revokeRefreshToken(db: Db, token: string): Promise<void> {
  const parsed = parseToken(token);
  if (!parsed) return;
  const doc = await db.collection<RefreshTokenDoc>(C.refreshTokens).findOne({ _id: parsed.id });
  if (doc && hashMatches(doc.tokenHash, parsed.secret)) await revokeFamily(db, doc);
}

/** Revokes every session of a user (password change, deactivation); pass the caller's session to commit with it. */
export async function revokeAllForUser(db: Db, userId: ObjectId, session?: ClientSession): Promise<void> {
  const now = new Date();
  await db.collection<RefreshFamilyDoc>(C.refreshFamilies).updateMany({ userId, revokedAt: null }, { $set: { revokedAt: now } }, { session });
  await db.collection<RefreshTokenDoc>(C.refreshTokens).updateMany({ userId, revokedAt: null }, { $set: { revokedAt: now } }, { session });
}
```

In `docs/superpowers/plans/2026-09-27-roadmap.md` change the owner cell of the row "Wrap mutation + audit in one transaction; LAST_ADMIN check is not transactional; refresh-race guard is read-after-write" to `Done — Plan 3 Task 12`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck && npm run build`; then run the concurrency tests 10× (`for i in $(seq 1 10); do npx vitest run test/api/audit-transactions.test.ts test/api/auth-refresh.test.ts || break; done`).
Expected: all PASS. Because `writeAudit` now requires `{ session }`, `npm run typecheck` fails on any audit written outside a transaction — that is the regression guard for this carry-forward item.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "fix(audit): commit every mutation with its audit entry; serialise LAST_ADMIN and refresh-token family revokes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

## Self-review notes (plan author)

- **Spec coverage:** §5.3 stop events + extra steps + reason codes (Tasks 2, 4); §5.4 GPS on every driver action (Tasks 2, 4, 5, 7); §5.6 status derivation — pure `lib/status.ts` used by every driver-driven write (Task 2; applied in Tasks 4, 5, 6); §6.1 POD content per template + automatic evidence (Tasks 3, 5); §6.2 presigned uploads + hash verification (Tasks 1, 5); §6.3 tamper hash, exact spec formula, documented for third parties (Tasks 5, 11); §6.4 review (Task 6); §7 pallets incl. drivers reading their own movements (Task 7); §3.4/§9 close + summary + PDF, legacy DOs exempt (Tasks 8, 9); §8.1 "every mutation writes auditLog" in the same transaction (Tasks 6–8 and 12; system-derived statuses exempt by ruling P3-R7).
- **Roadmap carry-forward owned by Plan 3:** stale `users.driverId` → Task 10 (before the Task 11 demo onboarding); mutation + audit in one transaction, LAST_ADMIN under concurrency, refresh-token race → Task 12. The Plan 2 "PICKED_UP DOs flagged DO_NOT_AVAILABLE on re-validation" item is moot: Plan 3 never re-validates a shipment after pickup.
- **Not in this plan:** admin `CORRECTION` events and step override (Plan 4 roadmap row, added in Task 11), geofence suggestions (Plan 4), POD `palletLines` legacy migration (Plan 4), POD file re-hash performance (Plan 4 roadmap row, added in Task 11).
- **Concurrency covered by tests:** racing taps on one stop (Task 4, shipment `version` guard), the last two PODs at once (Task 5, shipment re-read + version bump in the transaction), concurrent pallet movements (Task 7), concurrent admin demotions and issue-vs-revoke of refresh tokens (Task 12). Each has a 10× loop in its verify step.
- **Task order:** Tasks 1–9 build on each other (1 → 2 → 3 → 4 → 5 → 6 → 7/8 → 9); Task 10 must precede Task 11; Task 12 is last and touches only Plan 1–2 files plus `lib/audit.ts`. Tasks that add entries to `collections.ts`, `indexes.ts` and `routes.ts` (4, 5, 7, 8, 12) must run sequentially, not in parallel worktrees.
