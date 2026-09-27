# mena-backend-services — Phase 1: Planning + ePOD — Design Spec

- **Date:** 2026-09-27
- **Owner (PO):** Plug (narongkorn.a@menatransport.co.th)
- **Status:** Draft — awaiting PO review
- **Replaces:** `nrk16p/backend-tdm` (FastAPI + Postgres `fleetdata`)
- **Applies to:** all clients and all truck types — Mixer, Trailer, Feedmill, Coldchain, Side Curtain

---

## 1. Purpose

Build one backend for Mena Transport operations, across every client and truck type, so that:

1. The **transport team plans work** — creates Delivery Orders (DOs), groups them into Shipments, assigns head + tail + driver, and dispatches to the driver.
2. **Drivers execute** the shipment step by step and submit a **standard, tamper-evident electronic Proof of Delivery (ePOD)** per DO.
3. **Admin verifies PODs and closes the shipment**, producing a locked **Trip Summary (ใบสรุปเที่ยว)** containing the evidence bundle — and, from Phase 2, the money lines (ค่าเที่ยว พจส., cost, company revenue).

Differences between clients and truck types are expressed as **configuration** (job groups, POD templates, extra steps), never as hard-coded rules (the legacy hard-coded "นีโอ" status flow is replaced by template `extraSteps`).

### Success criteria (Phase 1)

- A planner can create DOs (single or Excel import), build a shipment with ordered stops, assign head/tail/driver without double-booking, and dispatch it — entirely through the API.
- A driver can accept the shipment, record every stop event with GPS, submit a POD per DO using the client's POD form, and do so while intermittently offline without creating duplicates.
- Admin can verify/reject PODs and close the shipment; the Trip Summary and evidence PDF are generated and locked.
- Pallet movements and per-trailer pallet balance work as in the old system.
- The 4 GPS sync jobs feed the new API with an unchanged payload.
- Legacy `backend-tdm` data (users, jobs, tickets, pallets, vehicle positions) is migrated and reconciled.
- Complete OpenAPI documentation is published for the frontend teams.

### Out of scope (Phase 1)

- Rate engine and money calculation, driver pay periods, client invoicing — **Phase 2** (data model reserves space; see §9).
- Frontends (admin panel, driver app) — Phase 1 is **API-first**.
- LINE notifications, customer portal, route optimisation.
- Continuous in-transit sensor logging (e.g. Coldchain temperature over the whole trip) — see §12.

---

## 2. Stack & deployment

| Concern | Choice |
|---|---|
| Runtime / framework | Node.js 22 + TypeScript + **Fastify** |
| Validation / contract | **Zod** schemas → OpenAPI via `fastify-type-provider-zod` + `@fastify/swagger` |
| Database | **MongoDB** — separate database, preferably a separate small cluster from the analytics cluster |
| File storage | **DigitalOcean Spaces** (S3-compatible), private bucket |
| Hosting | Render web service; environments: local (Docker Mongo), staging, production |
| Logging | pino (structured) |
| Tests | Vitest + `mongodb-memory-server` + Fastify `inject` |
| Repo | New **private** repo `nrk16p/mena-backend-services` |

All secrets (JWT keys, API-key pepper, DB URI, Spaces keys) come from environment variables. `.gitignore` is UTF-8 and ignores `.env*`.

### Code layout

```
src/
  app.ts, server.ts, config.ts
  plugins/         auth, errors, audit, idempotency, mongo, storage
  modules/
    auth/  master/  orders/  shipments/  events/  pods/  pallets/  summaries/  gps/
      <module>.routes.ts    Zod schemas + route wiring
      <module>.service.ts   business rules (pure where possible)
      <module>.repo.ts      Mongo access
  lib/             geo (haversine, geofence), hashing, counters, status derivation
scripts/           seed.ts, migrate-legacy.ts
test/              unit/, api/
```

---

## 3. Domain model

### 3.1 Core concepts

