# Plan 2 — Delivery Orders, Shipments & Availability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Planners can create delivery orders (with automatic job-group matching), build shipments with ordered stops on head/tail/rigid vehicles and drivers, validate them against every planning rule (double booking, stop order, availability blocks, calendar), move them through DRAFT → PLANNED → DISPATCHED → ACCEPTED/declined or CANCELLED, and query truck/driver availability using a two-level status catalogue.

**Architecture:** New modules `orders`, `shipments`, `availability` and a `driver` route group on top of Plan 1. Pure planning logic (stop building, legs, structural rules, Bangkok dates) lives in dependency-free functions with unit tests; a DB-aware `validateShipment` collects every error/warning; writes that touch a shipment and its delivery orders run in one MongoDB transaction with the audit entry. Optimistic concurrency uses an integer `version` on shipments.

**Tech Stack:** unchanged from Plan 1 (Node 22, TypeScript ESM, Fastify 5, zod 3, fastify-type-provider-zod 4, mongodb 6, Vitest + MongoMemoryReplSet). Security upgrades from Plan 1 apply (@fastify/jwt 10, @fastify/swagger-ui 6).

**Spec:** `docs/superpowers/specs/2026-09-27-phase1-planning-epod-design.md` (§3–§5, §8.3 delivery orders + shipments) and `docs/superpowers/specs/2026-09-27-phase2-requirements-availability-costing.md` §1 (availability, two-level status). Carry-forward list: `docs/superpowers/plans/2026-09-27-roadmap.md`.

**Decisions made in this plan (flag to PO at handoff):**
- A shipment in **DRAFT** may be incomplete (missing vehicle, driver, stops or DOs → returned as warnings) but can never contain conflicts (double booking, blocked resource, wrong slot, stop-order errors, DO taken elsewhere → 422). `POST /shipments/:id/plan` requires completeness.
- A delivery order that is in any non-cancelled shipment (including DRAFT) has status `PLANNED`; it leaves the pool until removed or the shipment is cancelled.
- Double booking counts every shipment that is not `CANCELLED` or `CLOSED` (spec §4 wording).
- Auto-built stops (`doIds` without `stops`): each DO's pickup joins the earliest existing stop at its origin, its drop joins the first stop at its destination after that pickup, otherwise a new stop is appended. Milk runs (several pickups before one drop) should be sent with explicit `stops`.
- Bulk DO creation takes JSON (`POST /delivery-orders/bulk`); the admin panel converts Excel to JSON. A server-side DO Excel import is not in this plan.
- The client-vs-map distance warning from spec §4 is **not** implemented: there is no map-distance source yet (`legs[].mapKm` stays `null`). Tracked in the roadmap.
- New delivery-order status `CANCELLED` (spec lists a cancel endpoint but no status for it).

## Global Constraints

- Everything in Plan 1's Global Constraints still applies (Node ≥22, strict TS, ESM `.js` imports, error body `{ code, message, details? }`, 24-hex ids in the API, UTC ISO timestamps, roles, every API mutation writes one `auditLog` doc, never `git push`).
- Delivery-order numbers `DO-YYMM-NNNNN` and shipment numbers `SH-YYMM-NNNNN` come only from `nextNumber()`; never accepted as input.
- Shipment statuses: `DRAFT`, `PLANNED`, `DISPATCHED`, `ACCEPTED`, `IN_TRANSIT`, `COMPLETED`, `CLOSED`, `CANCELLED`. Delivery-order statuses: `UNASSIGNED`, `PLANNED`, `PICKED_UP`, `DELIVERED`, `POD_VERIFIED`, `POD_REJECTED`, `FAILED`, `CANCELLED`.
- Business warnings are returned in a `warnings: { code, message, details? }[]` field of successful responses; blocking problems are 422 with a specific `code` (validation failures of a whole shipment use `SHIPMENT_INVALID` with `details: { errors, warnings }`).
- Shipment mutations require the client's current `version`; a mismatch is `409 VERSION_CONFLICT`. Every successful shipment mutation increments `version` by 1.
- Any write that changes a shipment and its delivery orders runs inside one MongoDB transaction together with its audit entry (`withTransaction` from `src/lib/tx.ts`).
- Calendar logic (days off, holidays, "today") uses Asia/Bangkok dates (`YYYY-MM-DD`).
- Read access for planning data: `admin`, `planner`, `viewer`. Writes: `admin`, `planner`. Status-code catalogue writes: `admin` only. Driver endpoints: role `driver` with a linked `driverId`, and only for shipments where they are the head or tail driver.
- Commit trailer lines:
```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6
```
(implementers may name their actual model in the Co-Authored-By line).

## Review Focus

1. **Two planners put the same DO on two shipments at the same moment** → exactly one succeeds; the other gets `409 DO_TAKEN`; the DO ends up in one shipment only. Test in Task 8.
2. **A shipment that runs past midnight or across a weekend** → day-off and holiday warnings use Bangkok calendar dates of every day the window touches (a 22:00–02:00 trip touches two dates). Tests in Tasks 5 and 7.
3. **Planner edits a shipment after it was dispatched/accepted** → it returns to `PLANNED`, `dispatch`/`driverResponse` are cleared, and the driver no longer sees it until it is dispatched again. Test in Task 10.
4. **A vehicle, driver or location that was deactivated** → it cannot be put on a new or edited shipment (`INACTIVE_REFERENCE`), but existing shipments and DOs that already use it still load. Tests in Tasks 3 and 7.
5. **A second browser tab saves an old copy of the shipment** → `409 VERSION_CONFLICT`, nothing overwritten. Test in Task 9.

---

## File Structure

```
src/
  lib/issues.ts                 Issue type + IssueSchema (zod)
  lib/active-refs.ts            checkActiveRefs / assertActiveRefs
  lib/tx.ts                     withTransaction
  lib/time.ts                   bangkokDate, bangkokDatesBetween, bangkokWeekday, overlaps
  db/collections.ts             + statusCodes, holidays, resourceBlocks, deliveryOrders, shipments
  db/indexes.ts                 + indexes for the new collections
  modules/master/simple.ts      truck type category guard
  modules/master/locations.ts   isSite guard
  modules/master/fleet.ts       drivers.weeklyDaysOff
  modules/master/job-group-match.ts  candidates doc comment
  modules/availability/status-codes.ts   statusCodesDef, holidaysDef
  modules/availability/blocks.service.ts findActiveBlocks, prepareBlock
  modules/availability/blocks.routes.ts  /resource-blocks
  modules/availability/availability.routes.ts /availability
  modules/orders/order.types.ts
  modules/orders/orders.schemas.ts
  modules/orders/orders.service.ts       prepareDoFields, rematchJobGroup
  modules/orders/orders.routes.ts        /delivery-orders (+ /bulk)
  modules/shipments/shipment.types.ts
  modules/shipments/shipment.domain.ts   buildStopsFromDos, deriveLegs, structuralIssues (pure)
  modules/shipments/shipment.queries.ts  findShipmentsUsing
  modules/shipments/shipment.schemas.ts
  modules/shipments/shipment.validation.ts toDraft, validateShipment
  modules/shipments/shipment.service.ts  create/update/transition helpers
  modules/shipments/shipments.routes.ts  /shipments…
  modules/shipments/driver.routes.ts     /driver/shipments…
  seed/seed.ts                  + BASE_STATUS_CODES
test/helpers/planning.ts        setupPlanning fixtures, createDo, postShipment
```

---

### Task 1: Master-data guards carried forward from Plan 1

**Files:**
- Modify: `src/modules/master/simple.ts`, `src/modules/master/locations.ts`, `src/modules/master/job-group-match.ts`, `src/lib/counters.ts`
- Test: `test/api/master-guards.test.ts`

**Interfaces:**
- Consumes: `ResourceDef.validate(merged, { db, existing })` (called by `prepareDoc` on POST, PATCH and imports).
- Produces: 422 `TRUCK_TYPE_IN_USE` (category change while vehicles reference the type); 422 `LOCATION_USED_AS_SITE` (`isSite` true→false while a job group lists it in `criteria.siteIds`).

- [ ] **Step 1: Write the failing test**

`test/api/master-guards.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';

describe('master-data guards', () => {
  let app: App;
  let h: { authorization: string };
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });
  const patch = (url: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/v1${url}`, headers: h, payload });

  beforeAll(async () => {
    app = await buildTestApp();
    h = (await createUserAndLogin(app, ['planner'])).headers;
  });
  afterAll(async () => closeTestApp(app));

  it('blocks changing a truck type category while vehicles use it', async () => {
    const used = (await post('/truck-types', { code: 'TRAILER', name: 'Trailer', category: 'tractor' })).json().id;
    const unused = (await post('/truck-types', { code: 'SPARE', name: 'Spare', category: 'tractor' })).json().id;
    await post('/vehicles', { plate: '70-1001', part: 'head', truckTypeId: used });
    const blocked = await patch(`/truck-types/${used}`, { category: 'rigid' });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().code).toBe('TRUCK_TYPE_IN_USE');
    expect((await patch(`/truck-types/${used}`, { name: 'Trailer 22 ล้อ' })).statusCode).toBe(200);
    expect((await patch(`/truck-types/${unused}`, { category: 'rigid' })).json().category).toBe('rigid');
  });

  it('blocks un-marking a site that a job group uses', async () => {
    const zone = (await post('/zones', { code: 'CEN', name: 'Central' })).json().id;
    const client = (await post('/clients', { code: 'SCG', name: 'SCG' })).json().id;
    const site = (await post('/locations', { code: 'PLANT', name: 'Plant', zoneId: zone, isSite: true, lat: 14.5, lng: 100.9 })).json().id;
    const other = (await post('/locations', { code: 'PLANT2', name: 'Plant 2', zoneId: zone, isSite: true, lat: 14.6, lng: 100.8 })).json().id;
    await post(`/clients/${client}/job-groups`, { code: 'G', name: 'G', criteria: { siteIds: [site] } });
    const blocked = await patch(`/locations/${site}`, { isSite: false });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().code).toBe('LOCATION_USED_AS_SITE');
    expect((await patch(`/locations/${site}`, { name: 'Plant renamed' })).statusCode).toBe(200);
    expect((await patch(`/locations/${other}`, { isSite: false })).json().isSite).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/master-guards.test.ts`
Expected: FAIL — both PATCH calls return 200 instead of 422.

- [ ] **Step 3: Implement**

In `src/modules/master/simple.ts` add `import { unprocessable } from '../../lib/errors.js';` and give `truckTypesDef` a `validate`:
```ts
export const truckTypesDef: ResourceDef = {
  name: 'truckType', path: '/truck-types', collection: C.truckTypes,
  body: truckType, item: truckType, searchFields: ['code', 'name'], filterFields: [{ name: 'category' }],
  validate: async (merged, { db, existing }) => {
    if (!existing || existing.category === merged.category) return;
    const inUse = await db.collection(C.vehicles).countDocuments({ truckTypeId: existing._id }, { limit: 1 });
    if (inUse > 0) {
      throw unprocessable('TRUCK_TYPE_IN_USE', 'The category cannot change while vehicles use this truck type');
    }
  },
};
```

In `src/modules/master/locations.ts` add to `locationsDef`:
```ts
  validate: async (merged, { db, existing }) => {
    if (!existing || existing.isSite !== true || merged.isSite !== false) return;
    const used = await db.collection(C.jobGroups).countDocuments({ 'criteria.siteIds': existing._id }, { limit: 1 });
    if (used > 0) {
      throw unprocessable('LOCATION_USED_AS_SITE', 'This location is a site in a job group; remove it from the job group first');
    }
  },
```

In `src/modules/master/job-group-match.ts`, put this comment directly above `export type MatchResult`:
```ts
/**
 * `candidates`: for `auto`, every group that matched (the winner included); for `ambiguous`,
 * only the groups tied at the highest specificity (the planner chooses one of them); for
 * `none`, empty. Delivery orders persist this array as `jobGroupMatch.candidates`.
 */
```

In `src/lib/counters.ts`, put this comment directly above `export async function nextNumber`:
```ts
// Past 99 999 numbers in one prefix-month the sequence simply widens to six digits
// (e.g. SH-2610-100000). Numbers stay unique; sort them numerically, not as strings.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(master): guard truck-type category and site flag changes that would break references" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 2: Status-code catalogue, company holidays, driver days off

**Files:**
- Create: `src/modules/availability/status-codes.ts`
- Modify: `src/db/collections.ts`, `src/db/indexes.ts`, `src/modules/master/master.routes.ts`, `src/modules/master/fleet.ts`, `src/seed/seed.ts`, `test/unit/seed.test.ts`
- Test: `test/api/status-codes.test.ts`

**Interfaces:**
- Produces:
  - `C.statusCodes`, `C.holidays`, `C.resourceBlocks`, `C.deliveryOrders`, `C.shipments` collection names.
  - `LEVEL1 = ['working','not_working']`, `APPLIES_TO = ['vehicle','driver','both']`, `statusCodesDef` at `/status-codes` (admin writes; 422 `INVALID_STATUS_CODE` when a `working` code has `blocksAssignment: true`), `holidaysDef` at `/holidays` (`{ date: 'YYYY-MM-DD', name }`, unique date).
  - Drivers gain `weeklyDaysOff: number[]` (0 = Sunday … 6 = Saturday, default `[]`).
  - `BASE_STATUS_CODES` seeded by `seedBase` (planning codes + ATMS daily codes).

- [ ] **Step 1: Write the failing tests**

`test/api/status-codes.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';

describe('status codes, holidays, driver days off', () => {
  let app: App;
  let admin: { authorization: string };
  let planner: { authorization: string };
  beforeAll(async () => {
    app = await buildTestApp();
    admin = (await createUserAndLogin(app, ['admin'])).headers;
    planner = (await createUserAndLogin(app, ['planner'])).headers;
  });
  afterAll(async () => closeTestApp(app));

  it('lets only admins manage status codes and rejects blocking working codes', async () => {
    const payload = { code: 'PM', name: 'เข้า PM', level1: 'not_working', appliesTo: 'vehicle', blocksAssignment: true };
    expect((await app.inject({ method: 'POST', url: '/api/v1/status-codes', headers: planner, payload })).statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/status-codes', headers: admin, payload });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ code: 'PM', level1: 'not_working', blocksAssignment: true });
    const bad = await app.inject({
      method: 'POST', url: '/api/v1/status-codes', headers: admin,
      payload: { code: 'A', name: 'ทำงาน', level1: 'working', appliesTo: 'both', blocksAssignment: true },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('INVALID_STATUS_CODE');
    const list = await app.inject({ method: 'GET', url: '/api/v1/status-codes?level1=not_working', headers: planner });
    expect(list.json().items.map((s: { code: string }) => s.code)).toEqual(['PM']);
  });

  it('manages company holidays with a unique date', async () => {
    const payload = { date: '2026-10-13', name: 'วันนวมินทรมหาราช' };
    expect((await app.inject({ method: 'POST', url: '/api/v1/holidays', headers: planner, payload })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/v1/holidays', headers: planner, payload })).statusCode).toBe(409);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/holidays', headers: planner, payload: { date: '13/10/2026', name: 'x' } });
    expect(bad.statusCode).toBe(400);
  });

  it('stores driver weekly days off, defaulting to none', async () => {
    const d = await app.inject({ method: 'POST', url: '/api/v1/drivers', headers: planner, payload: { code: 'D1', name: 'Driver 1', weeklyDaysOff: [0, 6] } });
    expect(d.json().weeklyDaysOff).toEqual([0, 6]);
    const e = await app.inject({ method: 'POST', url: '/api/v1/drivers', headers: planner, payload: { code: 'D2', name: 'Driver 2' } });
    expect(e.json().weeklyDaysOff).toEqual([]);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/drivers', headers: planner, payload: { code: 'D3', name: 'x', weeklyDaysOff: [7] } });
    expect(bad.statusCode).toBe(400);
  });
});
```

In `test/unit/seed.test.ts`, inside the first test (`'seeds base data idempotently without overwriting edits'`), add after the existing `palletMovementTypes` assertion:
```ts
    expect(await db.collection(C.statusCodes).countDocuments()).toBe(BASE_STATUS_CODES.length);
    expect(await db.collection(C.statusCodes).findOne({ code: 'A' })).toMatchObject({ level1: 'working', blocksAssignment: false });
    expect(await db.collection(C.statusCodes).findOne({ code: 'PM' })).toMatchObject({ level1: 'not_working', appliesTo: 'vehicle', blocksAssignment: true });
```
and extend its import from `../../src/seed/seed.js` to include `BASE_STATUS_CODES`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/api/status-codes.test.ts test/unit/seed.test.ts`
Expected: FAIL — 404 routes, `C.statusCodes` undefined, `BASE_STATUS_CODES` missing.

- [ ] **Step 3: Implement**

`src/db/collections.ts` — add inside `C`:
```ts
  statusCodes: 'statusCodes',
  holidays: 'holidays',
  resourceBlocks: 'resourceBlocks',
  deliveryOrders: 'deliveryOrders',
  shipments: 'shipments',
```

`src/modules/availability/status-codes.ts`:
```ts
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { unprocessable } from '../../lib/errors.js';
import type { ResourceDef } from '../master/resource.js';
import { Name } from '../master/simple.js';

export const LEVEL1 = ['working', 'not_working'] as const;
export type Level1 = (typeof LEVEL1)[number];
export const APPLIES_TO = ['vehicle', 'driver', 'both'] as const;
export type AppliesTo = (typeof APPLIES_TO)[number];

const StatusCodeBody = z.object({
  code: z.string().trim().min(1).max(20),
  name: Name,
  level1: z.enum(LEVEL1),
  appliesTo: z.enum(APPLIES_TO),
  blocksAssignment: z.boolean().default(false),
});

export const statusCodesDef: ResourceDef = {
  name: 'statusCode',
  path: '/status-codes',
  collection: C.statusCodes,
  body: StatusCodeBody,
  item: StatusCodeBody,
  searchFields: ['code', 'name'],
  filterFields: [{ name: 'level1' }, { name: 'appliesTo' }],
  writeRoles: ['admin'],
  validate: async (merged) => {
    if (merged.level1 === 'working' && merged.blocksAssignment === true) {
      throw unprocessable('INVALID_STATUS_CODE', 'A working status cannot block assignment');
    }
  },
};

const HolidayBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  name: Name,
});

export const holidaysDef: ResourceDef = {
  name: 'holiday',
  path: '/holidays',
  collection: C.holidays,
  body: HolidayBody,
  item: HolidayBody,
  searchFields: ['name', 'date'],
};
```

`src/modules/master/master.routes.ts` — import `{ holidaysDef, statusCodesDef } from '../availability/status-codes.js'` and append both to `ALL_RESOURCE_DEFS`.

`src/modules/master/fleet.ts` — add to `DriverBody`:
```ts
  weeklyDaysOff: z.array(z.number().int().min(0).max(6)).max(7).default([]),
```

`src/db/indexes.ts` — add:
```ts
  [C.statusCodes]: [{ key: { code: 1 }, unique: true }],
  [C.holidays]: [{ key: { date: 1 }, unique: true }],
```

`src/seed/seed.ts` — add after `BASE_PALLET_MOVEMENT_TYPES`:
```ts
const UNCONFIRMED_WORKING = ['Aล', 'Aส', 'Aซ', 'Aค', 'Aน', 'Aป'];
const UNCONFIRMED_NOT_WORKING = ['ล', 'ป', 'ก', 'ฝ', 'ลพ', 'ลอ', 'ย', 'ลข', 'ลส', 'ปอ', 'จ', 'ลฃ'];

