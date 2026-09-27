import { createRequire } from 'node:module';
import scalarApiReference from '@scalar/fastify-api-reference';
import swagger, { type FastifyDynamicSwaggerOptions } from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fp from 'fastify-plugin';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

// Tag descriptions shown in the sidebar / operation grouping. Every tag actually used by a
// route (`grep -rn "tags:" src/modules`) must be listed here, or Scalar/Swagger UI show it with
// no description. `x-tagGroups` below controls the sidebar's section order; this list controls
// the wording for each tag.
const TAGS = [
  { name: 'auth', description: 'Login, token refresh/rotation, `/me`, and password change.' },
  { name: 'users', description: 'Staff and driver user accounts (admin only). A user with the `driver` role and a linked `driverId` is who signs in to the driver app.' },
  { name: 'api-keys', description: 'API keys for service-to-service integrations. Send the raw key back as `x-api-key` (see the API keys guide above); scopes gate which endpoints a key may call.' },
  { name: 'client', description: 'Customers (ลูกค้า) that delivery orders are billed to.' },
  { name: 'zone', description: 'Geographic zones (โซน) used to group locations for planning and rates.' },
  { name: 'material', description: 'Materials/products (สินค้า) carried on a delivery order.' },
  { name: 'serviceType', description: 'Service types (ประเภทบริการ), e.g. delivery, pickup, round trip.' },
  { name: 'truckType', description: 'Truck types (ประเภทรถ): rigid (Mixer, Feedmill, Coldchain, Side Curtain) or tractor (Trailer). A vehicle\'s `part` (head/tail/rigid) must match its truck type\'s category.' },
  { name: 'palletMovementType', description: 'Reasons for a pallet movement (ประเภทการเคลื่อนไหวพาเลท), e.g. issue, return, adjustment.' },
  { name: 'location', description: 'Pickup/drop locations (สถานที่) with GPS coordinates and a geofence radius used to validate driver step events.' },
  {
    name: 'driver',
    description:
      'Two different things share this tag name (a naming collision in the source, not intentional): (1) the phone app\'s own endpoints, only callable by a signed-in **driver** — job list, accept/decline, step events, uploads, POD submission; and (2) `GET/POST/PATCH/DELETE /drivers`, the **staff-only master-data CRUD** for driver profiles (name, phone, license, days off). Check each operation\'s path and required role to tell them apart: `/driver/...` and `/uploads/...` are the phone app; plain `/drivers` is master data.',
  },
  { name: 'vehicle', description: 'Trucks (รถ): head/tail/rigid parts, each linked to a truck type. Plates are matched loosely (case, spaces, dashes ignored) to catch duplicates.' },
  { name: 'jobGroup', description: 'Job groups (กลุ่มงาน) — per-client rules that auto-classify delivery orders for planning and reporting; `/clients/:clientId/job-groups/match` previews which group a set of fields would match.' },
  { name: 'statusCode', description: 'Reasons a truck or driver is unavailable: `level1` is `working`/`not_working`, `code` is the detail (ATMS codes like `A`, `A50`; planning codes like `PM`, `REPAIR`, `TIRE`, `LEAVE`).' },
  { name: 'holiday', description: 'Holidays used to produce planning warnings (never block a plan).' },
  { name: 'availability', description: 'Resource blocks — mark a truck or driver unavailable for a period with a status code; blocking codes stop assignment, others only warn.' },
  { name: 'imports', description: 'Bulk import of master data from an uploaded CSV/Excel file, with a dry-run preview before committing.' },
  { name: 'delivery-orders', description: 'Delivery orders (ใบสั่งส่ง, DO) — the unit of work a shipment carries; running number `DO-YYMM-NNNNN`.' },
  { name: 'pod-templates', description: 'Proof-of-delivery form templates (แบบฟอร์ม POD) per job group, versioned; a driver always sees the currently-published version.' },
  {
    name: 'shipments',
    description:
      'Shipments (เที่ยว) — validate, create, plan, dispatch, cancel, the staff-side timeline, and (same tag — no distinct tag exists for these yet) closing a trip and reading back its evidence: `/shipments/:id/close`, `/summary`, `/summary.pdf`, `/summary.pdf/regenerate`.',
  },
  { name: 'pallets', description: 'Pallet movements against a shipment\'s tail vehicle and the running per-vehicle balance; staff can also record a manual correction.' },
  { name: 'pods', description: 'Proof of delivery (POD) review for staff: list, inspect (with presigned file links), verify or reject a submitted POD.' },
  { name: 'system', description: 'Health check.' },
] as const;