- **Delivery Order (DO)** — one client's request to move a material/quantity from an origin location to a destination location. Carries client, **job group**, service type, material, quantity, time windows, client-stated distance.
- **Shipment** — one trip of one vehicle set (Truck_Head + Truck_Tail, each with a driver). Has an **ordered list of stops**. Each DO attaches to a **pickup stop** and a **drop stop** of the shipment.
- **Stop** — a visit to a location (pickup and/or drop). **Legs** are derived between consecutive stops.
- **Job group (กลุ่มงาน)** — a client-defined named group, defined by matching criteria over truck type, service type, site/plant, material, and origin/destination zone. Rates (Phase 2) and POD templates attach to job groups.

**Rigid trucks** (e.g. Mixer, Side Curtain rigid, Coldchain rigid): the vehicle is registered as `part: rigid` and occupies the head slot; the tail slot is not required. Head+tail is required only when the head's truck type is a tractor.

### 3.2 Why stops, not DO-as-leg

Operations include **co-loading** (one leg carries goods for several DOs/clients) and **empty legs**. With DOs as legs, a valid co-loaded trip (DO1 A→B, DO2 A→C) breaks the rule "destination of DO(n) = origin of DO(n+1)", and empty legs have no DO. With stops as the backbone:

- the route chain is continuous by construction;
- the validated rule becomes: **each DO's pickup stop precedes its drop stop**;
- a leg with no DO on board is an **empty leg** (kept for Phase 2 cost);
- **total shipment distance = sum of legs** (summing DO distances would double-count co-loaded legs).

Example:

```
Shipment SH-2609-00123   head 70-1234 + tail 70-5678, driver D001
 stops: [1] A pickup  [2] B drop  [3] C drop  [4] D pickup  [5] E drop
 legs:  A→B (DO-1, DO-2)  B→C (DO-2)  C→D (empty)  D→E (DO-3)
 DO-1 (SCG · ปูนถุง):     stop 1 → stop 2
 DO-2 (SCG · ปูนผง):      stop 1 → stop 3     ← co-loaded on A→B
 DO-3 (CPAC · ready-mix): stop 4 → stop 5
```

Tail swaps and mid-shipment driver changes do **not** occur in operations; resources are assigned per shipment.

### 3.3 Collections

**Master data**

| Collection | Fields (key) |
|---|---|
| `clients` | `code` (unique), `name`, `active` |
| `jobGroups` | `clientId`, `code` (unique per client), `name`, `criteria { truckTypeIds[], serviceTypeIds[], siteIds[], materialIds[], originZoneIds[], destZoneIds[] }` (empty array = any), `podTemplateId`, `active` |
| `zones` | `code`, `name` |
| `locations` | `code`, `name`, `clientId?`, `zoneId`, `isSite`, `address`, `geo` (GeoJSON Point, **2dsphere** index), `geofenceRadiusM` (default 300) |
| `materials` | `code`, `name`, `unit` |
| `serviceTypes` | `code`, `name` (e.g. single delivery, round trip, daily hire เหมาวัน) |
| `truckTypes` | `code`, `name`, `category: tractor \| rigid`, e.g. Mixer, Trailer, Feedmill, Coldchain, Side Curtain (and their sizes) |
| `vehicles` | `plate` (unique), `part: head \| tail \| rigid`, `truckTypeId`, `gpsVendor?`, `gpsId?`, `active` |
| `drivers` | `code`, `name`, `phone`, `licenseType`, `licenseExpiry`, `userId?`, `active` |
| `users` | `username` (unique), `passwordHash` (argon2id), `roles[]`, `driverId?`, `active`, `lastLogin { at, lat, lng }` |
| `apiKeys` | `name`, `keyHash`, `scopes[]` (e.g. `gps:write`), `active`, `lastUsedAt` |
| `podTemplates` | `clientId`, `jobGroupId?`, `version` (immutable once published), `status: draft \| published`, `extraSteps[]` (e.g. `DOCS_SUBMITTED`, `DOCS_RETURNED`, `SEAL_CHECKED`, `TEMP_CHECKED`), `fields[]` |
| `palletMovementTypes` | `code`, `name`, `sign: +1 \| -1 \| 0` (seeded: รับคืน +1, ยืมลค. +1, นำฝาก −1, คืนลค. −1) |