export const BASE_STATUS_CODES = [
  // Planning codes used by resource blocks.
  { code: 'PM', name: 'เข้า PM เช็คระยะ', level1: 'not_working', appliesTo: 'vehicle', blocksAssignment: true },
  { code: 'REPAIR', name: 'ซ่อม', level1: 'not_working', appliesTo: 'vehicle', blocksAssignment: true },
  { code: 'TIRE', name: 'เปลี่ยนยาง', level1: 'not_working', appliesTo: 'vehicle', blocksAssignment: true },
  { code: 'INSPECTION', name: 'ตรวจสภาพ / ต่อภาษี', level1: 'not_working', appliesTo: 'vehicle', blocksAssignment: true },
  { code: 'LEAVE', name: 'ลา', level1: 'not_working', appliesTo: 'driver', blocksAssignment: true },
  { code: 'SICK', name: 'ลาป่วย', level1: 'not_working', appliesTo: 'driver', blocksAssignment: true },
  { code: 'HOLIDAY', name: 'วันหยุด', level1: 'not_working', appliesTo: 'driver', blocksAssignment: true },
  { code: 'TRAINING', name: 'อบรม', level1: 'not_working', appliesTo: 'driver', blocksAssignment: true },
  { code: 'OTHER', name: 'อื่น ๆ', level1: 'not_working', appliesTo: 'both', blocksAssignment: false },
  // ATMS daily status codes (atms.vehicle_daily_asia, field คนขับ): codes starting with A are working.
  { code: 'A', name: 'ทำงานปกติ', level1: 'working', appliesTo: 'both', blocksAssignment: false },
  { code: 'A50', name: 'ทำงาน 4 ชม.', level1: 'working', appliesTo: 'both', blocksAssignment: false },
  { code: 'Aอส', name: 'รถโอนสาย', level1: 'working', appliesTo: 'both', blocksAssignment: false },
  ...UNCONFIRMED_WORKING.map((code) => ({
    code, name: `ATMS ${code} (รอยืนยันความหมาย)`, level1: 'working', appliesTo: 'both', blocksAssignment: false,
  })),
  ...UNCONFIRMED_NOT_WORKING.map((code) => ({
    code, name: `ATMS ${code} (รอยืนยันความหมาย)`, level1: 'not_working', appliesTo: 'both', blocksAssignment: true,
  })),
] as const;
```
and in `seedBase` add the loop:
```ts
  for (const s of BASE_STATUS_CODES) await upsertByCode(db, C.statusCodes, { ...s });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(availability): two-level status-code catalogue, company holidays, driver days off" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 3: Delivery orders (CRUD, auto job-group matching, cancel)

**Files:**
- Create: `src/lib/issues.ts`, `src/lib/active-refs.ts`, `src/modules/orders/order.types.ts`, `src/modules/orders/orders.schemas.ts`, `src/modules/orders/orders.service.ts`, `src/modules/orders/orders.routes.ts`, `test/helpers/planning.ts`
- Modify: `src/routes.ts`, `src/db/indexes.ts`
- Test: `test/api/delivery-orders.test.ts`

