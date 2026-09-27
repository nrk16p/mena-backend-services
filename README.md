# mena-backend-services

Transport operations API for Mena Transport — planning, ePOD, pallets and (later) trip costing, for all clients and truck types (Mixer, Trailer, Feedmill, Coldchain, Side Curtain).

- Spec: `docs/superpowers/specs/2026-09-27-phase1-planning-epod-design.md`
- Plans: `docs/superpowers/plans/`

## Requirements

- Node.js 22 (`.nvmrc`)
- MongoDB 7 running as a replica set (transactions are required)

Local MongoDB with Docker:

```bash
docker run -d --name mongo -p 27017:27017 mongo:7 --replSet rs0
docker exec mongo mongosh --quiet --eval "rs.initiate()"
```

## Setup

```bash
npm install
cp .env.example .env        # then edit secrets
npm run seed                # indexes, truck types, pallet movement types, admin user
npm run seed -- --demo      # optional: demo client, fleet, drivers, users, DOs (see "Demo" below)
npm run dev                 # http://localhost:3000
```

- API base: `http://localhost:3000/api/v1`
- API docs (Swagger UI): `http://localhost:3000/docs`
- OpenAPI JSON: `http://localhost:3000/api/v1/openapi.json`

## API docs

- **`/reference`** (recommended) — [Scalar](https://scalar.com) API reference: searchable, grouped
  into sections (Getting started, Master data, Planning, Driver app, Proof of delivery, Pallets,
  System), with the intro/auth/error/pagination guide and the planner and driver-app walkthroughs
  built into the document's description.
- **`/docs`** — Swagger UI, same underlying OpenAPI document, "try it out" style.
- **`/api/v1/openapi.json`** — the raw OpenAPI 3 document.
- **`npm run openapi`** — regenerates `docs/api/openapi.json` (a committed, pretty-printed,
  key-sorted snapshot of the same document) from the route schemas, without starting the server.
  Run it and commit the result whenever a route's schema, tags, or this file's metadata changes;
  `test/api/openapi-drift.test.ts` fails the test suite if the committed file is stale.
- **Generating frontend TypeScript types** from the committed document:
  ```bash
  npx openapi-typescript docs/api/openapi.json -o apps/shared/api-types.ts
  ```
  (not generated automatically yet — run it yourself when the frontend needs the latest types).

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start with reload (reads `.env`) |
| `npm test` | Run all tests (in-memory MongoDB replica set; first run downloads `mongod`) |
| `npm run typecheck` | TypeScript check |
| `npm run build && npm start` | Production build and start |
| `npm run seed` | Idempotent base data + admin (`SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`) |
| `npm run seed -- --force-admin` | Also reactivates `SEED_ADMIN_USERNAME` (`active: true`) and re-grants the `admin` role if it was demoted, **without changing the password** — recovery for a locked-out admin (see "Last admin lock-out" below) |

## Conventions

- Errors: `{ code, message, details? }`. Validation → 400 `VALIDATION_ERROR`; duplicates → 409 `DUPLICATE_KEY`; business rules → 422 with a specific code.
- Ids are 24-char hex strings; times are UTC ISO-8601.
- Roles: `admin`, `planner`, `driver`, `viewer`. Service integrations use `x-api-key` with scopes.
- Master data is never hard-deleted: `DELETE` sets `active: false`.
- Truck types seeded as rigid (Mixer, Feedmill, Coldchain, Side Curtain) and tractor (Trailer). Add tractor variants (e.g. a Side Curtain trailer) as new truck types.

## Reverse proxy / `TRUST_PROXY`

The login rate limit is keyed by `req.ip` (plus the submitted username). Behind a reverse
proxy, Fastify ignores `X-Forwarded-For` by default, so every request looks like it comes
from the proxy's own IP and all users share one rate-limit bucket. Set `TRUST_PROXY` to
tell Fastify how many hops of `X-Forwarded-For` to trust:

- `false` (default) — no reverse proxy; use the raw socket IP.
- `true` — trust the immediate peer's forwarded chain unconditionally.
- a positive integer — trust exactly that many proxy hops (e.g. `1` for a single
  reverse proxy in front of the app).

**Set `TRUST_PROXY=1` on Render.**

## Last admin lock-out

`PATCH /users/:id` refuses (422 `LAST_ADMIN`) any change — deactivating or removing the
`admin` role, including on yourself — that would leave zero active admins. If that
happens anyway (e.g. the account was disabled some other way), recover with:

```bash
SEED_ADMIN_USERNAME=admin SEED_ADMIN_PASSWORD=irrelevant npm run seed -- --force-admin
```

This reactivates the user and adds back the `admin` role without touching the existing
password.

## Planning (Plan 2)

Flow: create delivery orders (`POST /delivery-orders` or `/delivery-orders/bulk`) → build a shipment (`POST /shipments` with `doIds` for automatic stops, or explicit `stops`) → check it any time with `POST /shipments/validate` → `POST /shipments/:id/plan` → `POST /shipments/:id/dispatch` → the driver accepts or declines (`/driver/shipments/:id/accept|decline`).

- Shipments carry a `version`; send the version you last read with every change. A stale version gets `409 VERSION_CONFLICT`. This includes the driver's accept/decline: send the `version` from the driver's job list, so a plan the planner re-dispatched after the driver last saw it is rejected instead of silently accepted/declined.
- A DRAFT may be incomplete (missing vehicle, driver, stops, DOs come back as warnings) but never conflicting. Planning requires completeness.
- Editing a dispatched or accepted shipment returns it to PLANNED; dispatch it again.
- Mixer round trips: create many shipments at once with `POST /shipments/bulk`.

### Availability: resource blocks, status codes and holidays

- `GET /status-codes` — the two-level catalogue: `level1` is `working` / `not_working`, `code` is the detail (ATMS codes such as `A`, `A50`, `ล`, `ป`; planning codes such as `PM`, `REPAIR`, `TIRE`, `LEAVE`). Codes named `ATMS … (รอยืนยันความหมาย)` need their meaning confirmed by the PO (admin can rename them).
- `POST /resource-blocks` — mark a truck or driver unavailable for a period with a status code. Codes with `blocksAssignment: true` stop assignment; `OTHER` only warns.
- `GET /holidays`, drivers' `weeklyDaysOff` — produce warnings, never block.

## Driver execution and POD (Plan 3)

Once a shipment is `DISPATCHED` and the driver has `ACCEPTED` it, the phone app drives the rest of
the trip through the `driver` role's own endpoints:

- **Photos and signatures:** `POST /uploads/presign` (`{ shipmentId, doId, contentType }`) returns a
  short-lived (300 s) presigned `PUT` `url` plus the `key` to reference it by; the app `PUT`s the
  file straight to that URL (to Spaces, or to `/uploads/local` in memory-storage dev/demo mode),
  then submits the POD referencing that `key` and the file's own SHA-256.
- **POD submission:** `POST /driver/pods` — one POD per delivery order per attempt, with GPS
  evidence, template answers and file references. Submission is idempotent on `clientPodId`: a
  replay of the same id returns the stored POD (`200`) instead of creating a second one (`201`
  the first time). The server re-verifies every file (existence, size, hash) before accepting.
- **Step events:** `POST /driver/events` — batches of up to 100 timeline events (arrival,
  departure, etc.), each idempotent on its own `clientEventId`; a batch can mix already-seen and
  new events safely. A `409 SHIPMENT_CHANGED` result means the shipment moved on (e.g. the
  planner re-dispatched it) while this step was in flight — resend the same event (same
  `clientEventId`) once the app has refreshed its copy of the shipment; the previously-accepted
  events in the same batch are unaffected.
- **POD review:** `GET /pods` / `GET /pods/:id` (any staff role) list and inspect submitted PODs
  (with presigned file links); `POST /pods/:id/verify` and `POST /pods/:id/reject` (admin or
  planner) decide them. A rejected POD can be resubmitted — the new POD's `supersedesPodId` links
  back to the one it replaces.
- **Pallets:** `POST /driver/pallet-movements` records pallet movements against the shipment's
  **tail** vehicle (`tailVehicleId` — the vehicle that actually carries pallets; a rigid truck's
  own vehicle stands in for it), keeping a running per-vehicle balance transactionally.
  `GET /pallet-movements` lists movements; a driver calling it only ever sees their own (whatever
  filter they send), staff can filter by `tailVehicleId`/`driverId`. `POST /pallet-movements`
  (admin) records a manual correction.
- **Close and evidence:** `POST /shipments/:id/close` (admin or planner) locks a completed
  shipment into an immutable trip summary once every delivered/failed DO has a verified POD.
  `GET /shipments/:id/summary` returns that summary as JSON (POD hashes, event count, flags,
  per-leg/per-DO distances); `GET /shipments/:id/summary.pdf` streams the generated Thai evidence
  PDF (`404 NOT_FOUND` if the shipment was never closed, `422 PDF_NOT_READY` if the PDF failed to
  build); `POST /shipments/:id/summary.pdf/regenerate` (same roles as close) rebuilds it.
- **File storage:** `STORAGE_DRIVER=s3` (required in production) uses DigitalOcean Spaces —
  set `SPACES_ENDPOINT`, `SPACES_REGION`, `SPACES_BUCKET`, `SPACES_KEY`, `SPACES_SECRET`.
  `STORAGE_DRIVER=memory` (dev/demo only) keeps files in process memory and serves them back
  through `/uploads/local`, signed the same way as a real presigned URL.
- **Driver accounts:** only an **active** user with the `driver` role holds a `driverId`;
  removing the role, or deactivating the user, releases the link so the driver can be relinked to
  a different account (`PATCH /users/:id`).

### Verifying a POD hash

`pod.hash` is the SHA-256 (hex) of the canonical JSON of:

    { doId, templateId, templateVersion, outcome, reasonCode, note, answers, files, evidence }

- `doId`, `templateId`: 24-character hex strings; `templateId` is `null` when the built-in default form was used.
- `files`: each file as `{ key, sha256, fieldKey }`, ordered by the file `key` (ascending).
- `evidence`: the POD's `evidence` object as returned by `GET /pods/:id`, exactly `{ deviceTime, receivedAt, lat, lng, accuracyM, noGpsReason, geofenceDistanceM, device, appVersion, offline }`, with `deviceTime` and `receivedAt` as ISO-8601 UTC strings.
- Canonical JSON: `JSON.stringify` of each value with object keys sorted ascending at every level (all keys are ASCII), no whitespace, `undefined` members omitted, arrays in their given order.

`outcome`, `reasonCode` and `note` **are** part of the hash (spec §6.3, as amended by ruling
P3-R16): the hash covers what was declared, not only the answers, so none of it can be changed
after submission without breaking the hash. They are also stored on the append-only POD record
for review, alongside `status`/`review` (which are *not* part of the hash, since they're set by
the review step that comes after submission).

## Demo

A ready-to-run demo scenario for a first look from a phone (driver app) and a computer (admin
panel), side by side.

**Prerequisites** — Docker Desktop running, then:

```bash
docker run -d --name mena-mongo -p 27017:27017 mongo:7 --replSet rs0
docker exec mena-mongo mongosh --quiet --eval "rs.initiate()"
```

**`.env`** (see `.env.example`):

```bash
MONGO_URI=mongodb://localhost:27017/mena_demo?replicaSet=rs0&directConnection=true
MONGO_DB=mena_demo
JWT_SECRET=change-me-to-a-long-random-string-at-least-32-chars
API_KEY_PEPPER=change-me-at-least-16-chars
DEMO_PASSWORD=pick-a-password-at-least-8-chars
STORAGE_DRIVER=memory
PUBLIC_BASE_URL=https://<computer-ip>:5174
```

`PUBLIC_BASE_URL` is the computer's LAN address the phone can reach (the driver app's own dev
server) — set `<computer-ip>` to that computer's LAN IP, e.g. `https://192.168.1.102:5174`.
`MONGO_DB=mena_demo` matters beyond naming: `--demo` refuses to run against a database whose name
doesn't look like a dev/demo/test database (guarding against accidentally pointing this at a real
one) unless `--force` is passed.