POD template field definition: `{ key, label, type, required, min?, max?, unit?, options? }` where `type ∈ photo | signature | text | number | select | checkbox | qtyLines | palletLines`. Truck-type specific evidence is configured here (e.g. Coldchain: `number` temperature °C + `photo` of the thermometer; Mixer: `photo` of the delivery ticket + `number` slump).

**Operations**

| Collection | Fields (key) |
|---|---|
| `counters` | `_id` (e.g. `SH-2609`), `seq` — atomic `findOneAndUpdate($inc)` |
| `deliveryOrders` | `doNo` (server-generated, immutable), `clientRef`, `clientId`, `jobGroupId?`, `jobGroupMatch { status: auto \| manual \| ambiguous \| none, candidates[] }`, `serviceTypeId`, `materialId`, `intendedTruckTypeId?`, `qty`, `unit`, `palletPlan { type, qty }?`, `originLocationId`, `destLocationId`, `pickupWindow { from, to }?`, `dropWindow { from, to }?`, `distance { clientKm? }`, `shipmentId?` (null = unassigned), `pickupStopId?`, `dropStopId?`, `status`, `attempts[]` (failed-attempt history: shipmentId, reasonCode, podId, at), `legacy?`, `createdBy/At`, `updatedBy/At` |
| `shipments` | `shipmentNo` (server-generated, immutable), `status`, `version`, `plannedStart`, `plannedEnd`, `head { vehicleId, driverId }`, `tail { vehicleId, driverId }?`, `stops[] { stopId, seq, locationId, pickupDoIds[], dropDoIds[], plannedArrival?, status }`, `legs[] { fromStopId, toStopId, loaded, doIds[], mapKm?, gpsKm? }` (derived), `warnings[]`, `dispatch { at, by, version }`, `driverResponse { status, reason?, at }`, `closedAt?`, `closedBy?`, `summaryId?`, `legacy?` |
| `events` | **append-only** — `clientEventId` (UUID, unique), `shipmentId`, `stopId?`, `doId?`, `code`, `reasonCode?`, `note?`, `deviceTime`, `receivedAt`, `lat?`, `lng?`, `accuracyM?`, `noGpsReason?`, `geofenceDistanceM?`, `source: app \| geofence \| admin`, `by`, `correctsEventId?`, `flags[]` |
| `pods` | `clientPodId` (UUID, unique), `doId`, `shipmentId`, `stopId`, `templateId`, `templateVersion`, `answers {}`, `files[] { key, fieldKey, sha256, bytes, mime }`, `evidence { deviceTime, receivedAt, lat, lng, accuracyM, geofenceDistanceM, device, appVersion, offline }`, `hash`, `status: submitted \| verified \| rejected`, `review { by, at, reason? }`, `supersedesPodId?`, `flags[]` |
| `palletMovements` | **append-only** — `clientEventId`, `tailVehicleId`, `driverId`, `shipmentId?`, `doId?`, `stopId?`, `locationId?`, `typeCode`, `qty`, `remark?`, `deviceTime`, `lat?`, `lng?`, `balanceAfter` |
| `palletBalances` | `tailVehicleId` (unique), `balance`, `lastMovementAt` |
| `tripSummaries` | `shipmentId`, `shipmentNo`, `lockedAt`, `evidence { podIds[], eventCount, distances { mapKm, gpsKm, clientKm per DO }, flags[] }`, `lines[]` (**empty in Phase 1**), `adjustments[]` (Phase 2), `pdfKey?` |
| `vehiclePositions` | `plate` (unique), `vehicleId?`, `gpsVendor`, `gpsId`, `lat`, `lng`, `speed`, `status`, `gpsUpdatedAt`, `updatedAt` |
| `auditLog` | `entity`, `entityId`, `action`, `by`, `at`, `before`, `after` |

