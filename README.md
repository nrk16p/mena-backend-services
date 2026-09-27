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
npm run seed -- --demo      # optional demo client, locations, job group, POD template
npm run dev                 # http://localhost:3000
```

- API base: `http://localhost:3000/api/v1`
- API docs (Swagger UI): `http://localhost:3000/docs`
- OpenAPI JSON: `http://localhost:3000/api/v1/openapi.json`

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

## Performance

Every Mongo operation is bounded by `MONGO_TIMEOUT_MS` (default 5000) and the client pool is
capped by `MONGO_MAX_POOL_SIZE` (default 20), so a slow or runaway query fails fast instead of
starving the pool. Reporting and analytics queries must not run against the primary (spec §13);
point them at a secondary or a replica.

Batch jobs (bulk delivery-order/shipment creation, imports) run their whole transaction — not
just one request — inside a single `withTransaction`, so they use the larger
`MONGO_BATCH_TIMEOUT_MS` budget (default 30000) instead of `MONGO_TIMEOUT_MS`.