**Seed and run:**

```bash
npm run seed -- --demo      # requires DEMO_PASSWORD; refuses to run when NODE_ENV=production
npm run dev                  # http://localhost:3000
```

Running it twice is safe — it only ever adds what's missing.

**What it creates:** client `DEMO`; locations `DEMO-PLANT` (a batching plant), `DEMO-SITE-BKK` (a
construction site in Bangkok) and `DEMO-SHOP-KKN` (a shop in Khon Kaen), each with real
coordinates and a `geofenceRadiusM`; a published POD template for the demo job group; six
vehicles (`70-1001`/`70-1002` trailer heads, `71-2001`/`71-2002` tails, `80-3001`/`80-3002` rigid
mixers); two drivers (`DRV-001`, `DRV-002`); three `UNASSIGNED` delivery orders ready to be put on
a shipment; and **one shipment already `DISPATCHED` to demo-driver1** (`plannedStart` = today,
08:00 Bangkok time) so the phone shows a job the moment it logs in — no planning steps needed for
the first look.

**Logins** (password is whatever you set `DEMO_PASSWORD` to):

| Username | Role | Notes |
|---|---|---|
| `demo-admin` | admin | full access, including POD review and close |
| `demo-planner` | planner | planning, POD review and close (same as admin for those) |
| `demo-driver1` | driver | linked to `DRV-001`; already has a dispatched shipment waiting |
| `demo-driver2` | driver | linked to `DRV-002`; no shipment yet — pick one of the 3 unassigned DOs, plan and dispatch it from the admin panel |

## Performance

Every Mongo operation is bounded by `MONGO_TIMEOUT_MS` (default 5000) and the client pool is
capped by `MONGO_MAX_POOL_SIZE` (default 20), so a slow or runaway query fails fast instead of
starving the pool. Reporting and analytics queries must not run against the primary (spec §13);
point them at a secondary or a replica.

Batch jobs (bulk delivery-order/shipment creation, imports) run their whole transaction — not
just one request — inside a single `withTransaction`, so they use the larger
`MONGO_BATCH_TIMEOUT_MS` budget (default 30000) instead of `MONGO_TIMEOUT_MS`.