Number formats: `SH-YYMM-NNNNN`, `DO-YYMM-NNNNN` (YYMM from creation time, Asia/Bangkok). Numbers are never reused, never editable, and no endpoint accepts them as input on create.

### 3.4 Job-group matching

On DO create/update, evaluate every active job group of the DO's client. A group matches when every non-empty criteria array contains the DO's corresponding value. Truck type comes from the assigned shipment's vehicle when known, otherwise from `intendedTruckTypeId`; if neither is known, only groups with an empty truck-type criterion can match.

- Exactly one match → assigned (`auto`).
- Several → choose the one with the most non-empty criteria; if still tied → `ambiguous`, planner chooses (`manual`).
- None → `none`, warning.

Matching re-runs when the shipment's vehicle is assigned or changed. A DO must have a job group before its shipment can be **closed** (not before planning). Legacy DOs are exempt.

---

## 4. Rules & validation

**Blocking errors** (request rejected with 422):

- Shipment to `PLANNED` or later without a head (or rigid) vehicle and its driver; or, when the head is a tractor, without a tail and its driver.
- Vehicle in the wrong slot (`head` slot accepts `head`/`rigid`; `tail` slot accepts `tail` only; no tail allowed with a `rigid`).
- Vehicle (head or tail) or driver already on another non-cancelled, non-closed shipment whose `[plannedStart, plannedEnd]` overlaps.
- A DO whose drop stop does not come after its pickup stop, or a DO attached to stops whose locations differ from its origin/destination.
- A DO in more than one active shipment.
- Editing a shipment's stops/DOs/resources after `IN_TRANSIT`.
- Editing a published POD template version.

**Warnings** (saved, returned in `warnings[]`, shown to planner):

- Head driver ≠ tail driver.
- Driver licence expires before `plannedEnd`.
- DO job group `none` or `ambiguous`.
- Large distance gap: client-stated km vs map km beyond threshold (default ±15 %, configurable). Priority between distance sources is decided in Phase 2.
- Stop planned outside a DO's time window.

`POST /shipments/validate` runs the full rule set without saving.

---

## 5. Lifecycle

### 5.1 Shipment

```
DRAFT → PLANNED → DISPATCHED → ACCEPTED → IN_TRANSIT → COMPLETED → CLOSED
                     ↑   │
                     └───┘ declined (reason) → back to PLANNED
CANCELLED: from DRAFT, PLANNED, DISPATCHED, ACCEPTED only
```

| Status | Entry condition | Actor |
|---|---|---|
| DRAFT | created; may be incomplete | planner |
| PLANNED | passes all blocking rules | planner |
| DISPATCHED | dispatch action; records dispatched `version` | planner |
| ACCEPTED / declined | driver response (decline requires reason) | driver |
| IN_TRANSIT | first driver event | system |
| COMPLETED | every DO is `DELIVERED` (POD submitted) or `FAILED` | system |
| CLOSED | every POD `verified`, every non-legacy DO has a job group → Trip Summary created and locked | admin |

Any change to stops/DOs/resources between PLANNED and ACCEPTED increments `version` and returns the shipment to `PLANNED`, requiring re-dispatch.

### 5.2 Delivery Order

```
UNASSIGNED → PLANNED → PICKED_UP → DELIVERED → POD_VERIFIED
                                     └→ POD_REJECTED → (driver resubmits) → DELIVERED
                        FAILED (reason) → re-plan → UNASSIGNED
```

A failed DO keeps its attempt (reason, POD/photos) in `attempts[]` and returns to the pool; it keeps its `doNo`. The failed attempt remains part of the original shipment's evidence.

### 5.3 Stop events

| Pickup stop | Drop stop | Anywhere |
|---|---|---|
| `ARRIVED`, `LOAD_START`, `LOAD_END`, `DEPARTED` | `ARRIVED`, `UNLOAD_START`, `UNLOAD_END`, (POD), `DEPARTED` | `DELAYED`, `BREAKDOWN`, `EXCEPTION`, `CORRECTION` |