const X_TAG_GROUPS = [
  { name: 'Getting started', tags: ['auth', 'users', 'api-keys'] },
  {
    name: 'Master data',
    tags: [
      'client', 'zone', 'material', 'serviceType', 'truckType', 'palletMovementType',
      'location', 'vehicle', 'jobGroup', 'statusCode', 'holiday', 'pod-templates', 'imports',
    ],
  },
  { name: 'Planning', tags: ['delivery-orders', 'availability', 'shipments'] },
  { name: 'Driver app', tags: ['driver'] },
  { name: 'Proof of delivery', tags: ['pods'] },
  { name: 'Pallets', tags: ['pallets'] },
  { name: 'System', tags: ['system'] },
];

const DESCRIPTION = `
Transport operations API for Mena Transport — planning, ePOD (electronic proof of delivery) and
pallet tracking, for all clients and truck types (Mixer, Trailer, Feedmill, Coldchain, Side
Curtain).

Base URL: \`/api/v1\` (every path below is relative to it, except \`/health\`).

## Authentication

- \`POST /auth/login\` with \`{ username, password }\` returns \`{ accessToken, refreshToken }\`.
  Send the access token on every request as \`Authorization: Bearer <accessToken>\`.
- Access tokens are short-lived. When one expires, call \`POST /auth/refresh\` with
  \`{ refreshToken }\` to get a new token pair. **Refresh tokens rotate and are single-use**: each
  refresh returns a new refresh token, and reusing an already-used one is treated as a stolen
  token and revokes the whole family (a short grace window covers a request that raced a retry).
  \`POST /auth/logout\` revokes a single refresh token.
- Service-to-service integrations authenticate with an API key instead: send it as \`x-api-key\`.
  Keys are created with \`POST /api-keys\` (admin only) and carry their own scopes.

## Roles

- **admin** — full access: everything **planner** can do, plus user accounts, API keys, and
  master data writes that \`planner\` cannot make (e.g. deleting/deactivating master records).
- **planner** — plans and dispatches shipments and delivery orders, reviews and closes trips,
  edits most master data. Cannot manage users or API keys.
- **viewer** — read-only across staff endpoints (lists and detail views); cannot create, edit,
  plan, dispatch, review or close anything.
- **driver** — no access to staff endpoints. Only the \`/driver/*\` and \`/uploads/*\` endpoints,
  scoped to their own linked \`driverId\` and their own shipments.

## Errors

Every error response has the shape \`{ code, message, details? }\`. Common codes:

| HTTP | code | Meaning |
|---|---|---|
| 400 | \`VALIDATION_ERROR\` | The request body/query/params failed schema validation; \`details\` has the field errors. |
| 401 | \`UNAUTHORIZED\` (and more specific codes like \`INVALID_TOKEN\`, \`INVALID_CREDENTIALS\`, \`API_KEY_REQUIRED\`) | Missing, invalid or expired credentials. |
| 403 | \`FORBIDDEN\` | Authenticated, but the role/scope doesn't allow this action. |
| 404 | \`NOT_FOUND\` (and \`ROUTE_NOT_FOUND\`) | The resource, or the route itself, doesn't exist. |
| 409 | \`VERSION_CONFLICT\` (and \`DUPLICATE_KEY\`, \`DO_CHANGED\`, ...) | Optimistic-locking conflict — someone else changed it first; refetch and retry. |
| 422 | a specific business-rule code (e.g. \`SHIPMENT_NOT_PLANNED\`, \`PART_CATEGORY_MISMATCH\`, \`LAST_ADMIN\`) | The request is well-formed but violates a business rule. |
| 429 | \`RATE_LIMITED\` | Too many requests (mainly login attempts); retry after the given delay. |

A successful response can still carry \`warnings: [{ code, message, details? }]\` — non-blocking
issues worth surfacing in the UI (e.g. a delivery order with no job group match, or a shipment
missing its driver's weekly day off). Warnings never stop the request from succeeding.

## Optimistic versioning

Shipments (and a few other mutable records) carry an integer \`version\`. Send the \`version\` you
last read back with every change (\`PATCH\`, \`plan\`, \`dispatch\`, \`accept\`, \`decline\`, \`cancel\`,
\`close\`, ...). If it doesn't match the current version — someone else changed the record since
you read it — the request fails with \`409 VERSION_CONFLICT\`; refetch the record and retry with
the new version.

## Pagination

List endpoints take \`limit\` (default 50, max 200) and an opaque \`cursor\`, and return
\`{ items, nextCursor }\`. Pass the previous \`nextCursor\` back to get the next page;
\`nextCursor: null\` means there are no more pages.

## Time and running numbers

All timestamps in requests and responses are UTC ISO-8601 (e.g. \`2026-09-27T08:00:00.000Z\`); the
UI is expected to render them in Asia/Bangkok local time. Human-friendly running numbers —
shipment numbers \`SH-YYMM-NNNNN\` and delivery-order numbers \`DO-YYMM-NNNNN\` — are generated by
the server (Bangkok year/month, a per-prefix-per-month counter); never construct or edit them.

## Idempotent driver writes

The driver app can be offline or retry a request without double-submitting: driver step events
carry a client-generated \`clientEventId\` (UUID) and POD submissions carry a \`clientPodId\` (UUID).
Resubmitting the same id returns the previously-stored result (\`200\`) instead of creating a
duplicate (\`201\` the first time); a batch of events can safely mix already-seen and new ids.

---

## Guide: planner flow

1. Create delivery orders — \`POST /delivery-orders\` (or \`/delivery-orders/bulk\` for many at once).
2. \`POST /shipments/validate\` any time to live-check a draft plan (stops, timing, job groups)
   without saving it — returns \`errors\` (block saving/planning) and \`warnings\` (don't).
3. \`POST /shipments\` to save a draft (incomplete is fine — missing vehicle/driver/stops come
   back as warnings, never as a blocking error).
4. \`POST /shipments/:id/plan\` — requires completeness (no \`errors\`); moves \`DRAFT → PLANNED\`.
5. \`POST /shipments/:id/dispatch\` — re-validates, then moves \`PLANNED → DISPATCHED\` and notifies
   the driver.
6. Watch the trip — \`GET /shipments/:id/events\` for the staff-side timeline as the driver's app
   posts step events.
7. Review proof of delivery — \`GET /pods\` / \`GET /pods/:id\`, then \`POST /pods/:id/verify\` or
   \`POST /pods/:id/reject\` (a rejected POD can be resubmitted; the new one's \`supersedesPodId\`
   links back).
8. \`POST /shipments/:id/close\` once every delivered/failed delivery order has a verified POD —
   locks an immutable trip summary.
9. \`GET /shipments/:id/summary.pdf\` for the generated evidence PDF (POD hashes, event count,
   flags, per-leg/per-DO distances).

## Guide: driver app flow

1. \`GET /driver/shipments\` — the driver's own job list (active jobs, any DO awaiting a POD
   resubmission, and recent completed trips).
2. \`POST /driver/shipments/:id/accept\` with \`{ version }\` (from the job list you just read) —
   or \`/decline\` with a reason. A stale \`version\` (the planner re-dispatched meanwhile) is
   rejected with \`409 VERSION_CONFLICT\` instead of silently accepted.
3. \`POST /driver/events\` — batches of up to 100 step events as the trip progresses:
   \`ARRIVED → UNLOAD_START → UNLOAD_END → LOAD_START → LOAD_END → DEPARTED\` (unload steps only
   for a drop, load steps only for a pickup). Each event carries \`clientEventId\`, GPS fields
   (\`lat\`, \`lng\`, \`accuracyM\`, or \`noGpsReason: "NO_GPS"\` when there's no fix) and \`deviceTime\`
   (ISO-8601, the phone's own clock).
4. For a photo or signature: \`POST /uploads/presign\` with \`{ shipmentId, doId, contentType }\`
   returns a short-lived presigned \`{ url, method: "PUT", headers }\`; \`PUT\` the file bytes
   straight to that \`url\` with those \`headers\`, then compute the SHA-256 of the same bytes to
   reference in the POD.
5. \`POST /driver/pods\` — one POD per delivery order per attempt: \`clientPodId\`, \`outcome\`
   (\`DELIVERED\`/\`FAILED\`), template answers, GPS evidence, and the uploaded files' keys + SHA-256.
6. \`GET /driver/shipments/:id/events\` — the driver's own timeline for a shipment.

---
`.trim();

export default fp(
  async (app) => {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Mena TMS API',
          version: pkg.version,
          description: DESCRIPTION,
        },
        tags: TAGS.map((t) => ({ ...t })),
        components: {
          securitySchemes: {
            bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
          },
        },
        // Read by Scalar's sidebar (and ignored by Swagger UI) to order tags into sections.
        // Not part of @fastify/swagger's own OpenAPI document type, hence the cast.
        'x-tagGroups': X_TAG_GROUPS,
      } as FastifyDynamicSwaggerOptions['openapi'],
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
    await app.register(scalarApiReference, {
      routePrefix: '/reference',
      configuration: {
        theme: 'fastify',
        // The default font stack already renders Thai business terms in descriptions fine;
        // no custom font needed. `hideModels` trims the separate "Models" sidebar section
        // (the zod-generated schemas are already inline on each operation).
        hideModels: true,
      },
    });
    app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  },
  { name: 'openapi' },
);