**Interfaces:**
- Consumes: `nextNumber(db, 'DO')`, `matchJobGroupForDo(db, clientId, { truckTypeId, serviceTypeId, materialId, originLocationId, destLocationId })`, `writeAudit`, `actorOf`, `paginate`, `toApi`, `seedBase`.
- Produces:
  - `interface Issue { code: string; message: string; details?: unknown }`, `IssueSchema`.
  - `checkActiveRefs(db, checks: RefCheck[]) → Promise<Issue[]>` (`INVALID_REFERENCE` for unknown ids, `INACTIVE_REFERENCE` for `active: false`), `assertActiveRefs(db, checks)` (throws the first as 422). `interface RefCheck { field: string; collection: string; ids: (ObjectId | null | undefined)[] }`.
  - `DO_STATUSES`, `type DoStatus`, `interface DeliveryOrderDoc` (see code).
  - `DoFields` (zod create body), `PatchDoBody`, `DoItem`, `DoWithWarnings`.
  - `prepareDoFields(db, input, existing) → { set, warnings }`; `rematchJobGroup(db, doc, truckTypeId) → { jobGroupId, jobGroupMatch } | null` (null when the DO's match is `manual`); `jobGroupWarnings(doNo, status) → Issue[]`.
  - Routes: `POST /delivery-orders`, `GET /delivery-orders`, `GET /delivery-orders/:id`, `PATCH /delivery-orders/:id`, `POST /delivery-orders/:id/cancel`.
  - Test helpers: `setupPlanning(app) → PlanningFixtures`, `createDo(app, f, overrides?) → DO json`.

- [ ] **Step 1: Write the planning fixtures helper**

`test/helpers/planning.ts`:
```ts
import { ObjectId } from 'mongodb';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { seedBase } from '../../src/seed/seed.js';
import { createUserAndLogin } from './auth.js';

type H = { authorization: string };

export interface PlanningFixtures {
  admin: H;
  planner: H;
  viewer: H;
  driver1: H;
  driver2: H;
  ids: {
    scg: string; cpac: string; zCen: string; zNe: string;
    locA: string; locB: string; locC: string; locD: string;
    bulk: string; bag: string; single: string;
    trailerType: string; mixerType: string;
    h1: string; h2: string; t1: string; t2: string; m1: string;
    d1: string; d2: string; d3: string;
    bulkGroup: string;
  };
}

export async function setupPlanning(app: App): Promise<PlanningFixtures> {
  await seedBase(app.db);
  const admin = (await createUserAndLogin(app, ['admin'])).headers;
  const planner = (await createUserAndLogin(app, ['planner'])).headers;
  const viewer = (await createUserAndLogin(app, ['viewer'])).headers;
  const post = async (url: string, payload: object): Promise<string> => {
    const res = await app.inject({ method: 'POST', url: `/api/v1${url}`, headers: admin, payload });
    if (res.statusCode !== 201) throw new Error(`${url} → ${res.statusCode} ${res.body}`);
    return res.json().id as string;
  };
  const typeId = async (code: string) => ((await app.db.collection(C.truckTypes).findOne({ code }))!._id as ObjectId).toHexString();
  const trailerType = await typeId('TRAILER');
  const mixerType = await typeId('MIXER');
  const scg = await post('/clients', { code: 'SCG', name: 'SCG' });
  const cpac = await post('/clients', { code: 'CPAC', name: 'CPAC' });
  const zCen = await post('/zones', { code: 'CEN', name: 'ภาคกลาง' });
  const zNe = await post('/zones', { code: 'NE', name: 'อีสาน' });
  const locA = await post('/locations', { code: 'A', name: 'Plant A', zoneId: zCen, isSite: true, lat: 14.53, lng: 100.91 });
  const locB = await post('/locations', { code: 'B', name: 'Site B', zoneId: zCen, lat: 13.75, lng: 100.5 });
  const locC = await post('/locations', { code: 'C', name: 'Shop C', zoneId: zNe, lat: 16.43, lng: 102.83 });
  const locD = await post('/locations', { code: 'D', name: 'Shop D', zoneId: zNe, lat: 15.24, lng: 104.85 });
  const bulk = await post('/materials', { code: 'BULK', name: 'ปูนผง', unit: 'ton' });
  const bag = await post('/materials', { code: 'BAG', name: 'ปูนถุง', unit: 'bag' });
  const single = await post('/service-types', { code: 'SINGLE', name: 'ส่งเที่ยวเดียว' });
  const h1 = await post('/vehicles', { plate: '70-1001', part: 'head', truckTypeId: trailerType });
  const h2 = await post('/vehicles', { plate: '70-1002', part: 'head', truckTypeId: trailerType });
  const t1 = await post('/vehicles', { plate: '71-2001', part: 'tail', truckTypeId: trailerType });
  const t2 = await post('/vehicles', { plate: '71-2002', part: 'tail', truckTypeId: trailerType });
  const m1 = await post('/vehicles', { plate: '80-3001', part: 'rigid', truckTypeId: mixerType });
  const d1 = await post('/drivers', { code: 'D1', name: 'Driver One', licenseExpiry: '2030-12-31' });
  const d2 = await post('/drivers', { code: 'D2', name: 'Driver Two', licenseExpiry: '2030-12-31' });
  const d3 = await post('/drivers', { code: 'D3', name: 'Driver Three', licenseExpiry: '2026-10-01', weeklyDaysOff: [0] });
  const driver1 = (await createUserAndLogin(app, ['driver'], { driverId: new ObjectId(d1) })).headers;
  const driver2 = (await createUserAndLogin(app, ['driver'], { driverId: new ObjectId(d2) })).headers;
  const bulkGroup = await post(`/clients/${scg}/job-groups`, {
    code: 'BULK-A', name: 'ปูนผงจาก A', criteria: { materialIds: [bulk], siteIds: [locA] },
  });
  return {
    admin, planner, viewer, driver1, driver2,
    ids: { scg, cpac, zCen, zNe, locA, locB, locC, locD, bulk, bag, single, trailerType, mixerType, h1, h2, t1, t2, m1, d1, d2, d3, bulkGroup },
  };
}

export async function createDo(app: App, f: PlanningFixtures, overrides: object = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/delivery-orders',
    headers: f.planner,
    payload: {
      clientId: f.ids.scg, serviceTypeId: f.ids.single, materialId: f.ids.bulk, qty: 30,
      originLocationId: f.ids.locA, destLocationId: f.ids.locB, ...overrides,
    },
  });
  if (res.statusCode !== 201) throw new Error(`createDo → ${res.statusCode} ${res.body}`);
  return res.json();
}
```

- [ ] **Step 2: Write the failing test**

`test/api/delivery-orders.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { type PlanningFixtures, createDo, setupPlanning } from '../helpers/planning.js';

describe('delivery orders', () => {
  let app: App;
  let f: PlanningFixtures;
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, headers: { authorization: string }, payload?: object) =>
    app.inject({ method, url: `/api/v1${url}`, headers, payload });

  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('creates a DO with a server number, material unit and auto-matched job group', async () => {
    const d = await createDo(app, f, { clientRef: 'SO-123', pickupWindow: { from: '2026-10-05T06:00:00+07:00', to: '2026-10-05T10:00:00+07:00' } });
    expect(d.doNo).toMatch(/^DO-\d{4}-\d{5}$/);
    expect(d).toMatchObject({
      status: 'UNASSIGNED', unit: 'ton', jobGroupId: f.ids.bulkGroup, shipmentId: null, clientRef: 'SO-123',
      jobGroupMatch: { status: 'auto', candidates: [f.ids.bulkGroup] }, warnings: [],
      distance: { clientKm: null },
    });
    expect(d.pickupWindow.from).toBe('2026-10-04T23:00:00.000Z');
    const audit = await app.db.collection(C.auditLog).findOne({ entity: 'deliveryOrder', entityId: d.id });
    expect(audit?.action).toBe('create');
  });

  it('warns when no job group matches', async () => {
    const d = await createDo(app, f, { materialId: f.ids.bag, destLocationId: f.ids.locC });
    expect(d.jobGroupMatch.status).toBe('none');
    expect(d.warnings.map((w: { code: string }) => w.code)).toEqual(['JOB_GROUP_NONE']);
  });

  it('accepts a manual job group of the same client only', async () => {
    const other = await call('POST', `/clients/${f.ids.cpac}/job-groups`, f.admin, { code: 'X', name: 'X', criteria: {} });
    const bad = await call('POST', '/delivery-orders', f.planner, {
      clientId: f.ids.scg, serviceTypeId: f.ids.single, materialId: f.ids.bag, qty: 1,
      originLocationId: f.ids.locA, destLocationId: f.ids.locB, jobGroupId: other.json().id,
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('INVALID_JOB_GROUP');
    const manual = await createDo(app, f, { materialId: f.ids.bag, jobGroupId: f.ids.bulkGroup });
    expect(manual.jobGroupMatch).toEqual({ status: 'manual', candidates: [f.ids.bulkGroup] });
    const patched = await call('PATCH', `/delivery-orders/${manual.id}`, f.planner, { qty: 5 });
    expect(patched.json().jobGroupMatch.status).toBe('manual');
    const reverted = await call('PATCH', `/delivery-orders/${manual.id}`, f.planner, { jobGroupId: null });
    expect(reverted.json().jobGroupMatch.status).toBe('none');
  });

  it('rejects same origin/destination and deactivated references', async () => {
    const same = await call('POST', '/delivery-orders', f.planner, {
      clientId: f.ids.scg, serviceTypeId: f.ids.single, materialId: f.ids.bulk, qty: 1,
      originLocationId: f.ids.locA, destLocationId: f.ids.locA,
    });
    expect(same.json().code).toBe('SAME_ORIGIN_DEST');
    const tmp = await call('POST', '/materials', f.admin, { code: 'TMP', name: 'tmp', unit: 'kg' });
    await call('PATCH', `/materials/${tmp.json().id}`, f.admin, { active: false });
    const inactive = await call('POST', '/delivery-orders', f.planner, {
      clientId: f.ids.scg, serviceTypeId: f.ids.single, materialId: tmp.json().id, qty: 1,
      originLocationId: f.ids.locA, destLocationId: f.ids.locB,
    });
    expect(inactive.statusCode).toBe(422);
    expect(inactive.json().code).toBe('INACTIVE_REFERENCE');
  });

  it('lists with filters, cancels unassigned DOs and then refuses edits', async () => {
    const d = await createDo(app, f, { clientId: f.ids.cpac, materialId: f.ids.bag });
    const list = await call('GET', `/delivery-orders?clientId=${f.ids.cpac}&status=UNASSIGNED`, f.viewer);
    expect(list.json().items.map((x: { id: string }) => x.id)).toContain(d.id);
    const cancelled = await call('POST', `/delivery-orders/${d.id}/cancel`, f.planner, { reason: 'ลูกค้ายกเลิก' });
    expect(cancelled.json()).toMatchObject({ status: 'CANCELLED', cancelReason: 'ลูกค้ายกเลิก' });
    const edit = await call('PATCH', `/delivery-orders/${d.id}`, f.planner, { qty: 2 });
    expect(edit.json().code).toBe('DO_NOT_EDITABLE');
  });

  it('enforces roles', async () => {
    // Body validation runs before the role guard, so send a valid body to reach the 403.
    const valid = { clientId: f.ids.scg, serviceTypeId: f.ids.single, materialId: f.ids.bulk, qty: 1, originLocationId: f.ids.locA, destLocationId: f.ids.locB };
    expect((await call('POST', '/delivery-orders', f.viewer, valid)).statusCode).toBe(403);
    expect((await call('GET', '/delivery-orders', f.driver1)).statusCode).toBe(403);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/api/delivery-orders.test.ts`
Expected: FAIL — `/delivery-orders` 404.

- [ ] **Step 4: Implement shared helpers and types**

`src/lib/issues.ts`:
```ts
import { z } from 'zod';

export interface Issue {
  code: string;
  message: string;
  details?: unknown;
}

export const IssueSchema = z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() });
```

`src/lib/active-refs.ts`:
```ts
import type { Db, ObjectId } from 'mongodb';
import { unprocessable } from './errors.js';
import type { Issue } from './issues.js';

export interface RefCheck {
  field: string;
  collection: string;
  ids: (ObjectId | null | undefined)[];
}

export async function checkActiveRefs(db: Db, checks: RefCheck[]): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const check of checks) {
    const unique = [...new Map(check.ids.filter((i): i is ObjectId => !!i).map((i) => [i.toHexString(), i])).values()];
    if (unique.length === 0) continue;
    const docs = await db.collection(check.collection).find({ _id: { $in: unique } }, { projection: { active: 1 } }).toArray();
    const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
    const missing = unique.map((i) => i.toHexString()).filter((h) => !byId.has(h));
    const inactive = unique.map((i) => i.toHexString()).filter((h) => byId.get(h)?.active === false);
    if (missing.length > 0) {
      issues.push({ code: 'INVALID_REFERENCE', message: `${check.field} references unknown ${check.collection}`, details: { field: check.field, ids: missing } });
    }
    if (inactive.length > 0) {
      issues.push({ code: 'INACTIVE_REFERENCE', message: `${check.field} references deactivated ${check.collection}`, details: { field: check.field, ids: inactive } });
    }
  }
  return issues;
}

export async function assertActiveRefs(db: Db, checks: RefCheck[]): Promise<void> {
  const [first] = await checkActiveRefs(db, checks);
  if (first) throw unprocessable(first.code, first.message, first.details);
}
```

`src/modules/orders/order.types.ts`:
```ts
import type { ObjectId } from 'mongodb';

export const DO_STATUSES = ['UNASSIGNED', 'PLANNED', 'PICKED_UP', 'DELIVERED', 'POD_VERIFIED', 'POD_REJECTED', 'FAILED', 'CANCELLED'] as const;
export type DoStatus = (typeof DO_STATUSES)[number];
export const MATCH_STATUSES = ['auto', 'manual', 'ambiguous', 'none'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export interface TimeWindow {
  from: Date;
  to: Date;
}

export interface DeliveryOrderDoc {
  _id: ObjectId;
  doNo: string;
  clientRef: string | null;
  clientId: ObjectId;
  jobGroupId: ObjectId | null;
  jobGroupMatch: { status: MatchStatus; candidates: ObjectId[] };
  serviceTypeId: ObjectId;
  materialId: ObjectId;
  intendedTruckTypeId: ObjectId | null;
  qty: number;
  unit: string;
  palletPlan: { type: string; qty: number } | null;
  originLocationId: ObjectId;
  destLocationId: ObjectId;
  pickupWindow: TimeWindow | null;
  dropWindow: TimeWindow | null;
  distance: { clientKm: number | null };
  shipmentId: ObjectId | null;
  pickupStopId: ObjectId | null;
  dropStopId: ObjectId | null;
  status: DoStatus;
  note: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
}
```

`src/modules/orders/orders.schemas.ts`:
```ts
import { z } from 'zod';
import { objectIdString } from '../../lib/ids.js';
import { IssueSchema } from '../../lib/issues.js';
import { DO_STATUSES, MATCH_STATUSES } from './order.types.js';

const iso = z.string().datetime({ offset: true });

export const WindowInput = z
  .object({ from: iso, to: iso })
  .refine((w) => Date.parse(w.from) < Date.parse(w.to), { message: 'from must be before to' });

export const DoFields = z.object({
  clientId: objectIdString,
  clientRef: z.string().trim().max(60).nullable().default(null),
  serviceTypeId: objectIdString,
  materialId: objectIdString,
  intendedTruckTypeId: objectIdString.nullable().default(null),
  qty: z.number().positive(),
  unit: z.string().trim().min(1).max(20).nullable().default(null),
  palletPlan: z.object({ type: z.string().trim().min(1).max(40), qty: z.number().int().min(0) }).nullable().default(null),
  originLocationId: objectIdString,
  destLocationId: objectIdString,
  pickupWindow: WindowInput.nullable().default(null),
  dropWindow: WindowInput.nullable().default(null),
  clientKm: z.number().min(0).nullable().default(null),
  jobGroupId: objectIdString.nullable().optional(),
  note: z.string().trim().max(500).nullable().default(null),
});
export type DoInput = z.infer<typeof DoFields>;

export const PatchDoBody = DoFields.partial();
export type DoPatch = z.infer<typeof PatchDoBody>;

const WindowOut = z.object({ from: z.string(), to: z.string() }).nullable();

export const DoItem = z.object({
  id: z.string(),
  doNo: z.string(),
  clientRef: z.string().nullable(),
  clientId: z.string(),
  jobGroupId: z.string().nullable(),
  jobGroupMatch: z.object({ status: z.enum(MATCH_STATUSES), candidates: z.array(z.string()) }),
  serviceTypeId: z.string(),
  materialId: z.string(),
  intendedTruckTypeId: z.string().nullable(),
  qty: z.number(),
  unit: z.string(),
  palletPlan: z.object({ type: z.string(), qty: z.number() }).nullable(),
  originLocationId: z.string(),
  destLocationId: z.string(),
  pickupWindow: WindowOut,
  dropWindow: WindowOut,
  distance: z.object({ clientKm: z.number().nullable() }),
  shipmentId: z.string().nullable(),
  pickupStopId: z.string().nullable(),
  dropStopId: z.string().nullable(),
  status: z.enum(DO_STATUSES),
  note: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});

export const DoWithWarnings = DoItem.extend({ warnings: z.array(IssueSchema) });
```

- [ ] **Step 5: Implement the service**

`src/modules/orders/orders.service.ts`:
```ts
import { ObjectId, type Db } from 'mongodb';
import { C } from '../../db/collections.js';
import { type RefCheck, assertActiveRefs } from '../../lib/active-refs.js';
import { unprocessable } from '../../lib/errors.js';
import type { Issue } from '../../lib/issues.js';
import { matchJobGroupForDo } from '../master/job-groups.js';
import type { DeliveryOrderDoc, MatchStatus, TimeWindow } from './order.types.js';
import type { DoPatch } from './orders.schemas.js';

type JobGroupFields = Pick<DeliveryOrderDoc, 'jobGroupId' | 'jobGroupMatch'>;

const toWindow = (w: { from: string; to: string } | null): TimeWindow | null =>
  w ? { from: new Date(w.from), to: new Date(w.to) } : null;

export function jobGroupWarnings(doNo: string | null, status: MatchStatus): Issue[] {
  const label = doNo ?? 'this delivery order';
  if (status === 'none') return [{ code: 'JOB_GROUP_NONE', message: `No job group matches ${label}`, details: { doNo } }];
  if (status === 'ambiguous') {
    return [{ code: 'JOB_GROUP_AMBIGUOUS', message: `Several job groups match ${label}; choose one`, details: { doNo } }];
  }
  return [];
}

async function autoMatch(db: Db, d: DeliveryOrderDoc, truckTypeId: ObjectId | null): Promise<JobGroupFields> {
  const r = await matchJobGroupForDo(db, d.clientId, {
    truckTypeId,
    serviceTypeId: d.serviceTypeId,
    materialId: d.materialId,
    originLocationId: d.originLocationId,
    destLocationId: d.destLocationId,
  });
  return {
    jobGroupId: r.jobGroupId ? new ObjectId(r.jobGroupId) : null,
    jobGroupMatch: { status: r.status, candidates: r.candidates.map((c) => new ObjectId(c)) },
  };
}

/** Re-runs automatic matching (e.g. once a vehicle is known). Returns null for manual matches. */
export async function rematchJobGroup(db: Db, d: DeliveryOrderDoc, truckTypeId: ObjectId | null): Promise<JobGroupFields | null> {
  if (d.jobGroupMatch.status === 'manual') return null;
  return autoMatch(db, d, truckTypeId);
}

/**
 * Turns a create body (all fields) or a patch body (some fields) into the fields to $set.
 * `existing` is null on create. Throws 422 for rule violations; returns job-group warnings.
 */
export async function prepareDoFields(
  db: Db,
  input: DoPatch,
  existing: DeliveryOrderDoc | null,
): Promise<{ set: Partial<DeliveryOrderDoc>; warnings: Issue[] }> {
  const set: Partial<DeliveryOrderDoc> = {};
  const refChecks: RefCheck[] = [];
  const idField = (key: 'clientId' | 'serviceTypeId' | 'materialId' | 'originLocationId' | 'destLocationId', collection: string) => {
    const v = input[key];
    if (v === undefined) return;
    set[key] = new ObjectId(v);
    refChecks.push({ field: key, collection, ids: [set[key]] });
  };
  idField('clientId', C.clients);
  idField('serviceTypeId', C.serviceTypes);
  idField('materialId', C.materials);
  idField('originLocationId', C.locations);
  idField('destLocationId', C.locations);
  if (input.intendedTruckTypeId !== undefined) {
    set.intendedTruckTypeId = input.intendedTruckTypeId ? new ObjectId(input.intendedTruckTypeId) : null;
    refChecks.push({ field: 'intendedTruckTypeId', collection: C.truckTypes, ids: [set.intendedTruckTypeId] });
  }
  if (input.clientRef !== undefined) set.clientRef = input.clientRef;
  if (input.qty !== undefined) set.qty = input.qty;
  if (input.palletPlan !== undefined) set.palletPlan = input.palletPlan;
  if (input.note !== undefined) set.note = input.note;
  if (input.pickupWindow !== undefined) set.pickupWindow = toWindow(input.pickupWindow);
  if (input.dropWindow !== undefined) set.dropWindow = toWindow(input.dropWindow);
  if (input.clientKm !== undefined) set.distance = { clientKm: input.clientKm };

  const merged = { ...(existing ?? {}), ...set } as DeliveryOrderDoc;
  if (merged.originLocationId.equals(merged.destLocationId)) {
    throw unprocessable('SAME_ORIGIN_DEST', 'Origin and destination must be different locations');
  }
  if (existing?.shipmentId) {
    const locked = (['clientId', 'originLocationId', 'destLocationId'] as const).filter(
      (k) => set[k] !== undefined && !(set[k] as ObjectId).equals(existing[k]),
    );
    if (locked.length > 0) {
      throw unprocessable('DO_LOCKED_BY_SHIPMENT', 'Remove the delivery order from its shipment before changing client or route', { fields: locked });
    }
  }
  await assertActiveRefs(db, refChecks);

  if (input.unit !== undefined && input.unit !== null) set.unit = input.unit;
  else if (!existing) {
    const material = await db.collection(C.materials).findOne({ _id: merged.materialId });
    set.unit = String(material?.unit ?? '');
  }

  let jg: JobGroupFields;
  if (typeof input.jobGroupId === 'string') {
    const jobGroupId = new ObjectId(input.jobGroupId);
    const group = await db.collection(C.jobGroups).findOne({ _id: jobGroupId, clientId: merged.clientId, active: true });
    if (!group) throw unprocessable('INVALID_JOB_GROUP', 'jobGroupId must be an active job group of the same client');
    jg = { jobGroupId, jobGroupMatch: { status: 'manual', candidates: [jobGroupId] } };
  } else if (input.jobGroupId === undefined && existing?.jobGroupMatch.status === 'manual' && existing.clientId.equals(merged.clientId)) {
    jg = { jobGroupId: existing.jobGroupId, jobGroupMatch: existing.jobGroupMatch };
  } else {
    jg = await autoMatch(db, merged, merged.intendedTruckTypeId ?? null);
  }
  Object.assign(set, jg);
  return { set, warnings: jobGroupWarnings(existing?.doNo ?? null, jg.jobGroupMatch.status) };
}
```

- [ ] **Step 6: Implement the routes and wiring**

`src/modules/orders/orders.routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf, writeAudit } from '../../lib/audit.js';
import { nextNumber } from '../../lib/counters.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { IdParams, objectIdString } from '../../lib/ids.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import { DO_STATUSES, type DeliveryOrderDoc } from './order.types.js';
import { DoFields, DoItem, DoWithWarnings, PatchDoBody } from './orders.schemas.js';
import { prepareDoFields } from './orders.service.js';

export const orderRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = app.requireRoles(...STAFF_ROLES);
  const write = app.requireRoles('admin', 'planner');
  const coll = () => app.db.collection<DeliveryOrderDoc>(C.deliveryOrders);
  const load = async (id: string) => {
    const d = await coll().findOne({ _id: new ObjectId(id) });
    if (!d) throw notFound('Delivery order');
    return d;
  };

  app.post('/delivery-orders', { schema: { tags: ['delivery-orders'], body: DoFields, response: { 201: DoWithWarnings } }, preHandler: write }, async (req, reply) => {
    const { set, warnings } = await prepareDoFields(app.db, req.body, null);
    const by = actorOf(req);
    const now = new Date();
    const doNo = await nextNumber(app.db, 'DO');
    const doc = {
      ...set,
      _id: new ObjectId(),
      doNo,
      status: 'UNASSIGNED',
      shipmentId: null,
      pickupStopId: null,
      dropStopId: null,
      cancelledAt: null,
      cancelReason: null,
      createdBy: by,
      createdAt: now,
      updatedBy: by,
      updatedAt: now,
    } as DeliveryOrderDoc;
    await coll().insertOne(doc);
    await writeAudit(app.db, { entity: 'deliveryOrder', entityId: doc._id.toHexString(), action: 'create', by, after: toApi(doc) });
    return reply.status(201).send({ ...toApi(doc), warnings: warnings.map((w) => ({ ...w, details: { doNo } })) });
  });

  app.get(
    '/delivery-orders',
    {
      schema: {
        tags: ['delivery-orders'],
        querystring: PageQuery.extend({
          status: z.enum(DO_STATUSES).optional(),
          clientId: objectIdString.optional(),
          jobGroupId: objectIdString.optional(),
          shipmentId: objectIdString.optional(),
          from: z.string().datetime({ offset: true }).optional(),
          to: z.string().datetime({ offset: true }).optional(),
        }),
        response: { 200: pageResponse(DoItem) },
      },
      preHandler: read,
    },
    async (req) => {
      const q = req.query;
      const f: Filter<DeliveryOrderDoc> = {};
      if (q.status) f.status = q.status;
      if (q.clientId) f.clientId = new ObjectId(q.clientId);
      if (q.jobGroupId) f.jobGroupId = new ObjectId(q.jobGroupId);
      if (q.shipmentId) f.shipmentId = new ObjectId(q.shipmentId);
      if (q.from || q.to) {
        f['pickupWindow.from'] = {
          ...(q.from ? { $gte: new Date(q.from) } : {}),
          ...(q.to ? { $lt: new Date(q.to) } : {}),
        };
      }
      const page = await paginate(coll(), f, q);
      return { items: page.items.map(toApi), nextCursor: page.nextCursor };
    },
  );

  app.get('/delivery-orders/:id', { schema: { tags: ['delivery-orders'], params: IdParams, response: { 200: DoItem } }, preHandler: read }, async (req) =>
    toApi(await load(req.params.id)),
  );

  app.patch(
    '/delivery-orders/:id',
    { schema: { tags: ['delivery-orders'], params: IdParams, body: PatchDoBody, response: { 200: DoWithWarnings } }, preHandler: write },
    async (req) => {
      const existing = await load(req.params.id);
      if (existing.status !== 'UNASSIGNED' && existing.status !== 'PLANNED') {
        throw unprocessable('DO_NOT_EDITABLE', `A ${existing.status} delivery order cannot be edited`);
      }
      const { set, warnings } = await prepareDoFields(app.db, req.body, existing);
      const by = actorOf(req);
      const updated = await coll().findOneAndUpdate(
        { _id: existing._id },
        { $set: { ...set, updatedBy: by, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      if (!updated) throw notFound('Delivery order');
      await writeAudit(app.db, { entity: 'deliveryOrder', entityId: req.params.id, action: 'update', by, before: toApi(existing), after: toApi(updated) });
      return { ...toApi(updated), warnings };
    },
  );

  app.post(
    '/delivery-orders/:id/cancel',
    {
      schema: { tags: ['delivery-orders'], params: IdParams, body: z.object({ reason: z.string().trim().min(3).max(500) }), response: { 200: DoItem } },
      preHandler: write,
    },
    async (req) => {
      const existing = await load(req.params.id);
      if (existing.shipmentId) throw unprocessable('DO_IN_SHIPMENT', 'Remove the delivery order from its shipment first');
      if (existing.status !== 'UNASSIGNED') throw unprocessable('DO_NOT_CANCELLABLE', `A ${existing.status} delivery order cannot be cancelled`);
      const by = actorOf(req);
      const updated = await coll().findOneAndUpdate(
        { _id: existing._id, status: 'UNASSIGNED', shipmentId: null },
        { $set: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: req.body.reason, updatedBy: by, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      if (!updated) throw unprocessable('DO_NOT_CANCELLABLE', 'The delivery order changed; reload and try again');
      await writeAudit(app.db, { entity: 'deliveryOrder', entityId: req.params.id, action: 'cancel', by, after: { reason: req.body.reason } });
      return toApi(updated);
    },
  );
};
```

`src/routes.ts` — import `{ orderRoutes } from './modules/orders/orders.routes.js'` and register `await api.register(orderRoutes);`.

`src/db/indexes.ts` — add:
```ts
  [C.deliveryOrders]: [
    { key: { doNo: 1 }, unique: true },
    { key: { status: 1, clientId: 1 } },
    { key: { shipmentId: 1 } },
    { key: { 'pickupWindow.from': 1 } },
    { key: { clientId: 1, clientRef: 1 } },
  ],
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(orders): delivery orders with auto job-group matching, active-reference checks and cancel" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 4: Bulk delivery-order creation (JSON, dry run, all-or-nothing)

**Files:**
- Create: `src/lib/tx.ts`
- Modify: `src/modules/orders/orders.routes.ts`
- Test: `test/api/delivery-orders-bulk.test.ts`

**Interfaces:**
- Consumes: `prepareDoFields`, `nextNumber`, `writeAudit(db, entry, { session })`, `app.mongo`.
- Produces: `withTransaction<T>(mongo: MongoClient, fn: (session: ClientSession) => Promise<T>): Promise<T>`; `POST /delivery-orders/bulk?dryRun=true|false` (default `true`) with body `{ items: DoFields[] }` (1–500) → `{ dryRun, total, valid, invalid, results: { index, ok, id, doNo, warnings, errors }[] }`; a real run with any invalid item → 422 `BULK_HAS_ERRORS` (details = report), nothing written.

- [ ] **Step 1: Write the failing test**

`test/api/delivery-orders-bulk.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

describe('bulk delivery orders', () => {
  let app: App;
  let f: PlanningFixtures;
  const item = (o: object = {}) => ({
    clientId: f.ids.scg, serviceTypeId: f.ids.single, materialId: f.ids.bulk, qty: 10,
    originLocationId: f.ids.locA, destLocationId: f.ids.locB, ...o,
  });
  const bulk = (items: object[], dryRun: boolean) =>
    app.inject({ method: 'POST', url: `/api/v1/delivery-orders/bulk?dryRun=${dryRun}`, headers: f.planner, payload: { items } });

  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('dry run reports without writing', async () => {
    const res = await bulk([item(), item({ destLocationId: f.ids.locC })], true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dryRun: true, total: 2, valid: 2, invalid: 0 });
    expect(res.json().results[0]).toMatchObject({ index: 0, ok: true, id: null, doNo: null });
    expect(await app.db.collection(C.deliveryOrders).countDocuments()).toBe(0);
  });

  it('rejects the whole batch when any item is invalid', async () => {
    const res = await bulk([item(), item({ destLocationId: f.ids.locA })], false);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('BULK_HAS_ERRORS');
    expect(res.json().details.results[1].errors[0].code).toBe('SAME_ORIGIN_DEST');
    expect(await app.db.collection(C.deliveryOrders).countDocuments()).toBe(0);
  });

  it('creates all items with sequential numbers and one audit entry', async () => {
    const res = await bulk([item({ clientRef: 'R1' }), item({ clientRef: 'R2' }), item({ clientRef: 'R3' })], false);
    expect(res.statusCode).toBe(200);
    const nos = res.json().results.map((r: { doNo: string }) => r.doNo);
    expect(nos).toHaveLength(3);
    const seq = nos.map((n: string) => Number(n.split('-')[2]));
    expect(seq[1]).toBe(seq[0] + 1);
    expect(seq[2]).toBe(seq[0] + 2);
    expect(await app.db.collection(C.deliveryOrders).countDocuments({ status: 'UNASSIGNED' })).toBe(3);
    const audit = await app.db.collection(C.auditLog).findOne({ entity: 'deliveryOrder', action: 'bulk-create' });
    expect(audit?.after.doNos).toEqual(nos);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/delivery-orders-bulk.test.ts`
Expected: FAIL — 404 (the route `/delivery-orders/bulk` does not exist).

- [ ] **Step 3: Implement**

`src/lib/tx.ts`:
```ts
import type { ClientSession, MongoClient } from 'mongodb';

export async function withTransaction<T>(mongo: MongoClient, fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = mongo.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result as T;
  } finally {
    await session.endSession();
  }
}
```

In `src/modules/orders/orders.routes.ts` add imports `import { AppError } from '../../lib/errors.js';`, `import { IssueSchema, type Issue } from '../../lib/issues.js';`, `import { withTransaction } from '../../lib/tx.js';` and, inside `orderRoutes` **before** the `'/delivery-orders/:id'` routes, add:
```ts
  const BulkResult = z.object({
    index: z.number(),
    ok: z.boolean(),
    id: z.string().nullable(),
    doNo: z.string().nullable(),
    warnings: z.array(IssueSchema),
    errors: z.array(IssueSchema),
  });
  const BulkReport = z.object({
    dryRun: z.boolean(),
    total: z.number(),
    valid: z.number(),
    invalid: z.number(),
    results: z.array(BulkResult),
  });

  app.post(
    '/delivery-orders/bulk',
    {
      schema: {
        tags: ['delivery-orders'],
        querystring: z.object({ dryRun: z.enum(['true', 'false']).default('true') }),
        body: z.object({ items: z.array(DoFields).min(1).max(500) }),
        response: { 200: BulkReport },
      },
      preHandler: write,
    },
    async (req) => {
      const dryRun = req.query.dryRun === 'true';
      const prepared: { set: Partial<DeliveryOrderDoc>; warnings: Issue[] }[] = [];
      const results: z.infer<typeof BulkResult>[] = [];
      for (const [index, input] of req.body.items.entries()) {
        try {
          const p = await prepareDoFields(app.db, input, null);
          prepared.push(p);
          results.push({ index, ok: true, id: null, doNo: null, warnings: p.warnings, errors: [] });
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          results.push({ index, ok: false, id: null, doNo: null, warnings: [], errors: [{ code: e.code, message: e.message, details: e.details }] });
        }
      }
      const invalid = results.filter((r) => !r.ok).length;
      const report = { dryRun, total: results.length, valid: results.length - invalid, invalid, results };
      if (dryRun) return report;
      if (invalid > 0) throw unprocessable('BULK_HAS_ERRORS', `${invalid} item(s) have errors; nothing was saved`, report);

      const by = actorOf(req);
      const now = new Date();
      const docs: DeliveryOrderDoc[] = [];
      for (const p of prepared) {
        docs.push({
          ...p.set,
          _id: new ObjectId(),
          doNo: await nextNumber(app.db, 'DO'),
          status: 'UNASSIGNED',
          shipmentId: null,
          pickupStopId: null,
          dropStopId: null,
          cancelledAt: null,
          cancelReason: null,
          createdBy: by,
          createdAt: now,
          updatedBy: by,
          updatedAt: now,
        } as DeliveryOrderDoc);
      }
      await withTransaction(app.mongo, async (session) => {
        await coll().insertMany(docs, { session });
        await writeAudit(
          app.db,
          { entity: 'deliveryOrder', entityId: 'bulk', action: 'bulk-create', by, after: { doNos: docs.map((d) => d.doNo) } },
          { session },
        );
      });
      docs.forEach((d, i) => {
        results[i]!.id = d._id.toHexString();
        results[i]!.doNo = d.doNo;
      });
      return report;
    },
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(orders): bulk delivery-order creation with dry run and transactional apply" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 5: Shipment domain (pure functions) and Bangkok time helpers

**Files:**
- Create: `src/lib/time.ts`, `src/modules/shipments/shipment.types.ts`, `src/modules/shipments/shipment.domain.ts`
- Test: `test/unit/time.test.ts`, `test/unit/shipment-domain.test.ts`

**Interfaces:**
- Produces:
  - `bangkokDate(d: Date): string` (`YYYY-MM-DD`), `bangkokDatesBetween(from: Date, to: Date): string[]` (every Bangkok date touched by the half-open range), `bangkokWeekday(date: string): number` (0 = Sunday), `overlaps(aFrom, aTo, bFrom, bTo): boolean` (half-open).
  - `SHIPMENT_STATUSES`, `type ShipmentStatus`, `RESERVING_STATUSES` (all except CANCELLED, CLOSED), `EDITABLE_STATUSES` (DRAFT, PLANNED, DISPATCHED, ACCEPTED), `interface Slot`, `interface StopDoc`, `interface LegDoc`, `interface ShipmentDoc`.
  - `interface DoRoute { id: string; originLocationId: string; destLocationId: string }`, `interface StopPlan { locationId: string; pickupDoIds: string[]; dropDoIds: string[] }`, `interface LegPlan { fromIndex: number; toIndex: number; doIds: string[]; loaded: boolean }`.
  - `buildStopsFromDos(dos: DoRoute[]): StopPlan[]`, `deriveLegs(stops: StopPlan[]): LegPlan[]`, `structuralIssues(stops: StopPlan[], dos: DoRoute[]): { errors: Issue[]; warnings: Issue[] }`.

- [ ] **Step 1: Write the failing tests**

`test/unit/time.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { bangkokDate, bangkokDatesBetween, bangkokWeekday, overlaps } from '../../src/lib/time.js';

describe('Bangkok time helpers', () => {
  it('formats Bangkok calendar dates', () => {
    expect(bangkokDate(new Date('2026-10-04T16:59:59Z'))).toBe('2026-10-04');
    expect(bangkokDate(new Date('2026-10-04T17:00:00Z'))).toBe('2026-10-05');
  });

  it('lists every date a range touches (half-open)', () => {
    // 22:00 Sat 3 Oct → 02:00 Sun 4 Oct Bangkok
    expect(bangkokDatesBetween(new Date('2026-10-03T15:00:00Z'), new Date('2026-10-03T19:00:00Z'))).toEqual(['2026-10-03', '2026-10-04']);
    // ends exactly at midnight Bangkok → does not touch the next date
    expect(bangkokDatesBetween(new Date('2026-10-03T01:00:00Z'), new Date('2026-10-03T17:00:00Z'))).toEqual(['2026-10-03']);
  });

  it('computes weekdays of Bangkok dates', () => {
    expect(bangkokWeekday('2026-10-04')).toBe(0); // Sunday
    expect(bangkokWeekday('2026-10-05')).toBe(1);
  });

  it('checks half-open overlap', () => {
    const d = (h: number) => new Date(Date.UTC(2026, 9, 5, h));
    expect(overlaps(d(1), d(3), d(2), d(4))).toBe(true);
    expect(overlaps(d(1), d(2), d(2), d(3))).toBe(false);
  });
});
```

`test/unit/shipment-domain.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildStopsFromDos, deriveLegs, structuralIssues } from '../../src/modules/shipments/shipment.domain.js';

const r = (id: string, o: string, d: string) => ({ id, originLocationId: o, destLocationId: d });

describe('buildStopsFromDos', () => {
  it('chains sequential legs A→B, B→C, C→D', () => {
    const stops = buildStopsFromDos([r('1', 'A', 'B'), r('2', 'B', 'C'), r('3', 'C', 'D')]);
    expect(stops.map((s) => s.locationId)).toEqual(['A', 'B', 'C', 'D']);
    expect(stops[1]).toEqual({ locationId: 'B', pickupDoIds: ['2'], dropDoIds: ['1'] });
  });

  it('co-loads DOs with the same origin', () => {
    const stops = buildStopsFromDos([r('1', 'A', 'B'), r('2', 'A', 'C')]);
    expect(stops.map((s) => s.locationId)).toEqual(['A', 'B', 'C']);
    expect(stops[0]!.pickupDoIds).toEqual(['1', '2']);
  });

  it('handles a return leg to the start', () => {
    expect(buildStopsFromDos([r('1', 'A', 'B'), r('2', 'B', 'A')]).map((s) => s.locationId)).toEqual(['A', 'B', 'A']);
  });
});

describe('deriveLegs', () => {
  it('tracks what is on board and marks empty legs', () => {
    const legs = deriveLegs([
      { locationId: 'A', pickupDoIds: ['1', '2'], dropDoIds: [] },
      { locationId: 'B', pickupDoIds: [], dropDoIds: ['1'] },
      { locationId: 'C', pickupDoIds: [], dropDoIds: ['2'] },
      { locationId: 'D', pickupDoIds: ['3'], dropDoIds: [] },
      { locationId: 'E', pickupDoIds: [], dropDoIds: ['3'] },
    ]);
    expect(legs.map((l) => [l.doIds, l.loaded])).toEqual([
      [['1', '2'], true],
      [['2'], true],
      [[], false],
      [['3'], true],
    ]);
  });
});

describe('structuralIssues', () => {
  it('accepts a valid route', () => {
    const dos = [r('1', 'A', 'B')];
    const out = structuralIssues(buildStopsFromDos(dos), dos);
    expect(out).toEqual({ errors: [], warnings: [] });
  });

  it('flags drop before pickup, wrong locations, missing and duplicated DOs', () => {
    const dos = [r('1', 'A', 'B'), r('2', 'A', 'C'), r('3', 'C', 'D')];
    const { errors } = structuralIssues(
      [
        { locationId: 'B', pickupDoIds: [], dropDoIds: ['1'] },
        { locationId: 'A', pickupDoIds: ['1', '2'], dropDoIds: [] },
        { locationId: 'D', pickupDoIds: [], dropDoIds: ['2', '3'] },
        { locationId: 'D', pickupDoIds: [], dropDoIds: ['3'] },
      ],
      dos,
    );
    const codes = errors.map((e) => e.code).sort();
    expect(codes).toEqual(['DO_DUPLICATED', 'DO_PICKUP_MISSING', 'DROP_BEFORE_PICKUP', 'DROP_LOCATION_MISMATCH']);
  });

  it('warns about two consecutive stops at the same place', () => {
    const dos = [r('1', 'A', 'B')];
    const { warnings } = structuralIssues(
      [
        { locationId: 'A', pickupDoIds: ['1'], dropDoIds: [] },
        { locationId: 'A', pickupDoIds: [], dropDoIds: [] },
        { locationId: 'B', pickupDoIds: [], dropDoIds: ['1'] },
      ],
      dos,
    );
    expect(warnings.map((w) => w.code)).toEqual(['ADJACENT_SAME_LOCATION']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/time.test.ts test/unit/shipment-domain.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement time helpers**

`src/lib/time.ts`:
```ts
const bkkDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' });

export function bangkokDate(d: Date): string {
  return bkkDay.format(d);
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Every Bangkok calendar date touched by the half-open range [from, to). */
export function bangkokDatesBetween(from: Date, to: Date): string[] {
  if (to.getTime() <= from.getTime()) return [];
  const last = bangkokDate(new Date(to.getTime() - 1));
  const out: string[] = [];
  for (let d = bangkokDate(from); d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 0 = Sunday … 6 = Saturday, for a Bangkok calendar date `YYYY-MM-DD`. */
export function bangkokWeekday(date: string): number {
  return new Date(`${date}T12:00:00+07:00`).getUTCDay();
}

/** Half-open overlap of [aFrom, aTo) and [bFrom, bTo). */
export function overlaps(aFrom: Date, aTo: Date, bFrom: Date, bTo: Date): boolean {
  return aFrom.getTime() < bTo.getTime() && bFrom.getTime() < aTo.getTime();
}
```

- [ ] **Step 4: Implement shipment types and domain**

`src/modules/shipments/shipment.types.ts`:
```ts
import type { ObjectId } from 'mongodb';
import type { Issue } from '../../lib/issues.js';

export const SHIPMENT_STATUSES = ['DRAFT', 'PLANNED', 'DISPATCHED', 'ACCEPTED', 'IN_TRANSIT', 'COMPLETED', 'CLOSED', 'CANCELLED'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];
/** Shipments that hold their vehicles and drivers (spec §4: every non-cancelled, non-closed shipment). */
export const RESERVING_STATUSES: ShipmentStatus[] = ['DRAFT', 'PLANNED', 'DISPATCHED', 'ACCEPTED', 'IN_TRANSIT', 'COMPLETED'];
export const EDITABLE_STATUSES: ShipmentStatus[] = ['DRAFT', 'PLANNED', 'DISPATCHED', 'ACCEPTED'];

export interface Slot {
  vehicleId: ObjectId;
  driverId: ObjectId | null;
}

export interface StopDoc {
  stopId: ObjectId;
  seq: number;
  locationId: ObjectId;
  pickupDoIds: ObjectId[];
  dropDoIds: ObjectId[];
  plannedArrival: Date | null;
  status: 'PENDING';
}

export interface LegDoc {
  fromStopId: ObjectId;
  toStopId: ObjectId;
  loaded: boolean;
  doIds: ObjectId[];
  mapKm: number | null;
  gpsKm: number | null;
}

export interface ShipmentDoc {
  _id: ObjectId;
  shipmentNo: string;
  status: ShipmentStatus;
  version: number;
  plannedStart: Date;
  plannedEnd: Date;
  head: Slot | null;
  tail: Slot | null;
  stops: StopDoc[];
  legs: LegDoc[];
  warnings: Issue[];
  note: string | null;
  dispatch: { at: Date; by: string; version: number } | null;
  driverResponse: { status: 'ACCEPTED' | 'DECLINED'; reason: string | null; at: Date; by: string } | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
}
```

`src/modules/shipments/shipment.domain.ts`:
```ts
import type { Issue } from '../../lib/issues.js';

export interface DoRoute {
  id: string;
  originLocationId: string;
  destLocationId: string;
}

export interface StopPlan {
  locationId: string;
  pickupDoIds: string[];
  dropDoIds: string[];
}

export interface LegPlan {
  fromIndex: number;
  toIndex: number;
  doIds: string[];
  loaded: boolean;
}

/**
 * Builds stops in DO order: a pickup joins the earliest existing stop at its origin; the drop
 * joins the first stop at its destination after that pickup; otherwise a stop is appended.
 * Gives the natural route for chains (A→B, B→C) and co-loading (A→B, A→C). Milk runs
 * (several pickups before one drop) should be sent as explicit stops.
 */
export function buildStopsFromDos(dos: DoRoute[]): StopPlan[] {
  const stops: StopPlan[] = [];
  for (const d of dos) {
    let p = stops.findIndex((s) => s.locationId === d.originLocationId);
    if (p === -1) {
      stops.push({ locationId: d.originLocationId, pickupDoIds: [], dropDoIds: [] });
      p = stops.length - 1;
    }
    stops[p]!.pickupDoIds.push(d.id);
    let q = stops.findIndex((s, i) => i > p && s.locationId === d.destLocationId);
    if (q === -1) {
      stops.push({ locationId: d.destLocationId, pickupDoIds: [], dropDoIds: [] });
      q = stops.length - 1;
    }
    stops[q]!.dropDoIds.push(d.id);
  }
  return stops;
}

/** Legs between consecutive stops; at each stop drops happen before pickups. */
export function deriveLegs(stops: StopPlan[]): LegPlan[] {
  const onboard = new Set<string>();
  const legs: LegPlan[] = [];
  stops.forEach((s, i) => {
    for (const id of s.dropDoIds) onboard.delete(id);
    for (const id of s.pickupDoIds) onboard.add(id);
    if (i < stops.length - 1) legs.push({ fromIndex: i, toIndex: i + 1, doIds: [...onboard], loaded: onboard.size > 0 });
  });
  return legs;
}

function indexMap(stops: StopPlan[], key: 'pickupDoIds' | 'dropDoIds'): Map<string, number[]> {
  const m = new Map<string, number[]>();
  stops.forEach((s, i) => {
    for (const id of s[key]) m.set(id, [...(m.get(id) ?? []), i]);
  });
  return m;
}

export function structuralIssues(stops: StopPlan[], dos: DoRoute[]): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const picks = indexMap(stops, 'pickupDoIds');
  const drops = indexMap(stops, 'dropDoIds');
  for (const d of dos) {
    const p = picks.get(d.id) ?? [];
    const q = drops.get(d.id) ?? [];
    const details = { doId: d.id };
    if (p.length === 0) errors.push({ code: 'DO_PICKUP_MISSING', message: 'Delivery order has no pickup stop', details });
    if (q.length === 0) errors.push({ code: 'DO_DROP_MISSING', message: 'Delivery order has no drop stop', details });
    if (p.length > 1 || q.length > 1) errors.push({ code: 'DO_DUPLICATED', message: 'Delivery order is picked up or dropped more than once', details });
    if (p.length === 1 && q.length === 1) {
      const [pi] = p as [number];
      const [qi] = q as [number];
      if (qi <= pi) errors.push({ code: 'DROP_BEFORE_PICKUP', message: 'Delivery order is dropped before it is picked up', details: { ...details, pickupStop: pi, dropStop: qi } });
      if (stops[pi]!.locationId !== d.originLocationId) {
        errors.push({ code: 'PICKUP_LOCATION_MISMATCH', message: 'Pickup stop is not at the delivery order origin', details: { ...details, stop: pi } });
      }
      if (stops[qi]!.locationId !== d.destLocationId) {
        errors.push({ code: 'DROP_LOCATION_MISMATCH', message: 'Drop stop is not at the delivery order destination', details: { ...details, stop: qi } });
      }
    }
  }
  stops.forEach((s, i) => {
    if (i > 0 && stops[i - 1]!.locationId === s.locationId) {
      warnings.push({ code: 'ADJACENT_SAME_LOCATION', message: 'Two consecutive stops are at the same location', details: { stop: i } });
    }
  });
  return { errors, warnings };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(shipments): pure stop building, leg derivation, structural rules and Bangkok date helpers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 6: Resource blocks (unavailability periods)

**Files:**
- Create: `src/modules/shipments/shipment.queries.ts`, `src/modules/availability/blocks.service.ts`, `src/modules/availability/blocks.routes.ts`
- Modify: `src/routes.ts`, `src/db/indexes.ts`
- Test: `test/api/resource-blocks.test.ts`

**Interfaces:**
- Consumes: `RESERVING_STATUSES`, `ShipmentDoc`, `checkActiveRefs`/`assertActiveRefs`, `IssueSchema`, `Level1`, `AppliesTo`.
- Produces:
  - `findShipmentsUsing(db, resourceType: 'vehicle' | 'driver', resourceId: ObjectId, from: Date, to: Date, excludeShipmentId?: ObjectId): Promise<Pick<ShipmentDoc, '_id' | 'shipmentNo' | 'status' | 'plannedStart' | 'plannedEnd'>[]>`.
  - `interface BlockDoc`, `RESOURCE_TYPES = ['vehicle','driver']`, `findActiveBlocks(db, resources: { type: ResourceType; id: ObjectId }[], from: Date, to: Date): Promise<BlockDoc[]>` (non-cancelled blocks overlapping the range).
  - Routes: `POST /resource-blocks`, `GET /resource-blocks`, `PATCH /resource-blocks/:id`, `POST /resource-blocks/:id/cancel`. Create/patch responses carry `warnings` with `SHIPMENT_CONFLICT` for every reserving shipment of that resource overlapping the block. Errors: 422 `INVALID_RANGE`, `STATUS_CODE_NOT_APPLICABLE`, `BLOCK_CANCELLED`, plus `INVALID_REFERENCE` / `INACTIVE_REFERENCE`.

- [ ] **Step 1: Write the failing test**

`test/api/resource-blocks.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/resource-blocks.test.ts`
Expected: FAIL — module / route not found.

- [ ] **Step 3: Implement queries and service**

`src/modules/shipments/shipment.queries.ts`:
```ts
import type { Db, Filter, ObjectId } from 'mongodb';
import { C } from '../../db/collections.js';
import { RESERVING_STATUSES, type ShipmentDoc } from './shipment.types.js';

export type ShipmentRef = Pick<ShipmentDoc, '_id' | 'shipmentNo' | 'status' | 'plannedStart' | 'plannedEnd'>;

export async function findShipmentsUsing(
  db: Db,
  resourceType: 'vehicle' | 'driver',
  resourceId: ObjectId,
  from: Date,
  to: Date,
  excludeShipmentId?: ObjectId,
): Promise<ShipmentRef[]> {
  const field = resourceType === 'vehicle' ? 'vehicleId' : 'driverId';
  const filter: Filter<ShipmentDoc> = {
    status: { $in: RESERVING_STATUSES },
    plannedStart: { $lt: to },
    plannedEnd: { $gt: from },
    $or: [{ [`head.${field}`]: resourceId }, { [`tail.${field}`]: resourceId }],
  };
  if (excludeShipmentId) filter._id = { $ne: excludeShipmentId };
  return db
    .collection<ShipmentDoc>(C.shipments)
    .find(filter, { projection: { shipmentNo: 1, status: 1, plannedStart: 1, plannedEnd: 1 } })
    .sort({ plannedStart: 1 })
    .toArray();
}
```

`src/modules/availability/blocks.service.ts`:
```ts
import { ObjectId, type Db } from 'mongodb';
import { C } from '../../db/collections.js';
import { assertActiveRefs } from '../../lib/active-refs.js';
import { unprocessable } from '../../lib/errors.js';
import type { Issue } from '../../lib/issues.js';
import { findShipmentsUsing } from '../shipments/shipment.queries.js';
import type { AppliesTo, Level1 } from './status-codes.js';

export const RESOURCE_TYPES = ['vehicle', 'driver'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export interface BlockDoc {
  _id: ObjectId;
  resourceType: ResourceType;
  resourceId: ObjectId;
  statusCode: string;
  level1: Level1;
  blocksAssignment: boolean;
  from: Date;
  to: Date;
  note: string | null;
  source: 'manual' | 'atms';
  cancelledAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
}

export async function findActiveBlocks(db: Db, resources: { type: ResourceType; id: ObjectId }[], from: Date, to: Date): Promise<BlockDoc[]> {
  if (resources.length === 0) return [];
  return db
    .collection<BlockDoc>(C.resourceBlocks)
    .find({
      cancelledAt: null,
      from: { $lt: to },
      to: { $gt: from },
      $or: resources.map((r) => ({ resourceType: r.type, resourceId: r.id })),
    })
    .sort({ from: 1 })
    .toArray();
}

/** Validates a block's fields (merged with an existing block on PATCH) and returns catalogue-derived fields + warnings. */
export async function prepareBlock(
  db: Db,
  b: { resourceType: ResourceType; resourceId: ObjectId; statusCode: string; from: Date; to: Date },
): Promise<{ level1: Level1; blocksAssignment: boolean; warnings: Issue[] }> {
  if (b.to.getTime() <= b.from.getTime()) throw unprocessable('INVALID_RANGE', '`to` must be after `from`');
  await assertActiveRefs(db, [{ field: 'resourceId', collection: b.resourceType === 'vehicle' ? C.vehicles : C.drivers, ids: [b.resourceId] }]);
  const code = await db.collection(C.statusCodes).findOne({ code: b.statusCode, active: true });
  if (!code) throw unprocessable('INVALID_REFERENCE', `Unknown status code ${b.statusCode}`, { field: 'statusCode' });
  const applies = code.appliesTo as AppliesTo;
  if (applies !== 'both' && applies !== b.resourceType) {
    throw unprocessable('STATUS_CODE_NOT_APPLICABLE', `Status code ${b.statusCode} does not apply to a ${b.resourceType}`);
  }
  const using = await findShipmentsUsing(db, b.resourceType, b.resourceId, b.from, b.to);
  const warnings: Issue[] = using.map((s) => ({
    code: 'SHIPMENT_CONFLICT',
    message: `Shipment ${s.shipmentNo} already uses this ${b.resourceType} in this period`,
    details: { shipmentId: s._id.toHexString(), shipmentNo: s.shipmentNo },
  }));
  return { level1: code.level1 as Level1, blocksAssignment: code.blocksAssignment === true, warnings };
}
```

- [ ] **Step 4: Implement routes and wiring**

`src/modules/availability/blocks.routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf, writeAudit } from '../../lib/audit.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { IdParams, objectIdString } from '../../lib/ids.js';
import { IssueSchema } from '../../lib/issues.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import { type BlockDoc, RESOURCE_TYPES, prepareBlock } from './blocks.service.js';
import { LEVEL1 } from './status-codes.js';

const iso = z.string().datetime({ offset: true });

const BlockItem = z.object({
  id: z.string(),
  resourceType: z.enum(RESOURCE_TYPES),
  resourceId: z.string(),
  statusCode: z.string(),
  level1: z.enum(LEVEL1),
  blocksAssignment: z.boolean(),
  from: z.string(),
  to: z.string(),
  note: z.string().nullable(),
  source: z.enum(['manual', 'atms']),
  cancelledAt: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
const BlockWithWarnings = BlockItem.extend({ warnings: z.array(IssueSchema) });

export const blockRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = app.requireRoles(...STAFF_ROLES);
  const write = app.requireRoles('admin', 'planner');
  const coll = () => app.db.collection<BlockDoc>(C.resourceBlocks);
  const load = async (id: string) => {
    const b = await coll().findOne({ _id: new ObjectId(id) });
    if (!b) throw notFound('Resource block');
    return b;
  };

  app.post(
    '/resource-blocks',
    {
      schema: {
        tags: ['availability'],
        body: z.object({
          resourceType: z.enum(RESOURCE_TYPES),
          resourceId: objectIdString,
          statusCode: z.string().trim().min(1).max(20),
          from: iso,
          to: iso,
          note: z.string().trim().max(500).nullable().default(null),
        }),
        response: { 201: BlockWithWarnings },
      },
      preHandler: write,
    },
    async (req, reply) => {
      const b = { ...req.body, resourceId: new ObjectId(req.body.resourceId), from: new Date(req.body.from), to: new Date(req.body.to) };
      const { level1, blocksAssignment, warnings } = await prepareBlock(app.db, b);
      const by = actorOf(req);
      const now = new Date();
      const doc: BlockDoc = {
        _id: new ObjectId(), ...b, level1, blocksAssignment, source: 'manual', cancelledAt: null,
        createdBy: by, createdAt: now, updatedBy: by, updatedAt: now,
      };
      await coll().insertOne(doc);
      await writeAudit(app.db, { entity: 'resourceBlock', entityId: doc._id.toHexString(), action: 'create', by, after: toApi(doc) });
      return reply.status(201).send({ ...toApi(doc), warnings });
    },
  );

  app.get(
    '/resource-blocks',
    {
      schema: {
        tags: ['availability'],
        querystring: PageQuery.extend({
          resourceType: z.enum(RESOURCE_TYPES).optional(),
          resourceId: objectIdString.optional(),
          from: iso.optional(),
          to: iso.optional(),
          includeCancelled: z.enum(['true', 'false']).default('false'),
        }),
        response: { 200: pageResponse(BlockItem) },
      },
      preHandler: read,
    },
    async (req) => {
      const q = req.query;
      const f: Filter<BlockDoc> = {};
      if (q.resourceType) f.resourceType = q.resourceType;
      if (q.resourceId) f.resourceId = new ObjectId(q.resourceId);
      if (q.includeCancelled !== 'true') f.cancelledAt = null;
      if (q.to) f.from = { $lt: new Date(q.to) };
      if (q.from) f.to = { $gt: new Date(q.from) };
      const page = await paginate(coll(), f, q);
      return { items: page.items.map(toApi), nextCursor: page.nextCursor };
    },
  );

  app.patch(
    '/resource-blocks/:id',
    {
      schema: {
        tags: ['availability'],
        params: IdParams,
        body: z.object({
          statusCode: z.string().trim().min(1).max(20).optional(),
          from: iso.optional(),
          to: iso.optional(),
          note: z.string().trim().max(500).nullable().optional(),
        }),
        response: { 200: BlockWithWarnings },
      },
      preHandler: write,
    },
    async (req) => {
      const existing = await load(req.params.id);
      if (existing.cancelledAt) throw unprocessable('BLOCK_CANCELLED', 'A cancelled block cannot be changed');
      const merged = {
        resourceType: existing.resourceType,
        resourceId: existing.resourceId,
        statusCode: req.body.statusCode ?? existing.statusCode,
        from: req.body.from ? new Date(req.body.from) : existing.from,
        to: req.body.to ? new Date(req.body.to) : existing.to,
      };
      const { level1, blocksAssignment, warnings } = await prepareBlock(app.db, merged);
      const by = actorOf(req);
      const set: Partial<BlockDoc> = { ...merged, level1, blocksAssignment, updatedBy: by, updatedAt: new Date() };
      if (req.body.note !== undefined) set.note = req.body.note;
      const updated = await coll().findOneAndUpdate({ _id: existing._id, cancelledAt: null }, { $set: set }, { returnDocument: 'after' });
      if (!updated) throw unprocessable('BLOCK_CANCELLED', 'A cancelled block cannot be changed');
      await writeAudit(app.db, { entity: 'resourceBlock', entityId: req.params.id, action: 'update', by, before: toApi(existing), after: toApi(updated) });
      return { ...toApi(updated), warnings };
    },
  );

  app.post('/resource-blocks/:id/cancel', { schema: { tags: ['availability'], params: IdParams, response: { 200: BlockItem } }, preHandler: write }, async (req) => {
    const existing = await load(req.params.id);
    if (existing.cancelledAt) throw unprocessable('BLOCK_CANCELLED', 'The block is already cancelled');
    const by = actorOf(req);
    const updated = await coll().findOneAndUpdate(
      { _id: existing._id, cancelledAt: null },
      { $set: { cancelledAt: new Date(), updatedBy: by, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!updated) throw unprocessable('BLOCK_CANCELLED', 'The block is already cancelled');
    await writeAudit(app.db, { entity: 'resourceBlock', entityId: req.params.id, action: 'cancel', by });
    return toApi(updated);
  });
};
```

`src/routes.ts` — import `{ blockRoutes } from './modules/availability/blocks.routes.js'` and register it.

`src/db/indexes.ts` — add:
```ts
  [C.resourceBlocks]: [
    { key: { resourceType: 1, resourceId: 1, from: 1, to: 1 } },
    { key: { cancelledAt: 1, from: 1 } },
  ],
  [C.shipments]: [
    { key: { shipmentNo: 1 }, unique: true },
    { key: { status: 1, plannedStart: 1 } },
    { key: { 'head.vehicleId': 1, plannedStart: 1 } },
    { key: { 'tail.vehicleId': 1, plannedStart: 1 } },
    { key: { 'head.driverId': 1, plannedStart: 1 } },
    { key: { 'tail.driverId': 1, plannedStart: 1 } },
  ],
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(availability): resource blocks with catalogue-derived status levels and shipment-conflict warnings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 7: Shipment validation (`POST /shipments/validate`)

**Files:**
- Create: `src/modules/shipments/shipment.schemas.ts`, `src/modules/shipments/shipment.validation.ts`, `src/modules/shipments/shipments.routes.ts`
- Modify: `src/routes.ts`, `test/helpers/planning.ts`
- Test: `test/api/shipment-validate.test.ts`

**Interfaces:**
- Consumes: domain functions (Task 5), `findShipmentsUsing`, `findActiveBlocks`, `checkActiveRefs`, time helpers, `DeliveryOrderDoc`.
- Produces:
  - `ShipmentInput` (zod): `{ plannedStart, plannedEnd, head?: { vehicleId, driverId? } | null, tail?: … | null, stops?: { locationId, plannedArrival?, pickupDoIds?, dropDoIds? }[], doIds?: string[], note? }`; `type ShipmentInputT`.
  - `interface ShipmentDraft { plannedStart: Date; plannedEnd: Date; head: DraftSlot | null; tail: DraftSlot | null; stops: DraftStop[]; note: string | null }` with `DraftSlot { vehicleId: string; driverId: string | null }`, `DraftStop extends StopPlan { plannedArrival: Date | null }`.
  - `toDraft(db, input): Promise<ShipmentDraft>` — when `stops` is absent and `doIds` given, stops are auto-built.
  - `validateShipment(db, draft, opts: { shipmentId?: ObjectId; mode: 'draft' | 'planned' }): Promise<ValidationResult>` where `ValidationResult = { errors: Issue[]; warnings: Issue[]; dos: DeliveryOrderDoc[]; headVehicle: VehicleLite | null; legs: LegPlan[] }` and `VehicleLite = { _id: ObjectId; plate: string; part: string; truckTypeId: ObjectId }`.
  - Route `POST /shipments/validate` (admin, planner): body `ShipmentInput.extend({ shipmentId?, mode = 'planned' })` → `{ errors, warnings, stops, legs }` (always 200).
  - Error codes: `INVALID_RANGE`, `INVALID_REFERENCE`, `INACTIVE_REFERENCE`, `VEHICLE_WRONG_SLOT`, `RIGID_WITH_TAIL`, `TAIL_WITHOUT_HEAD`, `VEHICLE_DOUBLE_BOOKED`, `DRIVER_DOUBLE_BOOKED`, `RESOURCE_BLOCKED`, `DO_IN_OTHER_SHIPMENT`, `DO_NOT_AVAILABLE`, structural codes. Completeness codes (error in `planned`, warning in `draft`): `HEAD_REQUIRED`, `HEAD_DRIVER_REQUIRED`, `TAIL_REQUIRED`, `TAIL_DRIVER_REQUIRED`, `STOPS_REQUIRED`, `DOS_REQUIRED`. Warnings: `DRIVER_MISMATCH`, `LICENSE_EXPIRES`, `DRIVER_DAY_OFF`, `COMPANY_HOLIDAY`, `RESOURCE_BLOCK_OTHER`, `DO_WINDOW`, `JOB_GROUP_NONE`, `JOB_GROUP_AMBIGUOUS`, `ADJACENT_SAME_LOCATION`.
  - Test helper `validate(app, f, payload)`.

- [ ] **Step 1: Add the test helper**

Append to `test/helpers/planning.ts`:
```ts
export async function validate(app: App, f: PlanningFixtures, payload: object) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/shipments/validate', headers: f.planner, payload });
  if (res.statusCode !== 200) throw new Error(`validate → ${res.statusCode} ${res.body}`);
  return res.json() as { errors: { code: string; details?: unknown }[]; warnings: { code: string; details?: unknown }[]; stops: unknown[]; legs: { doIds: string[]; loaded: boolean }[] };
}

export const codes = (issues: { code: string }[]) => issues.map((i) => i.code).sort();
```

- [ ] **Step 2: Write the failing test**

`test/api/shipment-validate.test.ts`:
```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/api/shipment-validate.test.ts`
Expected: FAIL — `/shipments/validate` 404.

- [ ] **Step 4: Implement schemas**

`src/modules/shipments/shipment.schemas.ts`:
```ts
import { z } from 'zod';
import { objectIdString } from '../../lib/ids.js';
import { IssueSchema } from '../../lib/issues.js';
import { SHIPMENT_STATUSES } from './shipment.types.js';

const iso = z.string().datetime({ offset: true });

const SlotInput = z.object({ vehicleId: objectIdString, driverId: objectIdString.nullable().default(null) });
const StopInput = z.object({
  locationId: objectIdString,
  plannedArrival: iso.nullable().default(null),
  pickupDoIds: z.array(objectIdString).default([]),
  dropDoIds: z.array(objectIdString).default([]),
});

export const ShipmentInput = z.object({
  plannedStart: iso,
  plannedEnd: iso,
  head: SlotInput.nullable().default(null),
  tail: SlotInput.nullable().default(null),
  stops: z.array(StopInput).max(50).optional(),
  doIds: z.array(objectIdString).max(50).optional(),
  note: z.string().trim().max(500).nullable().default(null),
});
export type ShipmentInputT = z.infer<typeof ShipmentInput>;

export const ValidateBody = ShipmentInput.extend({
  shipmentId: objectIdString.optional(),
  mode: z.enum(['draft', 'planned']).default('planned'),
});

export const StopPlanOut = z.object({
  locationId: z.string(),
  plannedArrival: z.string().nullable(),
  pickupDoIds: z.array(z.string()),
  dropDoIds: z.array(z.string()),
});
export const LegPlanOut = z.object({ fromIndex: z.number(), toIndex: z.number(), doIds: z.array(z.string()), loaded: z.boolean() });

export const ValidateResponse = z.object({
  errors: z.array(IssueSchema),
  warnings: z.array(IssueSchema),
  stops: z.array(StopPlanOut),
  legs: z.array(LegPlanOut),
});

const SlotOut = z.object({ vehicleId: z.string(), driverId: z.string().nullable() }).nullable();

export const ShipmentItem = z.object({
  id: z.string(),
  shipmentNo: z.string(),
  status: z.enum(SHIPMENT_STATUSES),
  version: z.number(),
  plannedStart: z.string(),
  plannedEnd: z.string(),
  head: SlotOut,
  tail: SlotOut,
  stops: z.array(
    z.object({
      stopId: z.string(),
      seq: z.number(),
      locationId: z.string(),
      pickupDoIds: z.array(z.string()),
      dropDoIds: z.array(z.string()),
      plannedArrival: z.string().nullable(),
      status: z.string(),
    }),
  ),
  legs: z.array(
    z.object({
      fromStopId: z.string(),
      toStopId: z.string(),
      loaded: z.boolean(),
      doIds: z.array(z.string()),
      mapKm: z.number().nullable(),
      gpsKm: z.number().nullable(),
    }),
  ),
  warnings: z.array(IssueSchema),
  note: z.string().nullable(),
  dispatch: z.object({ at: z.string(), by: z.string(), version: z.number() }).nullable(),
  driverResponse: z.object({ status: z.enum(['ACCEPTED', 'DECLINED']), reason: z.string().nullable(), at: z.string(), by: z.string() }).nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
```

- [ ] **Step 5: Implement validation**

`src/modules/shipments/shipment.validation.ts`:
```ts
import { ObjectId, type Db } from 'mongodb';
import { C } from '../../db/collections.js';
import { checkActiveRefs } from '../../lib/active-refs.js';
import type { Issue } from '../../lib/issues.js';
import { bangkokDate, bangkokDatesBetween, bangkokWeekday } from '../../lib/time.js';
import { type ResourceType, findActiveBlocks } from '../availability/blocks.service.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import { jobGroupWarnings } from '../orders/orders.service.js';
import { type LegPlan, type StopPlan, buildStopsFromDos, deriveLegs, structuralIssues } from './shipment.domain.js';
import { findShipmentsUsing } from './shipment.queries.js';
import type { ShipmentInputT } from './shipment.schemas.js';

export interface DraftSlot {
  vehicleId: string;
  driverId: string | null;
}

export interface DraftStop extends StopPlan {
  plannedArrival: Date | null;
}

export interface ShipmentDraft {
  plannedStart: Date;
  plannedEnd: Date;
  head: DraftSlot | null;
  tail: DraftSlot | null;
  stops: DraftStop[];
  note: string | null;
}

export interface VehicleLite {
  _id: ObjectId;
  plate: string;
  part: string;
  truckTypeId: ObjectId;
}

export interface ValidationResult {
  errors: Issue[];
  warnings: Issue[];
  dos: DeliveryOrderDoc[];
  headVehicle: VehicleLite | null;
  legs: LegPlan[];
}

export async function toDraft(db: Db, input: ShipmentInputT): Promise<ShipmentDraft> {
  let stops: DraftStop[] = [];
  if (input.stops) {
    stops = input.stops.map((s) => ({
      locationId: s.locationId,
      plannedArrival: s.plannedArrival ? new Date(s.plannedArrival) : null,
      pickupDoIds: s.pickupDoIds,
      dropDoIds: s.dropDoIds,
    }));
  } else if (input.doIds && input.doIds.length > 0) {
    const dos = await db
      .collection<DeliveryOrderDoc>(C.deliveryOrders)
      .find({ _id: { $in: input.doIds.map((i) => new ObjectId(i)) } }, { projection: { originLocationId: 1, destLocationId: 1 } })
      .toArray();
    const byId = new Map(dos.map((d) => [d._id.toHexString(), d]));
    const routes = input.doIds
      .filter((id) => byId.has(id))
      .map((id) => ({ id, originLocationId: byId.get(id)!.originLocationId.toHexString(), destLocationId: byId.get(id)!.destLocationId.toHexString() }));
    const missing = input.doIds.filter((id) => !byId.has(id));
    stops = buildStopsFromDos(routes).map((s) => ({ ...s, plannedArrival: null }));
    // Unknown ids are kept on the first stop so validation reports them.
    if (missing.length > 0 && stops[0]) stops[0].pickupDoIds.push(...missing);
    else if (missing.length > 0) stops = [{ locationId: '000000000000000000000000', pickupDoIds: missing, dropDoIds: [], plannedArrival: null }];
  }
  return {
    plannedStart: new Date(input.plannedStart),
    plannedEnd: new Date(input.plannedEnd),
    head: input.head,
    tail: input.tail,
    stops,
    note: input.note,
  };
}

const oid = (h: string) => new ObjectId(h);

export async function validateShipment(
  db: Db,
  draft: ShipmentDraft,
  opts: { shipmentId?: ObjectId; mode: 'draft' | 'planned' },
): Promise<ValidationResult> {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const completeness = (i: Issue) => (opts.mode === 'planned' ? errors : warnings).push(i);
  const selfId = opts.shipmentId?.toHexString() ?? null;
  const rangeOk = draft.plannedEnd.getTime() > draft.plannedStart.getTime();
  if (!rangeOk) errors.push({ code: 'INVALID_RANGE', message: 'plannedEnd must be after plannedStart' });

  const vehicleIds = [draft.head?.vehicleId, draft.tail?.vehicleId].filter((v): v is string => !!v);
  const driverIds = [...new Set([draft.head?.driverId, draft.tail?.driverId].filter((v): v is string => !!v))];
  const locationIds = [...new Set(draft.stops.map((s) => s.locationId))];
  errors.push(
    ...(await checkActiveRefs(db, [
      { field: 'vehicles', collection: C.vehicles, ids: vehicleIds.map(oid) },
      { field: 'drivers', collection: C.drivers, ids: driverIds.map(oid) },
      { field: 'stops.locationId', collection: C.locations, ids: locationIds.map(oid) },
    ])),
  );

  const vehicles = await db.collection<VehicleLite>(C.vehicles).find({ _id: { $in: vehicleIds.map(oid) } }).toArray();
  const vmap = new Map(vehicles.map((v) => [v._id.toHexString(), v]));
  const headV = draft.head ? (vmap.get(draft.head.vehicleId) ?? null) : null;
  const tailV = draft.tail ? (vmap.get(draft.tail.vehicleId) ?? null) : null;

  if (!draft.head) completeness({ code: 'HEAD_REQUIRED', message: 'A head (or rigid) vehicle is required' });
  else {
    if (headV && headV.part !== 'head' && headV.part !== 'rigid') {
      errors.push({ code: 'VEHICLE_WRONG_SLOT', message: `${headV.plate} cannot be used as the head`, details: { slot: 'head', plate: headV.plate } });
    }
    if (!draft.head.driverId) completeness({ code: 'HEAD_DRIVER_REQUIRED', message: 'The head vehicle needs a driver' });
  }
  if (draft.tail) {
    if (!draft.head) errors.push({ code: 'TAIL_WITHOUT_HEAD', message: 'A tail needs a head vehicle' });
    if (tailV && tailV.part !== 'tail') {
      errors.push({ code: 'VEHICLE_WRONG_SLOT', message: `${tailV.plate} cannot be used as the tail`, details: { slot: 'tail', plate: tailV.plate } });
    }
    if (headV?.part === 'rigid') errors.push({ code: 'RIGID_WITH_TAIL', message: 'A rigid truck cannot pull a tail' });
    if (!draft.tail.driverId) completeness({ code: 'TAIL_DRIVER_REQUIRED', message: 'The tail needs a driver' });
  } else if (headV?.part === 'head') {
    completeness({ code: 'TAIL_REQUIRED', message: 'A tractor head needs a tail' });
  }
  if (draft.head?.driverId && draft.tail?.driverId && draft.head.driverId !== draft.tail.driverId) {
    warnings.push({ code: 'DRIVER_MISMATCH', message: 'Head and tail have different drivers' });
  }

  const doIds = [...new Set(draft.stops.flatMap((s) => [...s.pickupDoIds, ...s.dropDoIds]))];
  const dos = await db.collection<DeliveryOrderDoc>(C.deliveryOrders).find({ _id: { $in: doIds.map(oid) } }).toArray();
  const doMap = new Map(dos.map((d) => [d._id.toHexString(), d]));
  const unknownDos = doIds.filter((id) => !doMap.has(id));
  if (unknownDos.length > 0) {
    errors.push({ code: 'INVALID_REFERENCE', message: 'Unknown delivery orders', details: { field: 'deliveryOrders', ids: unknownDos } });
  }
  for (const d of dos) {
    const inOther = d.shipmentId && d.shipmentId.toHexString() !== selfId;
    if (inOther) {
      errors.push({ code: 'DO_IN_OTHER_SHIPMENT', message: `${d.doNo} is already in another shipment`, details: { doNo: d.doNo } });
    } else if (!(d.status === 'UNASSIGNED' || (d.status === 'PLANNED' && d.shipmentId?.toHexString() === selfId))) {
      errors.push({ code: 'DO_NOT_AVAILABLE', message: `${d.doNo} is ${d.status}`, details: { doNo: d.doNo, status: d.status } });
    }
    warnings.push(...jobGroupWarnings(d.doNo, d.jobGroupMatch.status));
  }
  if (doIds.length === 0) completeness({ code: 'DOS_REQUIRED', message: 'Add at least one delivery order' });
  if (draft.stops.length < 2) completeness({ code: 'STOPS_REQUIRED', message: 'A shipment needs at least two stops' });

  const structural = structuralIssues(
    draft.stops,
    dos.map((d) => ({ id: d._id.toHexString(), originLocationId: d.originLocationId.toHexString(), destLocationId: d.destLocationId.toHexString() })),
  );
  errors.push(...structural.errors);
  warnings.push(...structural.warnings);

  draft.stops.forEach((s, i) => {
    if (!s.plannedArrival) return;
    const check = (ids: string[], kind: 'pickup' | 'drop') => {
      for (const id of ids) {
        const w = kind === 'pickup' ? doMap.get(id)?.pickupWindow : doMap.get(id)?.dropWindow;
        if (w && (s.plannedArrival! < w.from || s.plannedArrival! > w.to)) {
          warnings.push({ code: 'DO_WINDOW', message: `Stop ${i + 1} is outside the ${kind} window of ${doMap.get(id)!.doNo}`, details: { doNo: doMap.get(id)!.doNo, kind, stop: i } });
        }
      }
    };
    check(s.pickupDoIds, 'pickup');
    check(s.dropDoIds, 'drop');
  });

  if (rangeOk) {
    const { plannedStart: from, plannedEnd: to } = draft;
    for (const v of vehicles) {
      const using = await findShipmentsUsing(db, 'vehicle', v._id, from, to, opts.shipmentId);
      if (using.length > 0) {
        errors.push({ code: 'VEHICLE_DOUBLE_BOOKED', message: `${v.plate} is already booked`, details: { plate: v.plate, shipmentNos: using.map((s) => s.shipmentNo) } });
      }
    }
    for (const id of driverIds) {
      const using = await findShipmentsUsing(db, 'driver', oid(id), from, to, opts.shipmentId);
      if (using.length > 0) {
        errors.push({ code: 'DRIVER_DOUBLE_BOOKED', message: 'The driver is already booked', details: { driverId: id, shipmentNos: using.map((s) => s.shipmentNo) } });
      }
    }
    const resources: { type: ResourceType; id: ObjectId }[] = [
      ...vehicles.map((v) => ({ type: 'vehicle' as const, id: v._id })),
      ...driverIds.map((id) => ({ type: 'driver' as const, id: oid(id) })),
    ];
    for (const b of await findActiveBlocks(db, resources, from, to)) {
      const details = { resourceType: b.resourceType, resourceId: b.resourceId.toHexString(), statusCode: b.statusCode, from: b.from.toISOString(), to: b.to.toISOString() };
      if (b.blocksAssignment) errors.push({ code: 'RESOURCE_BLOCKED', message: `The ${b.resourceType} is unavailable (${b.statusCode})`, details });
      else warnings.push({ code: 'RESOURCE_BLOCK_OTHER', message: `The ${b.resourceType} has a ${b.statusCode} note in this period`, details });
    }
    const dates = bangkokDatesBetween(from, to);
    const drivers = await db.collection(C.drivers).find({ _id: { $in: driverIds.map(oid) } }).toArray();
    const endDate = bangkokDate(to);
    for (const d of drivers) {
      if (typeof d.licenseExpiry === 'string' && d.licenseExpiry < endDate) {
        warnings.push({ code: 'LICENSE_EXPIRES', message: `Driver ${d.code}'s licence expires before the shipment ends`, details: { driverCode: d.code, licenseExpiry: d.licenseExpiry } });
      }
      const off = (d.weeklyDaysOff as number[] | undefined) ?? [];
      const offDates = dates.filter((date) => off.includes(bangkokWeekday(date)));
      if (offDates.length > 0) {
        warnings.push({ code: 'DRIVER_DAY_OFF', message: `Driver ${d.code} is normally off on ${offDates.join(', ')}`, details: { driverCode: d.code, dates: offDates } });
      }
    }
    const holidays = await db.collection(C.holidays).find({ date: { $in: dates }, active: true }).toArray();
    for (const h of holidays) warnings.push({ code: 'COMPANY_HOLIDAY', message: `${h.date} is a company holiday (${h.name})`, details: { date: h.date, name: h.name } });
  }

  return { errors, warnings, dos, headVehicle: headV, legs: deriveLegs(draft.stops) };
}
```

- [ ] **Step 6: Implement the route and wiring**

`src/modules/shipments/shipments.routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { ValidateBody, ValidateResponse } from './shipment.schemas.js';
import { toDraft, validateShipment } from './shipment.validation.js';

export const shipmentRoutes: FastifyPluginAsyncZod = async (app) => {
  const write = app.requireRoles('admin', 'planner');

  app.post('/shipments/validate', { schema: { tags: ['shipments'], body: ValidateBody, response: { 200: ValidateResponse } }, preHandler: write }, async (req) => {
    const { shipmentId, mode, ...input } = req.body;
    const draft = await toDraft(app.db, input);
    const result = await validateShipment(app.db, draft, { shipmentId: shipmentId ? new ObjectId(shipmentId) : undefined, mode });
    return {
      errors: result.errors,
      warnings: result.warnings,
      stops: draft.stops.map((s) => ({ ...s, plannedArrival: s.plannedArrival?.toISOString() ?? null })),
      legs: result.legs,
    };
  });
};
```

`src/routes.ts` — import `{ shipmentRoutes } from './modules/shipments/shipments.routes.js'` and register it.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(shipments): full planning-rule validation with draft/planned modes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 8: Create, read and list shipments (transactional DO linking)

**Files:**
- Create: `src/modules/shipments/shipment.service.ts`
- Modify: `src/modules/shipments/shipments.routes.ts`, `test/helpers/planning.ts`
- Test: `test/api/shipments-create.test.ts`

**Interfaces:**
- Consumes: `toDraft`, `validateShipment`, `withTransaction`, `nextNumber(db, 'SH')`, `rematchJobGroup`, `jobGroupWarnings`, `writeAudit(…, { session })`, `DoItem`, `ShipmentItem`.
- Produces:
  - `buildStopDocs(stops: DraftStop[], keep?: StopDoc[]): StopDoc[]` (reuses `keep` stop ids when locations and DO lists are unchanged), `buildLegDocs(stops: StopDoc[]): LegDoc[]`.
  - `linkDos(db, shipment: ShipmentDoc, previousDoIds: ObjectId[], session): Promise<void>` — throws 409 `DO_TAKEN` if a DO was taken by another shipment concurrently.
  - `refreshJobGroups(db, shipment, headVehicle, session): Promise<Issue[]>` — re-matches non-manual DOs with the head vehicle's truck type and returns the fresh `JOB_GROUP_*` warnings.
  - `createShipment(app, input: ShipmentInputT, by: string): Promise<{ doc: ShipmentDoc; warnings: Issue[] }>` (throws 422 `SHIPMENT_INVALID` with `details: { errors, warnings }`).
  - `shipmentView(doc) → ShipmentItem shape`.
  - Routes: `POST /shipments` (201, `ShipmentItem + warnings`), `GET /shipments` (filters `status`, `from`, `to`, `vehicleId`, `driverId`, `truckTypeId`), `GET /shipments/:id` (`ShipmentItem + deliveryOrders: DoItem[]`).
  - Test helper `postShipment(app, f, payload) → response`.

- [ ] **Step 1: Add the test helper**

Append to `test/helpers/planning.ts`:
```ts
export async function postShipment(app: App, f: PlanningFixtures, payload: object) {
  return app.inject({ method: 'POST', url: '/api/v1/shipments', headers: f.planner, payload });
}
```

- [ ] **Step 2: Write the failing test**

`test/api/shipments-create.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { type PlanningFixtures, createDo, postShipment, setupPlanning } from '../helpers/planning.js';

describe('create and read shipments', () => {
  let app: App;
  let f: PlanningFixtures;
  const day = (d: number, h: number) => `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00+07:00`;
  const rig = () => ({ head: { vehicleId: f.ids.h1, driverId: f.ids.d1 }, tail: { vehicleId: f.ids.t1, driverId: f.ids.d1 } });

  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('creates a DRAFT shipment and moves its DOs out of the pool', async () => {
    const d1 = await createDo(app, f);
    const d2 = await createDo(app, f, { destLocationId: f.ids.locC });
    const res = await postShipment(app, f, { plannedStart: day(5, 6), plannedEnd: day(5, 18), ...rig(), doIds: [d1.id, d2.id] });
    expect(res.statusCode).toBe(201);
    const sh = res.json();
    expect(sh).toMatchObject({ status: 'DRAFT', version: 1 });
    expect(sh.shipmentNo).toMatch(/^SH-\d{4}-\d{5}$/);
    expect(sh.stops.map((s: { locationId: string }) => s.locationId)).toEqual([f.ids.locA, f.ids.locB, f.ids.locC]);
    expect(sh.legs.map((l: { doIds: string[] }) => l.doIds.length)).toEqual([2, 1]);
    const stored = await app.db.collection(C.deliveryOrders).findOne({ doNo: d1.doNo });
    expect(stored).toMatchObject({ status: 'PLANNED' });
    expect(stored?.shipmentId.toHexString()).toBe(sh.id);
    expect(stored?.pickupStopId.toHexString()).toBe(sh.stops[0].stopId);
    expect(stored?.dropStopId.toHexString()).toBe(sh.stops[1].stopId);
    const read = await app.inject({ method: 'GET', url: `/api/v1/shipments/${sh.id}`, headers: f.viewer });
    expect(read.json().deliveryOrders.map((d: { doNo: string }) => d.doNo).sort()).toEqual([d1.doNo, d2.doNo].sort());
    expect(await app.db.collection(C.auditLog).countDocuments({ entity: 'shipment', entityId: sh.id, action: 'create' })).toBe(1);
  });

  it('refuses a DO that is already in another shipment and double-booked vehicles', async () => {
    const d = await createDo(app, f);
    expect((await postShipment(app, f, { plannedStart: day(6, 6), plannedEnd: day(6, 18), ...rig(), doIds: [d.id] })).statusCode).toBe(201);
    const again = await postShipment(app, f, { plannedStart: day(7, 6), plannedEnd: day(7, 18), head: { vehicleId: f.ids.m1, driverId: f.ids.d2 }, doIds: [d.id] });
    expect(again.statusCode).toBe(422);
    expect(again.json().code).toBe('SHIPMENT_INVALID');
    expect(again.json().details.errors.map((e: { code: string }) => e.code)).toContain('DO_IN_OTHER_SHIPMENT');
    const other = await createDo(app, f);
    const clash = await postShipment(app, f, { plannedStart: day(6, 12), plannedEnd: day(6, 20), ...rig(), doIds: [other.id] });
    const clashCodes = clash.json().details.errors.map((e: { code: string }) => e.code);
    expect(clashCodes).toEqual(expect.arrayContaining(['VEHICLE_DOUBLE_BOOKED', 'DRIVER_DOUBLE_BOOKED']));
    const later = await postShipment(app, f, { plannedStart: day(6, 18), plannedEnd: day(6, 22), ...rig(), doIds: [other.id] });
    expect(later.statusCode).toBe(201);
  });

  it('lets exactly one of two simultaneous shipments take the same DO', async () => {
    const d = await createDo(app, f);
    const [a, b] = await Promise.all([
      postShipment(app, f, { plannedStart: day(9, 6), plannedEnd: day(9, 18), head: { vehicleId: f.ids.m1, driverId: f.ids.d2 }, doIds: [d.id] }),
      postShipment(app, f, { plannedStart: day(9, 6), plannedEnd: day(9, 18), head: { vehicleId: f.ids.h2, driverId: f.ids.d3 }, tail: { vehicleId: f.ids.t2, driverId: f.ids.d3 }, doIds: [d.id] }),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses[0]).toBe(201);
    expect([409, 422]).toContain(statuses[1]);
    expect(await app.db.collection(C.shipments).countDocuments({ 'stops.pickupDoIds': (await app.db.collection(C.deliveryOrders).findOne({ doNo: d.doNo }))!._id })).toBe(1);
  });

  it('re-matches job groups with the assigned truck type', async () => {
    const g = await app.inject({
      method: 'POST', url: `/api/v1/clients/${f.ids.cpac}/job-groups`, headers: f.admin,
      payload: { code: 'MIX', name: 'Mixer jobs', criteria: { truckTypeIds: [f.ids.mixerType] } },
    });
    const d = await createDo(app, f, { clientId: f.ids.cpac, materialId: f.ids.bag });
    expect(d.jobGroupMatch.status).toBe('none');
    const sh = await postShipment(app, f, { plannedStart: day(12, 6), plannedEnd: day(12, 18), head: { vehicleId: f.ids.m1, driverId: f.ids.d2 }, doIds: [d.id] });
    expect(sh.statusCode).toBe(201);
    expect(sh.json().warnings.map((w: { code: string }) => w.code)).not.toContain('JOB_GROUP_NONE');
    const stored = await app.db.collection(C.deliveryOrders).findOne({ doNo: d.doNo });
    expect(stored?.jobGroupId.toHexString()).toBe(g.json().id);
  });

  it('lists shipments with filters', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/v1/shipments?vehicleId=${f.ids.h1}&status=DRAFT`, headers: f.viewer });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBeGreaterThanOrEqual(2);
    const byType = await app.inject({ method: 'GET', url: `/api/v1/shipments?truckTypeId=${f.ids.mixerType}`, headers: f.viewer });
    expect(byType.json().items.every((s: { head: { vehicleId: string } }) => s.head.vehicleId === f.ids.m1)).toBe(true);
    const ranged = await app.inject({ method: 'GET', url: `/api/v1/shipments?from=${encodeURIComponent(day(12, 0))}&to=${encodeURIComponent(day(13, 0))}`, headers: f.viewer });
    expect(ranged.json().items).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/api/shipments-create.test.ts`
Expected: FAIL — `POST /shipments` 404.

- [ ] **Step 4: Implement the service**

`src/modules/shipments/shipment.service.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { ObjectId, type ClientSession, type Db } from 'mongodb';
import { C } from '../../db/collections.js';
import { writeAudit } from '../../lib/audit.js';
import { nextNumber } from '../../lib/counters.js';
import { conflict, unprocessable } from '../../lib/errors.js';
import type { Issue } from '../../lib/issues.js';
import { toApi } from '../../lib/serialize.js';
import { withTransaction } from '../../lib/tx.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import { jobGroupWarnings, rematchJobGroup } from '../orders/orders.service.js';
import type { ShipmentInputT } from './shipment.schemas.js';
import type { LegDoc, ShipmentDoc, StopDoc } from './shipment.types.js';
import { type DraftStop, type VehicleLite, toDraft, validateShipment } from './shipment.validation.js';

const oid = (h: string) => new ObjectId(h);
const sameIds = (a: ObjectId[], b: string[]) => a.length === b.length && a.every((x, i) => x.toHexString() === b[i]);

export function buildStopDocs(stops: DraftStop[], keep: StopDoc[] = []): StopDoc[] {
  return stops.map((s, i) => {
    const old = keep[i];
    const unchanged =
      old && old.locationId.toHexString() === s.locationId && sameIds(old.pickupDoIds, s.pickupDoIds) && sameIds(old.dropDoIds, s.dropDoIds);
    return {
      stopId: unchanged ? old.stopId : new ObjectId(),
      seq: i + 1,
      locationId: oid(s.locationId),
      pickupDoIds: s.pickupDoIds.map(oid),
      dropDoIds: s.dropDoIds.map(oid),
      plannedArrival: s.plannedArrival,
      status: 'PENDING',
    };
  });
}

export function buildLegDocs(stops: StopDoc[]): LegDoc[] {
  const onboard = new Map<string, ObjectId>();
  const legs: LegDoc[] = [];
  stops.forEach((s, i) => {
    for (const id of s.dropDoIds) onboard.delete(id.toHexString());
    for (const id of s.pickupDoIds) onboard.set(id.toHexString(), id);
    const next = stops[i + 1];
    if (next) legs.push({ fromStopId: s.stopId, toStopId: next.stopId, loaded: onboard.size > 0, doIds: [...onboard.values()], mapKm: null, gpsKm: null });
  });
  return legs;
}

export function doIdsOf(stops: StopDoc[]): ObjectId[] {
  const m = new Map<string, ObjectId>();
  for (const s of stops) for (const id of [...s.pickupDoIds, ...s.dropDoIds]) m.set(id.toHexString(), id);
  return [...m.values()];
}

export async function linkDos(db: Db, shipment: ShipmentDoc, previousDoIds: ObjectId[], session: ClientSession): Promise<void> {
  const coll = db.collection<DeliveryOrderDoc>(C.deliveryOrders);
  const now = new Date();
  const stopsOf = new Map<string, { pickupStopId: ObjectId | null; dropStopId: ObjectId | null; id: ObjectId }>();
  for (const s of shipment.stops) {
    for (const id of s.pickupDoIds) stopsOf.set(id.toHexString(), { ...(stopsOf.get(id.toHexString()) ?? { dropStopId: null, id }), pickupStopId: s.stopId });
    for (const id of s.dropDoIds) stopsOf.set(id.toHexString(), { ...(stopsOf.get(id.toHexString()) ?? { pickupStopId: null, id }), dropStopId: s.stopId });
  }
  const removed = previousDoIds.filter((id) => !stopsOf.has(id.toHexString()));
  if (removed.length > 0) {
    await coll.updateMany(
      { _id: { $in: removed }, shipmentId: shipment._id },
      { $set: { status: 'UNASSIGNED', shipmentId: null, pickupStopId: null, dropStopId: null, updatedAt: now } },
      { session },
    );
  }
  for (const link of stopsOf.values()) {
    const res = await coll.updateOne(
      { _id: link.id, $or: [{ shipmentId: null, status: 'UNASSIGNED' }, { shipmentId: shipment._id }] },
      { $set: { status: 'PLANNED', shipmentId: shipment._id, pickupStopId: link.pickupStopId, dropStopId: link.dropStopId, updatedAt: now } },
      { session },
    );
    if (res.matchedCount === 0) throw conflict('DO_TAKEN', 'A delivery order was taken by another shipment; reload and try again', { doId: link.id.toHexString() });
  }
}

export async function releaseDos(db: Db, shipmentId: ObjectId, session: ClientSession): Promise<void> {
  await db.collection<DeliveryOrderDoc>(C.deliveryOrders).updateMany(
    { shipmentId },
    { $set: { status: 'UNASSIGNED', shipmentId: null, pickupStopId: null, dropStopId: null, updatedAt: new Date() } },
    { session },
  );
}

export async function refreshJobGroups(db: Db, shipment: ShipmentDoc, headVehicle: VehicleLite | null, session: ClientSession): Promise<Issue[]> {
  const coll = db.collection<DeliveryOrderDoc>(C.deliveryOrders);
  const dos = await coll.find({ _id: { $in: doIdsOf(shipment.stops) } }, { session }).toArray();
  const warnings: Issue[] = [];
  for (const d of dos) {
    const next = await rematchJobGroup(db, d, headVehicle?.truckTypeId ?? null);
    const status = next ? next.jobGroupMatch.status : d.jobGroupMatch.status;
    if (next) await coll.updateOne({ _id: d._id }, { $set: next }, { session });
    warnings.push(...jobGroupWarnings(d.doNo, status));
  }
  return warnings;
}

export const withoutJobGroupWarnings = (ws: Issue[]) => ws.filter((w) => !w.code.startsWith('JOB_GROUP_'));

export function invalid(errors: Issue[], warnings: Issue[]) {
  return unprocessable('SHIPMENT_INVALID', 'The shipment breaks planning rules', { errors, warnings });
}

export async function createShipment(app: FastifyInstance, input: ShipmentInputT, by: string): Promise<{ doc: ShipmentDoc; warnings: Issue[] }> {
  const draft = await toDraft(app.db, input);
  const result = await validateShipment(app.db, draft, { mode: 'draft' });
  if (result.errors.length > 0) throw invalid(result.errors, result.warnings);
  const now = new Date();
  const stops = buildStopDocs(draft.stops);
  const doc: ShipmentDoc = {
    _id: new ObjectId(),
    shipmentNo: await nextNumber(app.db, 'SH'),
    status: 'DRAFT',
    version: 1,
    plannedStart: draft.plannedStart,
    plannedEnd: draft.plannedEnd,
    head: draft.head ? { vehicleId: oid(draft.head.vehicleId), driverId: draft.head.driverId ? oid(draft.head.driverId) : null } : null,
    tail: draft.tail ? { vehicleId: oid(draft.tail.vehicleId), driverId: draft.tail.driverId ? oid(draft.tail.driverId) : null } : null,
    stops,
    legs: buildLegDocs(stops),
    warnings: [],
    note: draft.note,
    dispatch: null,
    driverResponse: null,
    cancelledAt: null,
    cancelReason: null,
    createdBy: by,
    createdAt: now,
    updatedBy: by,
    updatedAt: now,
  };
  const warnings = await withTransaction(app.mongo, async (session) => {
    const coll = app.db.collection<ShipmentDoc>(C.shipments);
    await coll.insertOne(doc, { session });
    await linkDos(app.db, doc, [], session);
    const fresh = [...withoutJobGroupWarnings(result.warnings), ...(await refreshJobGroups(app.db, doc, result.headVehicle, session))];
    await coll.updateOne({ _id: doc._id }, { $set: { warnings: fresh } }, { session });
    doc.warnings = fresh;
    await writeAudit(app.db, { entity: 'shipment', entityId: doc._id.toHexString(), action: 'create', by, after: toApi(doc) }, { session });
    return fresh;
  });
  return { doc, warnings };
}

export function shipmentView(doc: ShipmentDoc) {
  return toApi(doc);
}
```

- [ ] **Step 5: Implement the routes**

Extend `src/modules/shipments/shipments.routes.ts` (keep the validate route). Final file:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { IdParams, objectIdString } from '../../lib/ids.js';
import { IssueSchema } from '../../lib/issues.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import { DoItem } from '../orders/orders.schemas.js';
import { ShipmentInput, ShipmentItem, ValidateBody, ValidateResponse } from './shipment.schemas.js';
import { createShipment, doIdsOf, shipmentView } from './shipment.service.js';
import { SHIPMENT_STATUSES, type ShipmentDoc } from './shipment.types.js';
import { toDraft, validateShipment } from './shipment.validation.js';

export const ShipmentWithWarnings = ShipmentItem.extend({ warnings: z.array(IssueSchema) });

export const shipmentRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = app.requireRoles(...STAFF_ROLES);
  const write = app.requireRoles('admin', 'planner');
  const coll = () => app.db.collection<ShipmentDoc>(C.shipments);

  app.post('/shipments/validate', { schema: { tags: ['shipments'], body: ValidateBody, response: { 200: ValidateResponse } }, preHandler: write }, async (req) => {
    const { shipmentId, mode, ...input } = req.body;
    const draft = await toDraft(app.db, input);
    const result = await validateShipment(app.db, draft, { shipmentId: shipmentId ? new ObjectId(shipmentId) : undefined, mode });
    return {
      errors: result.errors,
      warnings: result.warnings,
      stops: draft.stops.map((s) => ({ ...s, plannedArrival: s.plannedArrival?.toISOString() ?? null })),
      legs: result.legs,
    };
  });

  app.post('/shipments', { schema: { tags: ['shipments'], body: ShipmentInput, response: { 201: ShipmentWithWarnings } }, preHandler: write }, async (req, reply) => {
    const { doc } = await createShipment(app, req.body, actorOf(req));
    return reply.status(201).send(shipmentView(doc));
  });

  app.get(
    '/shipments',
    {
      schema: {
        tags: ['shipments'],
        querystring: PageQuery.extend({
          status: z.enum(SHIPMENT_STATUSES).optional(),
          from: z.string().datetime({ offset: true }).optional(),
          to: z.string().datetime({ offset: true }).optional(),
          vehicleId: objectIdString.optional(),
          driverId: objectIdString.optional(),
          truckTypeId: objectIdString.optional(),
        }),
        response: { 200: pageResponse(ShipmentItem) },
      },
      preHandler: read,
    },
    async (req) => {
      const q = req.query;
      const and: Filter<ShipmentDoc>[] = [];
      if (q.status) and.push({ status: q.status });
      if (q.to) and.push({ plannedStart: { $lt: new Date(q.to) } });
      if (q.from) and.push({ plannedEnd: { $gt: new Date(q.from) } });
      if (q.vehicleId) {
        const v = new ObjectId(q.vehicleId);
        and.push({ $or: [{ 'head.vehicleId': v }, { 'tail.vehicleId': v }] });
      }
      if (q.driverId) {
        const d = new ObjectId(q.driverId);
        and.push({ $or: [{ 'head.driverId': d }, { 'tail.driverId': d }] });
      }
      if (q.truckTypeId) {
        const ids = await app.db.collection(C.vehicles).find({ truckTypeId: new ObjectId(q.truckTypeId) }, { projection: { _id: 1 } }).toArray();
        and.push({ 'head.vehicleId': { $in: ids.map((v) => v._id) } });
      }
      const page = await paginate(coll(), and.length > 0 ? { $and: and } : {}, q);
      return { items: page.items.map(shipmentView), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/shipments/:id',
    { schema: { tags: ['shipments'], params: IdParams, response: { 200: ShipmentItem.extend({ deliveryOrders: z.array(DoItem) }) } }, preHandler: read },
    async (req) => {
      const doc = await coll().findOne({ _id: new ObjectId(req.params.id) });
      if (!doc) throw notFound('Shipment');
      const dos = await app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).find({ _id: { $in: doIdsOf(doc.stops) } }).toArray();
      return { ...shipmentView(doc), deliveryOrders: dos.map(toApi) };
    },
  );
};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS. Run the concurrency test 10 times to check stability: `for i in $(seq 1 10); do npx vitest run test/api/shipments-create.test.ts || break; done`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(shipments): create/read/list shipments with transactional DO linking and job-group re-match" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 9: Edit, plan and cancel shipments (optimistic versioning)

**Files:**
- Modify: `src/modules/shipments/shipment.service.ts`, `src/modules/shipments/shipments.routes.ts`
- Test: `test/api/shipments-edit.test.ts`

**Interfaces:**
- Consumes: Task 8 helpers.
- Produces:
  - `draftFromDoc(doc: ShipmentDoc): ShipmentDraft`.
  - `updateShipment(app, existing, patch: Partial<ShipmentInputT> & { version: number }, by): Promise<ShipmentDoc>` (422 `SHIPMENT_NOT_EDITABLE`, 409 `VERSION_CONFLICT`, 422 `SHIPMENT_INVALID`); DRAFT stays DRAFT, PLANNED/DISPATCHED/ACCEPTED become PLANNED and lose `dispatch`/`driverResponse`.
  - `transition(app, existing, { version, from: ShipmentStatus[], set, action, by, releaseDos? }): Promise<ShipmentDoc>` — generic guarded status change used by plan/cancel/dispatch/accept/decline.
  - Routes: `PATCH /shipments/:id`, `POST /shipments/:id/plan` `{ version }`, `POST /shipments/:id/cancel` `{ version, reason }`.

- [ ] **Step 1: Write the failing test**

`test/api/shipments-edit.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { type PlanningFixtures, createDo, postShipment, setupPlanning } from '../helpers/planning.js';

describe('edit, plan and cancel shipments', () => {
  let app: App;
  let f: PlanningFixtures;
  const day = (d: number, h: number) => `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00+07:00`;
  const patch = (id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/v1/shipments/${id}`, headers: f.planner, payload });
  const action = (id: string, name: string, payload: object) => app.inject({ method: 'POST', url: `/api/v1/shipments/${id}/${name}`, headers: f.planner, payload });

  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('rejects a stale version and removes DOs from the shipment', async () => {
    const a = await createDo(app, f);
    const b = await createDo(app, f, { destLocationId: f.ids.locC });
    const sh = (await postShipment(app, f, { plannedStart: day(5, 6), plannedEnd: day(5, 18), head: { vehicleId: f.ids.m1, driverId: f.ids.d1 }, doIds: [a.id, b.id] })).json();
    const edited = await patch(sh.id, { version: 1, doIds: [a.id] });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ version: 2, status: 'DRAFT' });
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: b.doNo })).toMatchObject({ status: 'UNASSIGNED', shipmentId: null });
    const stale = await patch(sh.id, { version: 1, note: 'from another tab' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('VERSION_CONFLICT');
  });

  it('requires completeness to plan, then keeps edits in PLANNED', async () => {
    const d = await createDo(app, f);
    const sh = (await postShipment(app, f, { plannedStart: day(6, 6), plannedEnd: day(6, 18), head: { vehicleId: f.ids.h1, driverId: null }, doIds: [d.id] })).json();
    const early = await action(sh.id, 'plan', { version: 1 });
    expect(early.statusCode).toBe(422);
    expect(early.json().details.errors.map((e: { code: string }) => e.code).sort()).toEqual(['HEAD_DRIVER_REQUIRED', 'TAIL_REQUIRED']);
    const fixed = await patch(sh.id, { version: 1, head: { vehicleId: f.ids.h1, driverId: f.ids.d1 }, tail: { vehicleId: f.ids.t1, driverId: f.ids.d1 } });
    const planned = await action(sh.id, 'plan', { version: fixed.json().version });
    expect(planned.json()).toMatchObject({ status: 'PLANNED', version: 3 });
    const moved = await patch(sh.id, { version: 3, plannedEnd: day(6, 20) });
    expect(moved.json()).toMatchObject({ status: 'PLANNED', version: 4 });
    const broken = await patch(sh.id, { version: 4, tail: null });
    expect(broken.json().details.errors.map((e: { code: string }) => e.code)).toEqual(['TAIL_REQUIRED']);
  });

  it('refuses edits that would double-book', async () => {
    const d1 = await createDo(app, f);
    const d2 = await createDo(app, f);
    await postShipment(app, f, { plannedStart: day(8, 6), plannedEnd: day(8, 18), head: { vehicleId: f.ids.m1, driverId: f.ids.d2 }, doIds: [d1.id] });
    const sh = (await postShipment(app, f, { plannedStart: day(8, 6), plannedEnd: day(8, 18), head: { vehicleId: f.ids.h2, driverId: f.ids.d3 }, tail: { vehicleId: f.ids.t2, driverId: f.ids.d3 }, doIds: [d2.id] })).json();
    const clash = await patch(sh.id, { version: 1, head: { vehicleId: f.ids.m1, driverId: f.ids.d3 }, tail: null });
    expect(clash.json().details.errors.map((e: { code: string }) => e.code)).toContain('VEHICLE_DOUBLE_BOOKED');
  });

  it('cancels a shipment, releases its DOs and then refuses edits', async () => {
    const d = await createDo(app, f);
    const sh = (await postShipment(app, f, { plannedStart: day(10, 6), plannedEnd: day(10, 18), head: { vehicleId: f.ids.m1, driverId: f.ids.d1 }, doIds: [d.id] })).json();
    const cancelled = await action(sh.id, 'cancel', { version: 1, reason: 'ลูกค้าเลื่อน' });
    expect(cancelled.json()).toMatchObject({ status: 'CANCELLED', cancelReason: 'ลูกค้าเลื่อน', version: 2 });
    expect(await app.db.collection(C.deliveryOrders).findOne({ doNo: d.doNo })).toMatchObject({ status: 'UNASSIGNED', shipmentId: null });
    const edit = await patch(sh.id, { version: 2, note: 'x' });
    expect(edit.json().code).toBe('SHIPMENT_NOT_EDITABLE');
    expect(await app.db.collection(C.auditLog).countDocuments({ entity: 'shipment', entityId: sh.id, action: 'cancel' })).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/shipments-edit.test.ts`
Expected: FAIL — PATCH 404.

- [ ] **Step 3: Implement service functions**

Append to `src/modules/shipments/shipment.service.ts` (add `import type { ShipmentStatus } from './shipment.types.js';`, `import { EDITABLE_STATUSES } from './shipment.types.js';` and `import type { ShipmentDraft } from './shipment.validation.js';` alongside existing imports):
```ts
export function draftFromDoc(doc: ShipmentDoc): ShipmentDraft {
  const slot = (s: ShipmentDoc['head']) => (s ? { vehicleId: s.vehicleId.toHexString(), driverId: s.driverId?.toHexString() ?? null } : null);
  return {
    plannedStart: doc.plannedStart,
    plannedEnd: doc.plannedEnd,
    head: slot(doc.head),
    tail: slot(doc.tail),
    stops: doc.stops.map((s) => ({
      locationId: s.locationId.toHexString(),
      plannedArrival: s.plannedArrival,
      pickupDoIds: s.pickupDoIds.map((i) => i.toHexString()),
      dropDoIds: s.dropDoIds.map((i) => i.toHexString()),
    })),
    note: doc.note,
  };
}

const versionConflict = () => conflict('VERSION_CONFLICT', 'The shipment was changed by someone else; reload and try again');

export async function updateShipment(
  app: FastifyInstance,
  existing: ShipmentDoc,
  patch: Partial<ShipmentInputT> & { version: number },
  by: string,
): Promise<ShipmentDoc> {
  if (!EDITABLE_STATUSES.includes(existing.status)) {
    throw unprocessable('SHIPMENT_NOT_EDITABLE', `A ${existing.status} shipment cannot be edited`);
  }
  if (patch.version !== existing.version) throw versionConflict();
  const base = draftFromDoc(existing);
  const draft: ShipmentDraft = {
    plannedStart: patch.plannedStart ? new Date(patch.plannedStart) : base.plannedStart,
    plannedEnd: patch.plannedEnd ? new Date(patch.plannedEnd) : base.plannedEnd,
    head: patch.head !== undefined ? patch.head : base.head,
    tail: patch.tail !== undefined ? patch.tail : base.tail,
    stops: base.stops,
    note: patch.note !== undefined ? patch.note : base.note,
  };
  if (patch.stops || patch.doIds) {
    const rebuilt = await toDraft(app.db, {
      plannedStart: draft.plannedStart.toISOString(),
      plannedEnd: draft.plannedEnd.toISOString(),
      head: draft.head,
      tail: draft.tail,
      stops: patch.stops,
      doIds: patch.doIds,
      note: draft.note,
    });
    draft.stops = rebuilt.stops;
  }
  const mode = existing.status === 'DRAFT' ? 'draft' : 'planned';
  const result = await validateShipment(app.db, draft, { shipmentId: existing._id, mode });
  if (result.errors.length > 0) throw invalid(result.errors, result.warnings);

  const stops = buildStopDocs(draft.stops, existing.stops);
  const status: ShipmentStatus = existing.status === 'DRAFT' ? 'DRAFT' : 'PLANNED';
  const next: ShipmentDoc = {
    ...existing,
    plannedStart: draft.plannedStart,
    plannedEnd: draft.plannedEnd,
    head: draft.head ? { vehicleId: oid(draft.head.vehicleId), driverId: draft.head.driverId ? oid(draft.head.driverId) : null } : null,
    tail: draft.tail ? { vehicleId: oid(draft.tail.vehicleId), driverId: draft.tail.driverId ? oid(draft.tail.driverId) : null } : null,
    stops,
    legs: buildLegDocs(stops),
    note: draft.note,
    status,
    dispatch: status === 'PLANNED' ? null : existing.dispatch,
    driverResponse: status === 'PLANNED' ? null : existing.driverResponse,
    version: existing.version + 1,
    updatedBy: by,
    updatedAt: new Date(),
  };
  return withTransaction(app.mongo, async (session) => {
    const coll = app.db.collection<ShipmentDoc>(C.shipments);
    const { _id, ...rest } = next;
    const res = await coll.updateOne({ _id, version: existing.version }, { $set: rest }, { session });
    if (res.matchedCount === 0) throw versionConflict();
    await linkDos(app.db, next, doIdsOf(existing.stops), session);
    next.warnings = [...withoutJobGroupWarnings(result.warnings), ...(await refreshJobGroups(app.db, next, result.headVehicle, session))];
    await coll.updateOne({ _id }, { $set: { warnings: next.warnings } }, { session });
    await writeAudit(app.db, { entity: 'shipment', entityId: _id.toHexString(), action: 'update', by, before: toApi(existing), after: toApi(next) }, { session });
    return next;
  });
}

export async function transition(
  app: FastifyInstance,
  existing: ShipmentDoc,
  opts: { version: number; from: ShipmentStatus[]; set: Partial<ShipmentDoc>; action: string; by: string; notAllowedCode: string; releaseDos?: boolean },
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
    await writeAudit(
      app.db,
      { entity: 'shipment', entityId: existing._id.toHexString(), action: opts.action, by: opts.by, before: { status: existing.status }, after: { status: updated.status } },
      { session },
    );
    return updated;
  });
}
```

- [ ] **Step 4: Add the routes**

In `src/modules/shipments/shipments.routes.ts` add imports `updateShipment, transition` from `./shipment.service.js`, `unprocessable` is not needed. Add a loader and routes inside `shipmentRoutes`:
```ts
  const load = async (id: string) => {
    const doc = await coll().findOne({ _id: new ObjectId(id) });
    if (!doc) throw notFound('Shipment');
    return doc;
  };
  const Version = z.object({ version: z.number().int().positive() });

  app.patch(
    '/shipments/:id',
    { schema: { tags: ['shipments'], params: IdParams, body: ShipmentInput.partial().extend({ version: z.number().int().positive() }), response: { 200: ShipmentItem } }, preHandler: write },
    async (req) => shipmentView(await updateShipment(app, await load(req.params.id), req.body, actorOf(req))),
  );

  app.post('/shipments/:id/plan', { schema: { tags: ['shipments'], params: IdParams, body: Version, response: { 200: ShipmentItem } }, preHandler: write }, async (req) => {
    const existing = await load(req.params.id);
    if (existing.status === 'DRAFT') {
      const result = await validateShipment(app.db, draftFromDoc(existing), { shipmentId: existing._id, mode: 'planned' });
      if (result.errors.length > 0) throw invalid(result.errors, result.warnings);
    }
    return shipmentView(
      await transition(app, existing, { version: req.body.version, from: ['DRAFT'], set: { status: 'PLANNED' }, action: 'plan', by: actorOf(req), notAllowedCode: 'SHIPMENT_NOT_DRAFT' }),
    );
  });

  app.post(
    '/shipments/:id/cancel',
    { schema: { tags: ['shipments'], params: IdParams, body: Version.extend({ reason: z.string().trim().min(3).max(500) }), response: { 200: ShipmentItem } }, preHandler: write },
    async (req) =>
      shipmentView(
        await transition(app, await load(req.params.id), {
          version: req.body.version,
          from: ['DRAFT', 'PLANNED', 'DISPATCHED', 'ACCEPTED'],
          set: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: req.body.reason },
          action: 'cancel',
          by: actorOf(req),
          notAllowedCode: 'SHIPMENT_NOT_CANCELLABLE',
          releaseDos: true,
        }),
      ),
  );
```
Also import `draftFromDoc` and `invalid` from `./shipment.service.js`. Replace the `GET /shipments/:id` handler's inline lookup with `load(req.params.id)`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(shipments): versioned edits, plan and cancel with DO relinking" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 10: Dispatch, driver accept/decline, driver shipment list

**Files:**
- Create: `src/modules/shipments/driver.routes.ts`
- Modify: `src/modules/shipments/shipments.routes.ts`, `src/routes.ts`
- Test: `test/api/shipments-dispatch.test.ts`

**Interfaces:**
- Consumes: `transition`, `validateShipment`, `draftFromDoc`, `invalid`, `shipmentView`, `doIdsOf`, `DoItem`, `ShipmentItem`.
- Produces:
  - `POST /shipments/:id/dispatch` `{ version }` (PLANNED only, re-validated in `planned` mode; 422 `SHIPMENT_NOT_PLANNED`) → DISPATCHED with `dispatch: { at, by, version: <new version> }`, `driverResponse: null`.
  - `GET /driver/shipments` (role `driver`; 403 `NOT_A_DRIVER` if the user has no `driverId`) → `{ items: DriverShipment[] }` for DISPATCHED/ACCEPTED/IN_TRANSIT shipments where the driver is head or tail driver, ordered by `plannedStart`. `DriverShipment = ShipmentItem + { deliveryOrders: DoItem[]; locations: { id, code, name, lat, lng, geofenceRadiusM }[] }`.
  - `POST /driver/shipments/:id/accept` → ACCEPTED (`driverResponse.status = 'ACCEPTED'`); `POST /driver/shipments/:id/decline` `{ reason }` → PLANNED, `dispatch: null`, `driverResponse.status = 'DECLINED'`. A shipment the driver is not on → 404. Wrong status → 422 `SHIPMENT_NOT_DISPATCHED`.

- [ ] **Step 1: Write the failing test**

`test/api/shipments-dispatch.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { type PlanningFixtures, createDo, postShipment, setupPlanning } from '../helpers/planning.js';

describe('dispatch and driver response', () => {
  let app: App;
  let f: PlanningFixtures;
  const day = (d: number, h: number) => `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00+07:00`;
  const post = (url: string, headers: { authorization: string }, payload?: object) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers, payload });
  const driverList = (headers: { authorization: string }) => app.inject({ method: 'GET', url: '/api/v1/driver/shipments', headers });

  async function plannedShipment(d: number) {
    const o = await createDo(app, f);
    const sh = (await postShipment(app, f, { plannedStart: day(d, 6), plannedEnd: day(d, 18), head: { vehicleId: f.ids.h1, driverId: f.ids.d1 }, tail: { vehicleId: f.ids.t1, driverId: f.ids.d1 }, doIds: [o.id] })).json();
    return (await post(`/shipments/${sh.id}/plan`, f.planner, { version: 1 })).json();
  }

  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('dispatches, shows the job only to its driver, and records acceptance', async () => {
    const sh = await plannedShipment(5);
    const draftOnly = (await postShipment(app, f, { plannedStart: day(20, 6), plannedEnd: day(20, 8), mode: 'draft' })).json();
    expect((await post(`/shipments/${draftOnly.id}/dispatch`, f.planner, { version: 1 })).json().code).toBe('SHIPMENT_NOT_PLANNED');
    const dispatched = await post(`/shipments/${sh.id}/dispatch`, f.planner, { version: sh.version });
    expect(dispatched.json()).toMatchObject({ status: 'DISPATCHED', dispatch: { version: sh.version + 1 } });
    const mine = (await driverList(f.driver1)).json().items;
    expect(mine.map((s: { id: string }) => s.id)).toEqual([sh.id]);
    expect(mine[0].deliveryOrders).toHaveLength(1);
    expect(mine[0].locations.map((l: { code: string }) => l.code).sort()).toEqual(['A', 'B']);
    expect((await driverList(f.driver2)).json().items).toEqual([]);
    expect((await post(`/driver/shipments/${sh.id}/accept`, f.driver2)).statusCode).toBe(404);
    const accepted = await post(`/driver/shipments/${sh.id}/accept`, f.driver1);
    expect(accepted.json()).toMatchObject({ status: 'ACCEPTED', driverResponse: { status: 'ACCEPTED' } });
    expect((await post(`/driver/shipments/${sh.id}/accept`, f.driver1)).json().code).toBe('SHIPMENT_NOT_DISPATCHED');
  });

  it('returns a declined shipment to the planner with the reason', async () => {
    const sh = await plannedShipment(7);
    await post(`/shipments/${sh.id}/dispatch`, f.planner, { version: sh.version });
    const declined = await post(`/driver/shipments/${sh.id}/decline`, f.driver1, { reason: 'รถมีปัญหาเบรก' });
    expect(declined.json()).toMatchObject({ status: 'PLANNED', dispatch: null, driverResponse: { status: 'DECLINED', reason: 'รถมีปัญหาเบรก' } });
  });

  it('pulls an accepted shipment back to PLANNED when the planner edits it', async () => {
    const sh = await plannedShipment(9);
    const d = (await post(`/shipments/${sh.id}/dispatch`, f.planner, { version: sh.version })).json();
    const a = (await post(`/driver/shipments/${sh.id}/accept`, f.driver1)).json();
    expect(a.version).toBe(d.version + 1);
    const edited = await app.inject({ method: 'PATCH', url: `/api/v1/shipments/${sh.id}`, headers: f.planner, payload: { version: a.version, plannedEnd: day(9, 20) } });
    expect(edited.json()).toMatchObject({ status: 'PLANNED', dispatch: null, driverResponse: null });
    expect((await driverList(f.driver1)).json().items.map((s: { id: string }) => s.id)).not.toContain(sh.id);
  });

  it('rejects driver endpoints for staff and users without a driver link', async () => {
    expect((await driverList(f.planner)).statusCode).toBe(403);
  });
});
```

Note: `plannedShipment` passes `mode` to `POST /shipments` for the draft-only case — `ShipmentInput` has no `mode` field and zod strips unknown keys, so the request still creates a DRAFT with warnings. Keep it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/shipments-dispatch.test.ts`
Expected: FAIL — dispatch route 404.

- [ ] **Step 3: Implement dispatch**

In `src/modules/shipments/shipments.routes.ts` add inside `shipmentRoutes`:
```ts
  app.post('/shipments/:id/dispatch', { schema: { tags: ['shipments'], params: IdParams, body: Version, response: { 200: ShipmentItem } }, preHandler: write }, async (req) => {
    const existing = await load(req.params.id);
    if (existing.status !== 'PLANNED') throw unprocessable('SHIPMENT_NOT_PLANNED', `Cannot dispatch a ${existing.status} shipment`);
    const result = await validateShipment(app.db, draftFromDoc(existing), { shipmentId: existing._id, mode: 'planned' });
    if (result.errors.length > 0) throw invalid(result.errors, result.warnings);
    const by = actorOf(req);
    return shipmentView(
      await transition(app, existing, {
        version: req.body.version,
        from: ['PLANNED'],
        set: { status: 'DISPATCHED', dispatch: { at: new Date(), by, version: existing.version + 1 }, driverResponse: null },
        action: 'dispatch',
        by,
        notAllowedCode: 'SHIPMENT_NOT_PLANNED',
      }),
    );
  });
```
(add `unprocessable` to the errors import).

- [ ] **Step 4: Implement driver routes**

`src/modules/shipments/driver.routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf } from '../../lib/audit.js';
import { AppError, notFound } from '../../lib/errors.js';
import { IdParams } from '../../lib/ids.js';
import { toApi } from '../../lib/serialize.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import { DoItem } from '../orders/orders.schemas.js';
import { ShipmentItem } from './shipment.schemas.js';
import { doIdsOf, shipmentView, transition } from './shipment.service.js';
import type { ShipmentDoc } from './shipment.types.js';

const LocationLite = z.object({ id: z.string(), code: z.string(), name: z.string(), lat: z.number(), lng: z.number(), geofenceRadiusM: z.number() });
const DriverShipment = ShipmentItem.extend({ deliveryOrders: z.array(DoItem), locations: z.array(LocationLite) });

export const driverRoutes: FastifyPluginAsyncZod = async (app) => {
  const driverOnly = app.requireRoles('driver');
  const coll = () => app.db.collection<ShipmentDoc>(C.shipments);

  const driverIdOf = (req: { principal: unknown }) => {
    const p = req.principal as { kind: string; driverId: string | null } | null;
    if (!p || p.kind !== 'user' || !p.driverId) throw new AppError(403, 'NOT_A_DRIVER', 'This user is not linked to a driver');
    return new ObjectId(p.driverId);
  };
  const mine = (driverId: ObjectId) => ({ $or: [{ 'head.driverId': driverId }, { 'tail.driverId': driverId }] });
  const loadMine = async (id: string, driverId: ObjectId) => {
    const doc = await coll().findOne({ _id: new ObjectId(id), ...mine(driverId) });
    if (!doc) throw notFound('Shipment');
    return doc;
  };

  app.get('/driver/shipments', { schema: { tags: ['driver'], response: { 200: z.object({ items: z.array(DriverShipment) }) } }, preHandler: driverOnly }, async (req) => {
    const driverId = driverIdOf(req);
    const docs = await coll()
      .find({ status: { $in: ['DISPATCHED', 'ACCEPTED', 'IN_TRANSIT'] }, ...mine(driverId) })
      .sort({ plannedStart: 1 })
      .limit(50)
      .toArray();
    const items = [];
    for (const doc of docs) {
      const dos = await app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).find({ _id: { $in: doIdsOf(doc.stops) } }).toArray();
      const locs = await app.db.collection(C.locations).find({ _id: { $in: doc.stops.map((s) => s.locationId) } }).toArray();
      items.push({
        ...shipmentView(doc),
        deliveryOrders: dos.map(toApi),
        locations: locs.map((l) => ({
          id: l._id.toHexString(), code: l.code, name: l.name,
          lat: l.geo.coordinates[1], lng: l.geo.coordinates[0], geofenceRadiusM: l.geofenceRadiusM,
        })),
      });
    }
    return { items };
  });

  app.post('/driver/shipments/:id/accept', { schema: { tags: ['driver'], params: IdParams, response: { 200: ShipmentItem } }, preHandler: driverOnly }, async (req) => {
    const driverId = driverIdOf(req);
    const existing = await loadMine(req.params.id, driverId);
    const by = actorOf(req);
    return shipmentView(
      await transition(app, existing, {
        version: existing.version,
        from: ['DISPATCHED'],
        set: { status: 'ACCEPTED', driverResponse: { status: 'ACCEPTED', reason: null, at: new Date(), by } },
        action: 'accept',
        by,
        notAllowedCode: 'SHIPMENT_NOT_DISPATCHED',
      }),
    );
  });

  app.post(
    '/driver/shipments/:id/decline',
    { schema: { tags: ['driver'], params: IdParams, body: z.object({ reason: z.string().trim().min(3).max(500) }), response: { 200: ShipmentItem } }, preHandler: driverOnly },
    async (req) => {
      const driverId = driverIdOf(req);
      const existing = await loadMine(req.params.id, driverId);
      const by = actorOf(req);
      return shipmentView(
        await transition(app, existing, {
          version: existing.version,
          from: ['DISPATCHED'],
          set: { status: 'PLANNED', dispatch: null, driverResponse: { status: 'DECLINED', reason: req.body.reason, at: new Date(), by } },
          action: 'decline',
          by,
          notAllowedCode: 'SHIPMENT_NOT_DISPATCHED',
        }),
      );
    },
  );
};
```

`src/routes.ts` — import `{ driverRoutes } from './modules/shipments/driver.routes.js'` and register it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(shipments): dispatch plus driver accept/decline and driver job list" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 11: Availability endpoint

**Files:**
- Create: `src/modules/availability/availability.routes.ts`
- Modify: `src/routes.ts`
- Test: `test/api/availability.test.ts`

**Interfaces:**
- Consumes: `RESERVING_STATUSES`, `BlockDoc`, time helpers.
- Produces: `GET /availability?from=&to=&truckTypeId=` (staff) → `{ from, to, vehicles: VehicleAvailability[], drivers: DriverAvailability[] }` where `VehicleAvailability = { id, plate, part, truckTypeId, available, reasons }`, `DriverAvailability = { id, code, name, available, reasons }`, `Reason = { kind: 'shipment'|'block'|'day_off'|'holiday'; code: string; message: string; until: string | null; shipmentNo: string | null }`. `available` is false only for `shipment` reasons and blocking `block` reasons. 422 `INVALID_RANGE` when `to <= from`.

- [ ] **Step 1: Write the failing test**

`test/api/availability.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { type PlanningFixtures, createDo, postShipment, setupPlanning } from '../helpers/planning.js';

describe('GET /availability', () => {
  let app: App;
  let f: PlanningFixtures;
  const q = (from: string, to: string, extra = '') =>
    app.inject({ method: 'GET', url: `/api/v1/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${extra}`, headers: f.viewer });

  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
    const d = await createDo(app, f);
    await postShipment(app, f, { plannedStart: '2026-10-04T06:00:00+07:00', plannedEnd: '2026-10-04T18:00:00+07:00', head: { vehicleId: f.ids.h1, driverId: f.ids.d1 }, tail: { vehicleId: f.ids.t1, driverId: f.ids.d1 }, doIds: [d.id] });
    await app.inject({ method: 'POST', url: '/api/v1/resource-blocks', headers: f.planner, payload: { resourceType: 'vehicle', resourceId: f.ids.h2, statusCode: 'PM', from: '2026-10-04T00:00:00+07:00', to: '2026-10-05T12:00:00+07:00' } });
  });
  afterAll(async () => closeTestApp(app));

  it('explains why each resource is or is not free', async () => {
    const res = await q('2026-10-04T08:00:00+07:00', '2026-10-04T12:00:00+07:00');
    expect(res.statusCode).toBe(200);
    const v = Object.fromEntries(res.json().vehicles.map((x: { plate: string }) => [x.plate, x]));
    expect(v['70-1001']).toMatchObject({ available: false, reasons: [expect.objectContaining({ kind: 'shipment' })] });
    expect(v['70-1002']).toMatchObject({ available: false, reasons: [expect.objectContaining({ kind: 'block', code: 'PM', until: '2026-10-05T05:00:00.000Z' })] });
    expect(v['80-3001']).toMatchObject({ available: true, reasons: [] });
    const d = Object.fromEntries(res.json().drivers.map((x: { code: string }) => [x.code, x]));
    expect(d.D1.available).toBe(false);
    // 4 Oct 2026 is a Sunday: D3 is normally off but still assignable.
    expect(d.D3).toMatchObject({ available: true, reasons: [expect.objectContaining({ kind: 'day_off' })] });
  });

  it('filters vehicles by truck type and validates the range', async () => {
    const res = await q('2026-10-06T08:00:00+07:00', '2026-10-06T12:00:00+07:00', `&truckTypeId=${f.ids.mixerType}`);
    expect(res.json().vehicles.map((x: { plate: string }) => x.plate)).toEqual(['80-3001']);
    expect((await q('2026-10-06T12:00:00+07:00', '2026-10-06T08:00:00+07:00')).json().code).toBe('INVALID_RANGE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/availability.test.ts`
Expected: FAIL — 404.

- [ ] **Step 3: Implement**

`src/modules/availability/availability.routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Document } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { unprocessable } from '../../lib/errors.js';
import { objectIdString } from '../../lib/ids.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { bangkokDatesBetween, bangkokWeekday } from '../../lib/time.js';
import { RESERVING_STATUSES, type ShipmentDoc } from '../shipments/shipment.types.js';
import type { BlockDoc } from './blocks.service.js';

const Reason = z.object({
  kind: z.enum(['shipment', 'block', 'day_off', 'holiday']),
  code: z.string(),
  message: z.string(),
  until: z.string().nullable(),
  shipmentNo: z.string().nullable(),
});
type ReasonT = z.infer<typeof Reason>;

const Response = z.object({
  from: z.string(),
  to: z.string(),
  vehicles: z.array(z.object({ id: z.string(), plate: z.string(), part: z.string(), truckTypeId: z.string(), available: z.boolean(), reasons: z.array(Reason) })),
  drivers: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), available: z.boolean(), reasons: z.array(Reason) })),
});

export const availabilityRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/availability',
    {
      schema: {
        tags: ['availability'],
        querystring: z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }), truckTypeId: objectIdString.optional() }),
        response: { 200: Response },
      },
      preHandler: app.requireRoles(...STAFF_ROLES),
    },
    async (req) => {
      const from = new Date(req.query.from);
      const to = new Date(req.query.to);
      if (to <= from) throw unprocessable('INVALID_RANGE', '`to` must be after `from`');
      const vFilter: Document = { active: true };
      if (req.query.truckTypeId) vFilter.truckTypeId = new ObjectId(req.query.truckTypeId);
      const [vehicles, drivers, shipments, blocks] = await Promise.all([
        app.db.collection(C.vehicles).find(vFilter).sort({ plate: 1 }).toArray(),
        app.db.collection(C.drivers).find({ active: true }).sort({ code: 1 }).toArray(),
        app.db.collection<ShipmentDoc>(C.shipments).find({ status: { $in: RESERVING_STATUSES }, plannedStart: { $lt: to }, plannedEnd: { $gt: from } }).toArray(),
        app.db.collection<BlockDoc>(C.resourceBlocks).find({ cancelledAt: null, from: { $lt: to }, to: { $gt: from } }).toArray(),
      ]);
      const dates = bangkokDatesBetween(from, to);
      const holidays = await app.db.collection(C.holidays).find({ date: { $in: dates }, active: true }).toArray();

      const reasons = new Map<string, ReasonT[]>();
      const add = (id: ObjectId | null | undefined, r: ReasonT) => {
        if (!id) return;
        const k = id.toHexString();
        reasons.set(k, [...(reasons.get(k) ?? []), r]);
      };
      for (const s of shipments) {
        const r: ReasonT = { kind: 'shipment', code: s.status, message: `On shipment ${s.shipmentNo}`, until: s.plannedEnd.toISOString(), shipmentNo: s.shipmentNo };
        add(s.head?.vehicleId, r);
        add(s.tail?.vehicleId, r);
        add(s.head?.driverId, r);
        if (!s.tail?.driverId?.equals(s.head?.driverId ?? new ObjectId())) add(s.tail?.driverId, r);
      }
      const blocking = new Set<string>();
      for (const b of blocks) {
        add(b.resourceId, { kind: 'block', code: b.statusCode, message: `${b.statusCode} until ${b.to.toISOString()}`, until: b.to.toISOString(), shipmentNo: null });
        if (b.blocksAssignment) blocking.add(b.resourceId.toHexString());
      }
      for (const d of drivers) {
        const off = ((d.weeklyDaysOff as number[] | undefined) ?? []).length > 0 ? dates.filter((date) => (d.weeklyDaysOff as number[]).includes(bangkokWeekday(date))) : [];
        if (off.length > 0) add(d._id, { kind: 'day_off', code: 'DAY_OFF', message: `Normally off on ${off.join(', ')}`, until: null, shipmentNo: null });
        for (const h of holidays) add(d._id, { kind: 'holiday', code: 'HOLIDAY', message: `${h.date} ${h.name}`, until: null, shipmentNo: null });
      }
      const isAvailable = (id: ObjectId) => {
        const rs = reasons.get(id.toHexString()) ?? [];
        return !rs.some((r) => r.kind === 'shipment') && !blocking.has(id.toHexString());
      };
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        vehicles: vehicles.map((v) => ({
          id: v._id.toHexString(), plate: v.plate, part: v.part, truckTypeId: (v.truckTypeId as ObjectId).toHexString(),
          available: isAvailable(v._id), reasons: reasons.get(v._id.toHexString()) ?? [],
        })),
        drivers: drivers.map((d) => ({
          id: d._id.toHexString(), code: d.code, name: d.name,
          available: isAvailable(d._id), reasons: reasons.get(d._id.toHexString()) ?? [],
        })),
      };
    },
  );
};
```

`src/routes.ts` — import `{ availabilityRoutes } from './modules/availability/availability.routes.js'` and register it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(availability): availability endpoint combining shipments, blocks, days off and holidays" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 12: Bulk shipments and planning README

**Files:**
- Modify: `src/modules/shipments/shipments.routes.ts`, `README.md`
- Test: `test/api/shipments-bulk.test.ts`

**Interfaces:**
- Consumes: `createShipment`, `AppError`.
- Produces: `POST /shipments/bulk` `{ items: ShipmentInput[] }` (1–100) → `{ results: { index, ok, id, shipmentNo, errors, warnings }[] }` (200). Each item is saved independently (atomic per item, not across items), in order; a later item that conflicts with an earlier one fails with the same codes as `POST /shipments`.

- [ ] **Step 1: Write the failing test**

`test/api/shipments-bulk.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/shipments-bulk.test.ts`
Expected: FAIL — 404.

- [ ] **Step 3: Implement**

In `src/modules/shipments/shipments.routes.ts` add (before `/shipments/:id` routes), importing `AppError` and `type Issue`:
```ts
  const BulkShipmentResult = z.object({
    index: z.number(),
    ok: z.boolean(),
    id: z.string().nullable(),
    shipmentNo: z.string().nullable(),
    errors: z.array(IssueSchema),
    warnings: z.array(IssueSchema),
  });

  app.post(
    '/shipments/bulk',
    { schema: { tags: ['shipments'], body: z.object({ items: z.array(ShipmentInput).min(1).max(100) }), response: { 200: z.object({ results: z.array(BulkShipmentResult) }) } }, preHandler: write },
    async (req) => {
      const by = actorOf(req);
      const results: z.infer<typeof BulkShipmentResult>[] = [];
      for (const [index, input] of req.body.items.entries()) {
        try {
          const { doc, warnings } = await createShipment(app, input, by);
          results.push({ index, ok: true, id: doc._id.toHexString(), shipmentNo: doc.shipmentNo, errors: [], warnings });
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          const details = e.details as { errors?: Issue[]; warnings?: Issue[] } | undefined;
          results.push({
            index, ok: false, id: null, shipmentNo: null,
            errors: details?.errors ?? [{ code: e.code, message: e.message }],
            warnings: details?.warnings ?? [],
          });
        }
      }
      return { results };
    },
  );
```

Append to `README.md`:
````markdown
## Planning (Plan 2)

Flow: create delivery orders (`POST /delivery-orders` or `/delivery-orders/bulk`) → build a shipment (`POST /shipments` with `doIds` for automatic stops, or explicit `stops`) → check it any time with `POST /shipments/validate` → `POST /shipments/:id/plan` → `POST /shipments/:id/dispatch` → the driver accepts or declines (`/driver/shipments/:id/accept|decline`).

- Shipments carry a `version`; send the version you last read with every change. A stale version gets `409 VERSION_CONFLICT`.
- A DRAFT may be incomplete (missing vehicle, driver, stops, DOs come back as warnings) but never conflicting. Planning requires completeness.
- Editing a dispatched or accepted shipment returns it to PLANNED; dispatch it again.
- Mixer round trips: create many shipments at once with `POST /shipments/bulk`.

### Availability and status codes

- `GET /status-codes` — the two-level catalogue: `level1` is `working` / `not_working`, `code` is the detail (ATMS codes such as `A`, `A50`, `ล`, `ป`; planning codes such as `PM`, `REPAIR`, `TIRE`, `LEAVE`). Codes named `ATMS … (รอยืนยันความหมาย)` need their meaning confirmed by the PO (admin can rename them).
- `POST /resource-blocks` — mark a truck or driver unavailable for a period with a status code. Codes with `blocksAssignment: true` stop assignment; `OTHER` only warns.
- `GET /holidays`, drivers' `weeklyDaysOff` — produce warnings, never block.
- `GET /availability?from=&to=` — every active truck and driver with `available` and the reasons.
````

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all PASS; build exits 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(shipments): bulk shipment creation for repeated trips; document planning in README" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

## Self-review notes (plan author)

- **Spec coverage:** §3.3 deliveryOrders/shipments (Tasks 3, 8), §3.2 stops/legs (Task 5), §3.4 matching on create + re-match on vehicle (Tasks 3, 8), §4 blocking rules and warnings (Task 7; distance-gap warning deferred, see header), §5.1 lifecycle up to ACCEPTED/decline/cancel (Tasks 9–10), §5.2 DO UNASSIGNED/PLANNED/CANCELLED (Tasks 3, 8, 9), §8.3 delivery orders + shipments + availability + driver accept/decline + `GET /driver/shipments` (Tasks 3–4, 7–12). Phase-2 requirements §1 availability and two-level status (Tasks 2, 6, 7, 11). Events, PODs, pallets, IN_TRANSIT/COMPLETED/CLOSED transitions, POD templates in the driver list: Plan 3.
- **Carry-forward from Plan 1:** candidates semantics documented (Task 1), counter overflow documented (Task 1), truck-type category and `isSite` guards (Task 1), inactive references rejected on DOs and shipments (Tasks 3, 7), availability with blocks + calendar (Tasks 2, 6, 11).
- **Known limitation:** `findShipmentsUsing` and block/holiday queries run per validation; fine at current fleet size (~2k vehicles), revisit with the planning board UI if it validates on every keystroke.