- Extra steps come from the DO's POD template `extraSteps` (e.g. `DOCS_SUBMITTED`, `DOCS_RETURNED`, `TEMP_CHECKED`).
- The server enforces order per stop; admin may override with a reason (`source: admin`).
- Events are never edited or deleted; corrections are `CORRECTION` events referencing `correctsEventId`.
- Reason codes (X12 214 / OS&D based): `SHORTAGE`, `OVERAGE`, `DAMAGED`, `REFUSED_FULL`, `REFUSED_PARTIAL`, `CONSIGNEE_CLOSED`, `NO_RECEIVER`, `WRONG_ADDRESS`, `DOCS_MISSING`, `TEMP_OUT_OF_RANGE`, `TRAFFIC`, `BREAKDOWN`, `WEATHER`, `CHECKPOINT`, `OTHER` (requires note).

### 5.4 Location on every driver action

Every driver event, POD and pallet movement **requires** `lat`, `lng`, `accuracyM`, `deviceTime`.

- If the device cannot obtain a fix, the app sends `lat/lng = null` with `noGpsReason: "NO_GPS"`; the server accepts and adds flag `NO_GPS`.
- `accuracyM > 100` → flag `LOW_ACCURACY`.
- Server computes `geofenceDistanceM` to the stop's location; outside `geofenceRadiusM` → flag `OUTSIDE_GEOFENCE`.
- `receivedAt − deviceTime > 6 h` → flag `LATE_SYNC`.

### 5.5 Driver tap vs GPS geofence

The driver's tap (time + lat/lng) is the official record. GPS positions (≈10-minute cadence from the sync jobs) generate **suggested** `ARRIVED`/`DEPARTED` events (`source: geofence`) used for verification only:

- geofence arrival with no driver tap within 30 min → reminder + planner flag;
- tap location outside geofence → flagged for POD reviewer.

### 5.6 Status storage

Shipment, stop and DO statuses are derived from events by a pure function (`lib/status`) on every write and stored denormalised for fast queries. The event log is the source of truth; statuses can be rebuilt from it.

---

## 6. ePOD

### 6.1 POD content

A POD is submitted per DO at its drop stop (also for a failed attempt, with reason code).

- **Form answers** — defined entirely by the client's POD template (fully configurable per client / job group; versioned; a POD records the template version it was filled on).
- **Automatic evidence** (always recorded, not configurable): `deviceTime`, `receivedAt`, `lat/lng/accuracyM`, `geofenceDistanceM`, device + app version, offline flag, file hashes, POD hash.
- Receivers' face photos are not collected (PDPA); templates should ask for goods, seal and document photos.

### 6.2 Files

- `POST /uploads/presign` returns a presigned PUT URL (5-minute expiry) to the private Spaces bucket; key pattern `pods/{shipmentId}/{doId}/{uuid}.{ext}`.
- App compresses images (max 1600 px, JPEG ~80 %, ≤ 5 MB), computes SHA-256, uploads, then submits the POD referencing keys + hashes.
- Server verifies each object exists and its hash matches before accepting the POD.
- Viewing uses presigned GET URLs issued only to authorised roles.

### 6.3 Tamper evidence

`pod.hash = SHA-256(canonical JSON of { doId, templateId, templateVersion, answers, files[].sha256, evidence })`. The evidence PDF prints POD hashes. A POD is immutable after submission; a resubmission is a new POD with `supersedesPodId`.

### 6.4 Review

Admin lists `submitted` PODs (filterable by flags), then verifies or rejects with a reason. Rejection returns the DO to `POD_REJECTED`; the driver resubmits.

### 6.5 Legal basis

Signature image + identity (authenticated driver session) + GPS + timestamps + audit trail is intended to satisfy the Electronic Transactions Act B.E. 2544 s.9. Retention: at least 5 years (Accounting Act — to confirm with finance).

---

## 7. Pallets

