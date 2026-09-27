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

## Conventions

- Errors: `{ code, message, details? }`. Validation → 400 `VALIDATION_ERROR`; duplicates → 409 `DUPLICATE_KEY`; business rules → 422 with a specific code.
- Ids are 24-char hex strings; times are UTC ISO-8601.
- Roles: `admin`, `planner`, `driver`, `viewer`. Service integrations use `x-api-key` with scopes.
- Master data is never hard-deleted: `DELETE` sets `active: false`.
- Truck types seeded as rigid (Mixer, Feedmill, Coldchain, Side Curtain) and tractor (Trailer). Add tractor variants (e.g. a Side Curtain trailer) as new truck types.