- DO may carry a planned pallet type/quantity (`palletPlan`).
- POD templates may include a `palletLines` field capturing per-DO pallet counts (replaces legacy `palletdata`: transfer, change, drop, return, borrow-customer, return-customer).
- Pallet movements (`POST /driver/pallet-movements`, also admin) are append-only. Each movement's type has a sign; within a transaction the server applies `$inc` to `palletBalances` for the tail (or rigid vehicle) and stores `balanceAfter` on the movement.
- Idempotent via `clientEventId`; same GPS requirements as events.
- `GET /pallet-balances` (current balance per vehicle), `GET /pallet-movements` (filtered, paginated; drivers see only their own).

---

## 8. API

### 8.1 Conventions

- Base path `/api/v1`; JSON; timestamps stored and returned as UTC ISO-8601 (frontends display Asia/Bangkok).
- Errors: `{ code, message, details? }`; business warnings in `warnings[]` of successful responses.
- Optimistic concurrency: shipment updates send `version`; mismatch → `409 VERSION_CONFLICT`.
- Idempotency: driver writes carry `clientEventId` / `clientPodId`; replays return the original result.
- Cursor pagination: `?limit=&cursor=`.
- Every mutation writes `auditLog`.
- OpenAPI JSON at `/api/v1/openapi.json`, Swagger UI at `/docs`.

### 8.2 Auth & roles

| Endpoint | Notes |
|---|---|
| `POST /auth/login` | returns access token (1 h) + refresh token; records `lastLogin` with optional lat/lng; rate-limited |
| `POST /auth/refresh` | rotating refresh tokens (reuse → revoke family) |
| `POST /auth/logout`, `GET /me`, `POST /me/password` | |

Roles: `admin` (all, users, POD review, close), `planner` (master data, DOs, shipments, dispatch), `driver` (only shipments where they are head or tail driver; own pallet movements), `viewer` (read-only). Service accounts use `X-API-Key` with scopes.

### 8.3 Endpoints

**Master data** (admin/planner write, all staff read)
- CRUD `/clients`, `/clients/:id/job-groups`, `/zones`, `/locations`, `/materials`, `/service-types`, `/truck-types`, `/vehicles`, `/drivers`, `/users` (admin), `/api-keys` (admin)
- `/pod-templates` — create draft, `POST /pod-templates/:id/publish` (creates immutable version)
- `POST /imports/:entity?dryRun=true` — Excel/CSV import with per-row results

**Delivery orders**
- `POST /delivery-orders`, `POST /delivery-orders/bulk?dryRun=true`
- `GET /delivery-orders?status=&clientId=&jobGroupId=&from=&to=` (planning pool), `GET /delivery-orders/:id`
- `PATCH /delivery-orders/:id` (only before `PICKED_UP`), `POST /delivery-orders/:id/cancel`

**Shipments**
- `POST /shipments/validate` (dry run → errors + warnings)
- `POST /shipments` (optionally with DO ids + ordered stops), `POST /shipments/bulk` (many similar shipments at once, e.g. Mixer round trips), `PATCH /shipments/:id` (with `version`)
- `GET /shipments?from=&to=&status=&vehicleId=&driverId=&truckTypeId=`, `GET /shipments/:id`
- `GET /availability?from=&to=&truckTypeId=` (free vehicles and drivers)
- `POST /shipments/:id/dispatch`, `/cancel`, `/close`
- `GET /shipments/:id/events`, `GET /shipments/:id/summary`, `GET /shipments/:id/summary.pdf`

**Driver**
- `GET /driver/shipments` (active + upcoming, with stops, DOs, POD template per DO)
- `POST /driver/shipments/:id/accept`, `/decline`
- `POST /driver/events` (batch, idempotent)
- `POST /uploads/presign`
- `POST /driver/pods` (idempotent)
- `POST /driver/pallet-movements` (batch, idempotent)

**POD review** (admin)
- `GET /pods?status=&flagged=&shipmentId=`, `GET /pods/:id` (with presigned file URLs)
- `POST /pods/:id/verify`, `POST /pods/:id/reject`

**Pallets**
- `GET /pallet-balances`, `GET /pallet-movements`, `POST /pallet-movements` (admin correction)

**GPS**
- `POST /integrations/gps` (API key, scope `gps:write`) — **payload identical to legacy `POST /gpsdata`** (`plate_master, plate_type, gps_vendor, current_latlng, gps_updated_at, gps_id, status, speed`); upserts `vehiclePositions` and runs geofence suggestions for vehicles on active shipments.
- `POST /gpsdata` — transitional alias of the above (same key requirement).
- `GET /vehicle-positions`

---

## 9. Trip Summary & Phase 2 hooks

On `POST /shipments/:id/close`:

1. Check: status `COMPLETED`, all PODs `verified`, all non-legacy DOs have a job group.
2. Assemble evidence: POD ids + hashes, event timeline, per-leg map/GPS km, per-DO client km, flags.
3. Create `tripSummaries` document with `lines: []`, lock it, generate evidence PDF (pdfmake) to Spaces.
4. Set shipment `CLOSED`.

Phase 2 (not built now) will fill `lines[]` at close time from a versioned rate engine keyed on client → job group → lane/truck type/service, with three line kinds: **company revenue** (per DO), **driver pay ค่าเที่ยว พจส.** (per DO + shipment extras), **cost** (per shipment, allocated to DOs by distance). Rates are snapshotted into the summary; post-close changes are `adjustments[]` with reason and approver. No Phase 1 data-model change is required for this.

---

## 10. Migration from backend-tdm

Script `scripts/migrate-legacy.ts` — idempotent (upsert keyed on legacy ids), `--dry-run`, prints a reconciliation report (source counts, created/updated/skipped with reasons).

| Legacy (Postgres `fleetdata`) | New | Notes |
|---|---|---|
| `userdata` | `users` (+ `drivers` for role `user`) | argon2 hashes copied unchanged → existing passwords keep working; role `user` → `driver` |
| distinct `h_plate`, `t_plate` | `vehicles` (`part` head/tail) | |
| distinct `driver_name` | `drivers` | linked to users by username |
| distinct `locat_recive`/`locat_deliver` (+ `latlng_*`) | `locations` | zone/coordinates cleaned up afterwards |
| `jobdata` | `deliveryOrders` (1 job = 1 DO) + `shipments` (grouped by `group_key`; else 1:1) | `legacy: true`; status mapped; completed jobs → `CLOSED` |
| `ticketdata` | `events` | one event per non-null timestamp with its latlng |
| `palletdata` | POD `palletLines` answers on legacy DOs | |
| `palletlog` | `palletMovements` + recomputed `palletBalances` | balances verified against legacy `v_latest_palletlog` |
| `vehicle_curent_data` | `vehiclePositions` | |

Cutover: (1) new API runs in parallel; (2) GPS sync repos switch URL + add API key; (3) old backend retired when new admin panel and driver app go live.

---

## 11. Testing

- **Unit (Vitest):** overlap detection, stop-order rules, vehicle-slot rules (tractor/tail/rigid), job-group matching, status derivation, geofence distance, POD hash, pallet balance arithmetic, counter formatting.
- **API (Fastify inject + mongodb-memory-server):** end-to-end flow — create DOs → plan → validate → dispatch → accept → events → POD → verify → close → summary; plus idempotent replay, version conflict, driver ownership (403), double-booking (422).
- **Contract:** OpenAPI snapshot test.
- **Migration:** run against a sanitised legacy dump; reconciliation counts must match.
- `scripts/seed.ts` loads realistic demo data (clients, job groups, POD templates per truck type, vehicles, drivers, locations).

---

## 12. Open items (not blocking Phase 1)

- Distance source priority for billing vs driver pay — Phase 2.
- Exact retention period — confirm with finance.
- Separate Mongo cluster vs separate database on existing cluster — decide at provisioning (cost vs isolation).
- Coldchain continuous temperature logging during transit (sensor feed) — later phase; Phase 1 captures temperature at POD via template.
- Mixer high-frequency round trips — `POST /shipments/bulk` covers creation; a dedicated "repeat trip" planning UX is a frontend concern.
