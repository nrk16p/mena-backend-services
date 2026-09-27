# Plan 1 — Foundation, Auth & Master Data — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable Fastify + MongoDB API where an admin can log in, manage users/API keys, and set up all master data (clients, job groups, zones, locations, materials, service types, truck types, vehicles, drivers, pallet movement types, POD templates), including Excel/CSV import and job-group matching.

**Architecture:** One Fastify 5 app (`buildApp(config)`) with fastify-plugin plugins for cross-cutting concerns (errors, OpenAPI, Mongo, rate limit, auth) and one route plugin per module under `/api/v1`. Zod schemas drive validation, serialization and OpenAPI. Simple master-data collections share one generic resource factory; job groups, POD templates and imports have dedicated modules. MongoDB native driver; ObjectIds in the DB, 24-hex strings in the API.

**Tech Stack:** Node.js 22, TypeScript 5 (ESM, NodeNext), Fastify 5, zod 3, fastify-type-provider-zod 4, mongodb 6, @fastify/jwt 9, @fastify/rate-limit 10, @fastify/swagger 9 + swagger-ui 5, @fastify/multipart 9, argon2, exceljs, csv-parse, Vitest 3 + mongodb-memory-server 10 (replica set).

**Spec:** `docs/superpowers/specs/2026-09-27-phase1-planning-epod-design.md` (roadmap: `docs/superpowers/plans/2026-09-27-roadmap.md`)

**Deliberate simplifications vs spec (flag to PO at handoff):**
- Driver ↔ user link is stored once, on `users.driverId` (spec lists `drivers.userId` too; storing one side prevents drift).
- Job groups do not store `podTemplateId`; the POD template for a DO is resolved by `(clientId, jobGroupId)` with fallback to the client default (spec listed both directions).
- `DELETE` on master data deactivates (`active: false`) instead of removing, because operational documents reference master data.

## Global Constraints

- Node.js `>=22`; TypeScript `strict`; ESM with `"module": "NodeNext"` — **relative imports must end in `.js`**.
- Pin: `fastify@^5`, `zod@^3.23`, `fastify-type-provider-zod@^4`, `mongodb@^6`. If npm reports a peer-dependency conflict between these, stop and report it instead of forcing.
- Base path `/api/v1`. Error body is always `{ code, message, details? }`.
- API ids are 24-char hex strings; DB references are `ObjectId`. Timestamps are stored as `Date` and returned as UTC ISO-8601 strings.
- Roles: `admin`, `planner`, `driver`, `viewer`. Master data: write = admin/planner (pallet movement types: admin only), read = admin/planner/viewer.
- Access token lifetime 1 h (`ACCESS_TOKEN_TTL_SEC=3600`); refresh tokens rotate on every use.
- Secrets only from environment variables; `.env*` is git-ignored (`.env.example` excepted).
- Every mutation writes one `auditLog` document. Password hashes never appear in API responses or audit entries.
- Server-generated running numbers (`SH-YYMM-NNNNN`, `DO-YYMM-NNNNN`, YYMM in Asia/Bangkok) are never accepted as input.
- Tests: Vitest against `MongoMemoryReplSet` (transactions needed in Plan 3). Each test file uses its own database.
- Commits: conventional messages ending with the trailer lines below. **Never `git push`** — the PO approves pushes.

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6
```

## Review Focus

1. **Flaky mobile network retries a refresh** (same refresh token sent twice within seconds) → both succeed within `REFRESH_REUSE_GRACE_SEC` (30 s); outside the window it is treated as token theft and the whole family is revoked. Test in Task 5.
2. **User deactivated while holding a valid access token** → the very next request returns 401, not after token expiry. Test in Task 4.
3. **Plates typed with different spacing/case** (`" 70-1234 "`, `"70-1234"`, `"ab 1234"` vs `"AB 1234"`) → treated as the same vehicle: duplicate create is 409 and import updates instead of creating. Tests in Tasks 8 and 11.
4. **Running numbers near midnight at month end** (e.g. 2026-09-30 17:30 UTC = 2026-10-01 00:30 Bangkok) → prefix uses the Bangkok month (`2610`). Test in Task 3.
5. **Excel/CSV quirks from Thai users** — UTF-8 BOM, Thai text, numeric cells (lat/lng as numbers), formula cells → parsed as their displayed value; a row with an unknown reference code is reported and nothing is saved. Test in Task 11.

---

## File Structure

```
package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts, .env.example, .nvmrc, README.md
src/
  server.ts                    process entry (listen + graceful shutdown)
  app.ts                       buildApp(config): plugins + routes
  config.ts                    env → typed Config (zod)
  routes.ts                    apiRoutes: registers every module under /api/v1
  types/fastify.d.ts           FastifyInstance decorations (config, mongo, db)
  db/collections.ts            collection-name constants (C)
  db/indexes.ts                INDEXES registry + ensureIndexes(db)
  lib/errors.ts                AppError + helpers
  lib/ids.ts                   objectIdString, IdParams
  lib/serialize.ts             toApi (ObjectId/Date/_id → API shape)
  lib/pagination.ts            PageQuery, pageResponse, paginate
  lib/regex.ts                 escapeRegex
  lib/counters.ts              bangkokYYMM, nextNumber
  lib/roles.ts                 ROLES, Role, STAFF_ROLES
  lib/principal.ts             Principal types
  lib/passwords.ts             hashPassword, verifyPassword, dummyHash
  lib/audit.ts                 actorOf, writeAudit
  plugins/errors.ts            error + not-found handlers
  plugins/openapi.ts           swagger, /docs, /api/v1/openapi.json
  plugins/mongo.ts             MongoClient lifecycle + ensureIndexes
  plugins/auth.ts              @fastify/jwt, requireRoles, requireScope
  modules/users/users.repo.ts      UserDoc, createUser, findUserByUsername, userOut
  modules/users/users.routes.ts    /users admin CRUD
  modules/auth/refresh-tokens.ts   issue/rotate/revoke refresh tokens
  modules/auth/auth.service.ts     issueTokens
  modules/auth/auth.routes.ts      /auth/login, /auth/refresh, /auth/logout, /me, /me/password
  modules/api-keys/api-keys.service.ts  createApiKey, authenticateApiKey
  modules/api-keys/api-keys.routes.ts   /api-keys
  modules/master/resource.ts       generic ResourceDef + prepareDoc + resourceRoutes
  modules/master/simple.ts         clients, zones, materials, service types, truck types, pallet movement types
  modules/master/locations.ts      locations
  modules/master/fleet.ts          vehicles, drivers, normalizePlate
  modules/master/job-group-match.ts  pure matching
  modules/master/job-groups.ts     job group def, matchJobGroupForDo, match route
  modules/master/master.routes.ts  registers all master resources
  modules/pod-templates/pod-templates.schemas.ts
  modules/pod-templates/pod-templates.service.ts   resolvePodTemplate
  modules/pod-templates/pod-templates.routes.ts
  modules/imports/parse.ts         parseTable (csv/xlsx)
  modules/imports/specs.ts         per-entity import specs
  modules/imports/imports.service.ts  runImport
  modules/imports/imports.routes.ts   /imports/:entity
  seed/seed.ts                     seedBase, seedAdmin, seedDemo
scripts/seed.ts
test/
  global-setup.ts, helpers/app.ts, helpers/db.ts, helpers/auth.ts, helpers/multipart.ts
  unit/*.test.ts, api/*.test.ts
```

---

### Task 1: Project skeleton, config, Mongo, health, test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.env.example`, `.nvmrc`
- Create: `src/config.ts`, `src/app.ts`, `src/server.ts`, `src/types/fastify.d.ts`, `src/db/collections.ts`, `src/db/indexes.ts`, `src/plugins/mongo.ts`
- Create: `test/global-setup.ts`, `test/helpers/app.ts`, `test/helpers/db.ts`
- Test: `test/unit/config.test.ts`, `test/api/health.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?) → Config`; `Config` fields `NODE_ENV, HOST, PORT, LOG_LEVEL, MONGO_URI, MONGO_DB, JWT_SECRET, ACCESS_TOKEN_TTL_SEC, REFRESH_TOKEN_TTL_DAYS, REFRESH_REUSE_GRACE_SEC, API_KEY_PEPPER, LOGIN_RATE_LIMIT_PER_MIN`; `buildApp(config) → Promise<App>`; `type App`; `app.config`, `app.mongo`, `app.db`; `C` collection names; `INDEXES` registry + `ensureIndexes(db)`; test helpers `buildTestApp(env?)`, `closeTestApp(app)`, `testDb()`.

- [ ] **Step 1: Create project files**

`package.json`:
```json
{
  "name": "mena-backend-services",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch --env-file=.env src/server.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/server.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "seed": "tsx --env-file=.env scripts/seed.ts"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "scripts", "test", "vitest.config.ts"]
}
```

`tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 120_000,
  },
});
```

`.env.example`:
```
NODE_ENV=development
PORT=3000
LOG_LEVEL=info
MONGO_URI=mongodb://localhost:27017/?replicaSet=rs0
MONGO_DB=mena_backend_services
JWT_SECRET=change-me-to-a-long-random-string-at-least-32-chars
API_KEY_PEPPER=change-me-at-least-16-chars
SEED_ADMIN_USERNAME=admin
SEED_ADMIN_PASSWORD=change-me-now
```

`.nvmrc`:
```
22
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
npm i fastify@^5 fastify-plugin@^5 fastify-type-provider-zod@^4 zod@^3.23 mongodb@^6
npm i -D typescript@^5.6 tsx@^4 vitest@^3 mongodb-memory-server@^10 @types/node@^22
```
Expected: installs without peer-dependency errors. (The first test run downloads a `mongod` binary, ~100 MB.)

- [ ] **Step 3: Write the test harness**

`test/global-setup.ts`:
```ts
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

export default async function setup(project: TestProject) {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  project.provide('mongoUri', rs.getUri());
  return async () => {
    await rs.stop();
  };
}
```

`test/helpers/app.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { buildApp, type App } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  JWT_SECRET: 'test-secret-test-secret-test-secret-0000',
  API_KEY_PEPPER: 'test-pepper-000000',
  LOGIN_RATE_LIMIT_PER_MIN: '1000',
};

export async function buildTestApp(env: Record<string, string> = {}): Promise<App> {
  const config = loadConfig({
    ...TEST_ENV,
    MONGO_URI: inject('mongoUri'),
    MONGO_DB: `t_${randomUUID().replaceAll('-', '')}`,
    ...env,
  });
  const app = await buildApp(config);
  await app.ready();
  return app;
}

export async function closeTestApp(app: App): Promise<void> {
  await app.db.dropDatabase();
  await app.close();
}
```

`test/helpers/db.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { inject } from 'vitest';

export async function testDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = await MongoClient.connect(inject('mongoUri'));
  const db = client.db(`t_${randomUUID().replaceAll('-', '')}`);
  return {
    db,
    close: async () => {
      await db.dropDatabase();
      await client.close();
    },
  };
}
```

- [ ] **Step 4: Write the failing tests**

`test/unit/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const base = {
  MONGO_URI: 'mongodb://localhost:27017',
  MONGO_DB: 'x',
  JWT_SECRET: 'a'.repeat(32),
  API_KEY_PEPPER: 'p'.repeat(16),
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.PORT).toBe(3000);
    expect(c.ACCESS_TOKEN_TTL_SEC).toBe(3600);
    expect(c.REFRESH_TOKEN_TTL_DAYS).toBe(30);
    expect(c.REFRESH_REUSE_GRACE_SEC).toBe(30);
    expect(c.NODE_ENV).toBe('development');
  });

  it('rejects a missing JWT_SECRET', () => {
    const { JWT_SECRET: _omit, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/JWT_SECRET/);
  });

  it('rejects a short JWT_SECRET', () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('coerces numeric env values', () => {
    expect(loadConfig({ ...base, PORT: '8080' }).PORT).toBe(8080);
  });
});
```

`test/api/health.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';

describe('GET /health', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await closeTestApp(app);
  });

  it('returns ok when Mongo is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run test/unit/config.test.ts test/api/health.test.ts`
Expected: FAIL — cannot resolve `../../src/config.js` / `../../src/app.js`.

- [ ] **Step 6: Implement**

`src/config.ts`:
```ts
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  MONGO_URI: z.string().min(1),
  MONGO_DB: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(3600),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  REFRESH_REUSE_GRACE_SEC: z.coerce.number().int().min(0).default(30),
  API_KEY_PEPPER: z.string().min(16),
  LOGIN_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}
```

`src/types/fastify.d.ts`:
```ts
import type { Db, MongoClient } from 'mongodb';
import type { Config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    mongo: MongoClient;
    db: Db;
  }
}
```

`src/db/collections.ts`:
```ts
export const C = {
  counters: 'counters',
  users: 'users',
  refreshTokens: 'refreshTokens',
  apiKeys: 'apiKeys',
  auditLog: 'auditLog',
  clients: 'clients',
  jobGroups: 'jobGroups',
  zones: 'zones',
  locations: 'locations',
  materials: 'materials',
  serviceTypes: 'serviceTypes',
  truckTypes: 'truckTypes',
  vehicles: 'vehicles',
  drivers: 'drivers',
  palletMovementTypes: 'palletMovementTypes',
  podTemplates: 'podTemplates',
} as const;
```

`src/db/indexes.ts`:
```ts
import type { Db, IndexDescription } from 'mongodb';

// Each task adds its collection's indexes here.
export const INDEXES: Record<string, IndexDescription[]> = {};

export async function ensureIndexes(db: Db): Promise<void> {
  for (const [name, specs] of Object.entries(INDEXES)) {
    if (specs.length > 0) await db.collection(name).createIndexes(specs);
  }
}
```

`src/plugins/mongo.ts`:
```ts
import fp from 'fastify-plugin';
import { MongoClient } from 'mongodb';
import { ensureIndexes } from '../db/indexes.js';

export default fp(
  async (app) => {
    const client = new MongoClient(app.config.MONGO_URI);
    await client.connect();
    const db = client.db(app.config.MONGO_DB);
    await ensureIndexes(db);
    app.decorate('mongo', client);
    app.decorate('db', db);
    app.addHook('onClose', async () => {
      await client.close();
    });
  },
  { name: 'mongo' },
);
```

`src/app.ts`:
```ts
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import mongoPlugin from './plugins/mongo.js';

export async function buildApp(config: Config) {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: config.LOG_LEVEL },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('config', config);

  await app.register(mongoPlugin);

  app.get('/health', async () => {
    await app.db.command({ ping: 1 });
    return { status: 'ok' };
  });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
```

`src/server.ts`:
```ts
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp(config);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/unit/config.test.ts test/api/health.test.ts && npm run typecheck`
Expected: 5 tests PASS; typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: project skeleton with config, Mongo plugin, health check and test harness" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 2: Errors, ids, serialization, pagination, OpenAPI

**Files:**
- Create: `src/lib/errors.ts`, `src/lib/ids.ts`, `src/lib/serialize.ts`, `src/lib/pagination.ts`, `src/lib/regex.ts`, `src/plugins/errors.ts`, `src/plugins/openapi.ts`
- Modify: `src/app.ts`
- Test: `test/api/errors.test.ts`, `test/unit/serialize.test.ts`, `test/unit/pagination.test.ts`, `test/api/openapi.test.ts`

**Interfaces:**
- Consumes: `buildApp`, `testDb`, `buildTestApp` (Task 1).
- Produces:
  - `class AppError(statusCode: number, code: string, message: string, details?: unknown)`; helpers `badRequest(code, message, details?)`, `unauthorized(message?, code?)`, `forbidden(message?)`, `notFound(what)`, `conflict(code, message, details?)`, `unprocessable(code, message, details?)`.
  - `objectIdString` (zod), `IdParams = z.object({ id })`.
  - `toApi(value: unknown): any` — `_id`→`id`, `ObjectId`→hex, `Date`→ISO string, recursive.
  - `PageQuery` (zod: `limit` 1–200 default 50, `cursor?`), `type PageParams = { limit: number; cursor?: string }`, `pageResponse(itemSchema)`, `paginate(coll, filter, page) → { items, nextCursor }`.
  - `escapeRegex(s)`.
  - Error responses: AppError → its status/code; schema validation → 400 `VALIDATION_ERROR`; Mongo duplicate key → 409 `DUPLICATE_KEY`; unknown route → 404 `ROUTE_NOT_FOUND`; other 4xx → passthrough; else 500 `INTERNAL_ERROR` (no internals leaked).
  - `GET /api/v1/openapi.json`, Swagger UI at `/docs`.

- [ ] **Step 1: Install**

Run: `npm i @fastify/swagger@^9 @fastify/swagger-ui@^5`

- [ ] **Step 2: Write the failing tests**

`test/api/errors.test.ts`:
```ts
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../src/lib/errors.js';
import errorsPlugin from '../../src/plugins/errors.js';

describe('errors plugin', () => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();

  beforeAll(async () => {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorsPlugin);
    app.get('/app-error', async () => {
      throw new AppError(422, 'SOMETHING_WRONG', 'Bad thing', { a: 1 });
    });
    app.post('/validated', { schema: { body: z.object({ n: z.number() }) } }, async () => ({ ok: true }));
    app.get('/dup', async () => {
      throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000, keyValue: { code: 'X' } });
    });
    app.get('/boom', async () => {
      throw new Error('secret internals');
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('maps AppError', async () => {
    const res = await app.inject({ method: 'GET', url: '/app-error' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ code: 'SOMETHING_WRONG', message: 'Bad thing', details: { a: 1 } });
  });

  it('maps schema validation to 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({ method: 'POST', url: '/validated', payload: { n: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('maps duplicate key to 409', async () => {
    const res = await app.inject({ method: 'GET', url: '/dup' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'DUPLICATE_KEY', details: { code: 'X' } });
  });

  it('hides internals on 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  it('returns ROUTE_NOT_FOUND for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('ROUTE_NOT_FOUND');
  });
});
```

`test/unit/serialize.test.ts`:
```ts
import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { toApi } from '../../src/lib/serialize.js';

describe('toApi', () => {
  it('converts _id, ObjectIds and Dates recursively', () => {
    const id = new ObjectId();
    const ref = new ObjectId();
    const at = new Date('2026-09-27T01:02:03.000Z');
    expect(
      toApi({ _id: id, zoneId: ref, createdAt: at, nested: { list: [ref, { at }] }, n: 1, s: 'x', nil: null }),
    ).toEqual({
      id: id.toHexString(),
      zoneId: ref.toHexString(),
      createdAt: '2026-09-27T01:02:03.000Z',
      nested: { list: [ref.toHexString(), { at: '2026-09-27T01:02:03.000Z' }] },
      n: 1,
      s: 'x',
      nil: null,
    });
  });
});
```

`test/unit/pagination.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import { paginate } from '../../src/lib/pagination.js';
import { testDb } from '../helpers/db.js';

describe('paginate', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await testDb());
    await db.collection('items').insertMany(Array.from({ length: 5 }, (_, i) => ({ n: i, even: i % 2 === 0 })));
  });
  afterAll(async () => close());

  it('pages through results by cursor', async () => {
    const coll = db.collection('items');
    const p1 = await paginate(coll, {}, { limit: 2 });
    expect(p1.items.map((d) => d.n)).toEqual([0, 1]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await paginate(coll, {}, { limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((d) => d.n)).toEqual([2, 3]);
    const p3 = await paginate(coll, {}, { limit: 2, cursor: p2.nextCursor! });
    expect(p3.items.map((d) => d.n)).toEqual([4]);
    expect(p3.nextCursor).toBeNull();
  });

  it('combines cursor with a filter', async () => {
    const coll = db.collection('items');
    const p1 = await paginate(coll, { even: true }, { limit: 1 });
    const p2 = await paginate(coll, { even: true }, { limit: 5, cursor: p1.nextCursor! });
    expect(p2.items.map((d) => d.n)).toEqual([2, 4]);
  });
});
```

`test/api/openapi.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';

describe('OpenAPI', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => closeTestApp(app));

  it('serves the OpenAPI document', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBe('mena-backend-services');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/api/errors.test.ts test/unit/serialize.test.ts test/unit/pagination.test.ts test/api/openapi.test.ts`
Expected: FAIL — modules not found / 404 on openapi.json.

- [ ] **Step 4: Implement libs**

`src/lib/errors.ts`:
```ts
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required', code = 'UNAUTHORIZED') =>
  new AppError(401, code, message);
export const forbidden = (message = 'You do not have permission for this action') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);
```

`src/lib/ids.ts`:
```ts
import { z } from 'zod';

export const objectIdString = z.string().regex(/^[a-f0-9]{24}$/i, 'must be a 24-character hex id');
export const IdParams = z.object({ id: objectIdString });
```

`src/lib/serialize.ts`:
```ts
import { ObjectId } from 'mongodb';

// Converts a Mongo document into its API shape. Returns `any` so route handlers
// can return it directly; the route's zod response schema is the real contract.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toApi(value: unknown): any {
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toApi);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k === '_id' ? 'id' : k] = toApi(v);
    return out;
  }
  return value;
}
```

`src/lib/regex.ts`:
```ts
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

`src/lib/pagination.ts`:
```ts
import { ObjectId, type Collection, type Document, type Filter, type WithId } from 'mongodb';
import { z } from 'zod';
import { objectIdString } from './ids.js';

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: objectIdString.optional(),
});

export type PageParams = { limit: number; cursor?: string };

export function pageResponse<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

export async function paginate<T extends Document>(
  coll: Collection<T>,
  filter: Filter<T>,
  page: PageParams,
): Promise<{ items: WithId<T>[]; nextCursor: string | null }> {
  const f = (page.cursor ? { $and: [filter, { _id: { $gt: new ObjectId(page.cursor) } }] } : filter) as Filter<T>;
  const docs = await coll.find(f).sort({ _id: 1 }).limit(page.limit + 1).toArray();
  const hasMore = docs.length > page.limit;
  const items = hasMore ? docs.slice(0, page.limit) : docs;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? (last._id as unknown as ObjectId).toHexString() : null };
}
```

- [ ] **Step 5: Implement plugins and wire them**

`src/plugins/errors.ts`:
```ts
import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';

export default fp(
  async (app) => {
    app.setNotFoundHandler((req, reply) =>
      reply.status(404).send({ code: 'ROUTE_NOT_FOUND', message: `Route ${req.method} ${req.url} not found` }),
    );

    app.setErrorHandler((err, req, reply) => {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send({ code: err.code, message: err.message, details: err.details });
      }
      if (err.validation) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', message: err.message, details: err.validation });
      }
      if ((err as { code?: unknown }).code === 11000) {
        return reply.status(409).send({
          code: 'DUPLICATE_KEY',
          message: 'A record with the same unique key already exists',
          details: (err as { keyValue?: unknown }).keyValue,
        });
      }
      const status = err.statusCode ?? 500;
      if (status < 500) {
        return reply.status(status).send({ code: err.code ?? 'BAD_REQUEST', message: err.message });
      }
      req.log.error({ err }, 'unhandled error');
      return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
    });
  },
  { name: 'errors' },
);
```

`src/plugins/openapi.ts`:
```ts
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fp from 'fastify-plugin';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

export default fp(
  async (app) => {
    await app.register(swagger, {
      openapi: {
        info: { title: 'mena-backend-services', version: '0.1.0' },
        components: {
          securitySchemes: {
            bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
          },
        },
      },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
    app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  },
  { name: 'openapi' },
);
```

Replace the plugin section of `src/app.ts` so it reads:
```ts
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import errorsPlugin from './plugins/errors.js';
import mongoPlugin from './plugins/mongo.js';
import openapiPlugin from './plugins/openapi.js';

export async function buildApp(config: Config) {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: config.LOG_LEVEL },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('config', config);

  await app.register(errorsPlugin);
  await app.register(openapiPlugin);
  await app.register(mongoPlugin);

  app.get('/health', { schema: { tags: ['system'] } }, async () => {
    await app.db.command({ ping: 1 });
    return { status: 'ok' };
  });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all tests PASS; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: error envelope, id/serialization/pagination helpers and OpenAPI docs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 3: Running-number counters

**Files:**
- Create: `src/lib/counters.ts`
- Test: `test/unit/counters.test.ts`

**Interfaces:**
- Consumes: `C.counters`, `testDb`.
- Produces: `bangkokYYMM(d: Date): string`; `type CounterPrefix = 'SH' | 'DO'`; `nextNumber(db: Db, prefix: CounterPrefix, now?: Date): Promise<string>` returning e.g. `SH-2609-00001`. Used by Plan 2.

- [ ] **Step 1: Write the failing test**

`test/unit/counters.test.ts`:
```ts
import type { Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bangkokYYMM, nextNumber } from '../../src/lib/counters.js';
import { testDb } from '../helpers/db.js';

describe('bangkokYYMM', () => {
  it('uses Asia/Bangkok month, not UTC', () => {
    expect(bangkokYYMM(new Date('2026-09-30T16:59:59Z'))).toBe('2609'); // 23:59:59 BKK
    expect(bangkokYYMM(new Date('2026-09-30T17:30:00Z'))).toBe('2610'); // 00:30 BKK next day
    expect(bangkokYYMM(new Date('2026-12-31T17:00:00Z'))).toBe('2701');
  });
});

describe('nextNumber', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await testDb());
  });
  afterAll(async () => close());

  const sep = new Date('2026-09-15T03:00:00Z');

  it('increments per prefix and month with 5-digit padding', async () => {
    expect(await nextNumber(db, 'SH', sep)).toBe('SH-2609-00001');
    expect(await nextNumber(db, 'SH', sep)).toBe('SH-2609-00002');
    expect(await nextNumber(db, 'DO', sep)).toBe('DO-2609-00001');
    expect(await nextNumber(db, 'SH', new Date('2026-09-30T17:30:00Z'))).toBe('SH-2610-00001');
  });

  it('never hands out the same number under concurrency', async () => {
    const at = new Date('2026-11-05T03:00:00Z');
    const numbers = await Promise.all(Array.from({ length: 50 }, () => nextNumber(db, 'DO', at)));
    expect(new Set(numbers).size).toBe(50);
    expect(numbers.every((n) => /^DO-2611-\d{5}$/.test(n))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/counters.test.ts`
Expected: FAIL — cannot resolve `counters.js`.

- [ ] **Step 3: Implement**

`src/lib/counters.ts`:
```ts
import type { Db } from 'mongodb';
import { C } from '../db/collections.js';

const bkk = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', year: '2-digit', month: '2-digit' });

export function bangkokYYMM(d: Date): string {
  const parts = bkk.formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  if (!year || !month) throw new Error('Failed to format Bangkok date');
  return `${year}${month}`;
}

export type CounterPrefix = 'SH' | 'DO';

export async function nextNumber(db: Db, prefix: CounterPrefix, now: Date = new Date()): Promise<string> {
  const key = `${prefix}-${bangkokYYMM(now)}`;
  const doc = await db
    .collection<{ _id: string; seq: number }>(C.counters)
    .findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  if (!doc) throw new Error(`Counter ${key} was not returned`);
  return `${key}-${String(doc.seq).padStart(5, '0')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/counters.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: atomic running-number counters in Bangkok month" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 4: Users, passwords, login, role guard, audit

**Files:**
- Create: `src/lib/roles.ts`, `src/lib/principal.ts`, `src/lib/passwords.ts`, `src/lib/audit.ts`, `src/modules/users/users.repo.ts`, `src/modules/auth/refresh-tokens.ts`, `src/modules/auth/auth.service.ts`, `src/modules/auth/auth.routes.ts`, `src/plugins/auth.ts`, `src/routes.ts`
- Create: `test/helpers/auth.ts`
- Modify: `src/app.ts`, `src/db/indexes.ts`
- Test: `test/unit/passwords.test.ts`, `test/api/auth-login.test.ts`

**Interfaces:**
- Consumes: Task 1–2 helpers, `C`.
- Produces:
  - `ROLES`, `type Role = 'admin'|'planner'|'driver'|'viewer'`, `STAFF_ROLES: Role[] = ['admin','planner','viewer']`.
  - `type UserPrincipal = { kind:'user'; userId: string; username: string; roles: Role[]; driverId: string|null }`, `type ApiKeyPrincipal = { kind:'apiKey'; keyId: string; name: string; scopes: string[] }`, `type Principal`.
  - `hashPassword(pw)`, `verifyPassword(hash, pw) → boolean` (never throws), `dummyHash()`.
  - `interface UserDoc { _id; username; passwordHash; roles; driverId: ObjectId|null; active; lastLogin: {at; lat; lng}|null; createdAt; updatedAt }`, `createUser(db, {username, password, roles, driverId?})`, `findUserByUsername(db, username)`, `findUserById(db, id)`, `userOut(u) → { id, username, roles, driverId }`, `UserOutSchema`.
  - `issueRefreshToken(db, userId, ttlDays, familyId?) → string` (format `<24hex>.<secret>`).
  - `issueTokens(app, user, familyId?) → { accessToken, refreshToken, tokenType:'Bearer', expiresIn, user }`, `TokenResponseSchema`.
  - `app.requireRoles(...roles)` preHandler; no roles = any authenticated user. Sets `req.principal`.
  - `actorOf(req) → string`, `writeAudit(db, { entity, entityId, action, by, before?, after? })`.
  - `apiRoutes` plugin (registered at `/api/v1`), `POST /auth/login`, `GET /me`.
  - Test helper `createUserAndLogin(app, roles, opts?) → { user, token, refreshToken, headers }`.

- [ ] **Step 1: Install**

Run: `npm i @fastify/jwt@^9 @fastify/rate-limit@^10 argon2@^0.41`

- [ ] **Step 2: Write the failing tests**

`test/unit/passwords.test.ts`:
```ts
import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/lib/passwords.js';

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashPassword('s3cret-pass');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 's3cret-pass')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
  });

  it('verifies legacy argon2 variants (backend-tdm used passlib argon2)', async () => {
    const legacy = await argon2.hash('legacy-pass', { type: argon2.argon2i, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    expect(await verifyPassword(legacy, 'legacy-pass')).toBe(true);
  });

  it('returns false instead of throwing on a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});
```

`test/helpers/auth.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import type { App } from '../../src/app.js';
import type { Role } from '../../src/lib/roles.js';
import { createUser, type UserDoc } from '../../src/modules/users/users.repo.js';

export const TEST_PASSWORD = 'Passw0rd!123';

export async function createUserAndLogin(
  app: App,
  roles: Role[],
  opts: { username?: string; driverId?: ObjectId | null } = {},
): Promise<{ user: UserDoc; token: string; refreshToken: string; headers: { authorization: string } }> {
  const username = opts.username ?? `u_${randomUUID().slice(0, 8)}`;
  const user = await createUser(app.db, { username, password: TEST_PASSWORD, roles, driverId: opts.driverId ?? null });
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  const body = res.json();
  return { user, token: body.accessToken, refreshToken: body.refreshToken, headers: { authorization: `Bearer ${body.accessToken}` } };
}
```

`test/api/auth-login.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { createUser } from '../../src/modules/users/users.repo.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { TEST_PASSWORD, createUserAndLogin } from '../helpers/auth.js';

describe('login and /me', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => closeTestApp(app));

  it('logs in, returns a 1-hour access token and records lastLogin', async () => {
    await createUser(app.db, { username: 'planner1', password: TEST_PASSWORD, roles: ['planner'] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'planner1', password: TEST_PASSWORD, lat: 13.75, lng: 100.5 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ tokenType: 'Bearer', expiresIn: 3600, user: { username: 'planner1', roles: ['planner'], driverId: null } });
    expect(body.refreshToken).toMatch(/^[a-f0-9]{24}\./);
    const claims = app.jwt.decode<{ iat: number; exp: number; sub: string }>(body.accessToken)!;
    expect(claims.exp - claims.iat).toBe(3600);
    const user = await app.db.collection(C.users).findOne({ username: 'planner1' });
    expect(user?.lastLogin).toMatchObject({ lat: 13.75, lng: 100.5 });
  });

  it('rejects a wrong password and an unknown user with the same error', async () => {
    const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'planner1', password: 'nope' } });
    const unknown = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'ghost', password: 'nope' } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.json().code).toBe('INVALID_CREDENTIALS');
  });

  it('returns the current user on /me', async () => {
    const { headers, user } = await createUserAndLogin(app, ['viewer']);
    const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: user._id.toHexString(), username: user.username, roles: ['viewer'], driverId: null });
    expect(res.json()).not.toHaveProperty('passwordHash');
  });

  it('requires a token on /me', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a deactivated user immediately, even with a valid token', async () => {
    const { headers, user } = await createUserAndLogin(app, ['planner']);
    await app.db.collection(C.users).updateOne({ _id: user._id }, { $set: { active: false } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers });
    expect(res.statusCode).toBe(401);
  });

  it('rejects login for an inactive user', async () => {
    await createUser(app.db, { username: 'gone', password: TEST_PASSWORD, roles: ['viewer'] });
    await app.db.collection(C.users).updateOne({ username: 'gone' }, { $set: { active: false } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'gone', password: TEST_PASSWORD } });
    expect(res.statusCode).toBe(401);
  });
});

describe('login rate limit', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildTestApp({ LOGIN_RATE_LIMIT_PER_MIN: '2' });
  });
  afterAll(async () => closeTestApp(app));

  it('returns 429 RATE_LIMITED after the limit', async () => {
    const attempt = () => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'x', password: 'y' } });
    await attempt();
    await attempt();
    const third = await attempt();
    expect(third.statusCode).toBe(429);
    expect(third.json().code).toBe('RATE_LIMITED');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/unit/passwords.test.ts test/api/auth-login.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement libs and repo**

`src/lib/roles.ts`:
```ts
export const ROLES = ['admin', 'planner', 'driver', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const STAFF_ROLES: Role[] = ['admin', 'planner', 'viewer'];
```

`src/lib/principal.ts`:
```ts
import type { Role } from './roles.js';

export type UserPrincipal = { kind: 'user'; userId: string; username: string; roles: Role[]; driverId: string | null };
export type ApiKeyPrincipal = { kind: 'apiKey'; keyId: string; name: string; scopes: string[] };
export type Principal = UserPrincipal | ApiKeyPrincipal;
```

`src/lib/passwords.ts`:
```ts
import argon2 from 'argon2';

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;
// Used to spend the same time on unknown usernames as on wrong passwords.
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword('dummy-password-for-constant-time-login');
  return dummy;
}
```

`src/lib/audit.ts`:
```ts
import type { FastifyRequest } from 'fastify';
import type { Db } from 'mongodb';
import { C } from '../db/collections.js';

export function actorOf(req: FastifyRequest): string {
  const p = req.principal;
  if (!p) return 'system';
  return p.kind === 'user' ? p.username : `apikey:${p.name}`;
}

export async function writeAudit(
  db: Db,
  entry: { entity: string; entityId: string; action: string; by: string; before?: unknown; after?: unknown },
): Promise<void> {
  await db.collection(C.auditLog).insertOne({
    entity: entry.entity,
    entityId: entry.entityId,
    action: entry.action,
    by: entry.by,
    before: entry.before ?? null,
    after: entry.after ?? null,
    at: new Date(),
  });
}
```

`src/modules/users/users.repo.ts`:
```ts
import type { Db, ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { hashPassword } from '../../lib/passwords.js';
import { ROLES, type Role } from '../../lib/roles.js';

export interface UserDoc {
  _id: ObjectId;
  username: string;
  passwordHash: string;
  roles: Role[];
  driverId: ObjectId | null;
  active: boolean;
  lastLogin: { at: Date; lat: number | null; lng: number | null } | null;
  createdAt: Date;
  updatedAt: Date;
}

export const UserOutSchema = z.object({
  id: z.string(),
  username: z.string(),
  roles: z.array(z.enum(ROLES)),
  driverId: z.string().nullable(),
});

export async function createUser(
  db: Db,
  input: { username: string; password: string; roles: Role[]; driverId?: ObjectId | null },
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
  const res = await db.collection<UserDoc>(C.users).insertOne(doc as UserDoc);
  return { ...doc, _id: res.insertedId };
}

export function findUserByUsername(db: Db, username: string) {
  return db.collection<UserDoc>(C.users).findOne({ username: username.trim() });
}

export function findUserById(db: Db, id: ObjectId) {
  return db.collection<UserDoc>(C.users).findOne({ _id: id });
}

export function userOut(u: UserDoc): z.infer<typeof UserOutSchema> {
  return { id: u._id.toHexString(), username: u.username, roles: u.roles, driverId: u.driverId?.toHexString() ?? null };
}
```

`src/modules/auth/refresh-tokens.ts` (issue only in this task; rotation arrives in Task 5):
```ts
import { createHash, randomBytes } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import { C } from '../../db/collections.js';

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
  await db.collection<RefreshTokenDoc>(C.refreshTokens).insertOne({
    _id,
    userId,
    familyId,
    tokenHash: sha256(secret),
    expiresAt: new Date(now.getTime() + ttlDays * 86_400_000),
    createdAt: now,
    replacedAt: null,
    revokedAt: null,
  });
  return `${_id.toHexString()}.${secret}`;
}
```

`src/modules/auth/auth.service.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import type { ObjectId } from 'mongodb';
import { z } from 'zod';
import { type UserDoc, UserOutSchema, userOut } from '../users/users.repo.js';
import { issueRefreshToken } from './refresh-tokens.js';

export const TokenResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number(),
  user: UserOutSchema,
});

export async function issueTokens(app: FastifyInstance, user: UserDoc, familyId?: ObjectId) {
  const accessToken = app.jwt.sign({ sub: user._id.toHexString(), roles: user.roles });
  const refreshToken = await issueRefreshToken(app.db, user._id, app.config.REFRESH_TOKEN_TTL_DAYS, familyId);
  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer' as const,
    expiresIn: app.config.ACCESS_TOKEN_TTL_SEC,
    user: userOut(user),
  };
}
```

- [ ] **Step 5: Implement the auth plugin, routes and wiring**

`src/plugins/auth.ts`:
```ts
import jwt from '@fastify/jwt';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { ObjectId } from 'mongodb';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { Principal, UserPrincipal } from '../lib/principal.js';
import type { Role } from '../lib/roles.js';
import { findUserById } from '../modules/users/users.repo.js';

export type AccessClaims = { sub: string; roles: Role[] };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyInstance {
    requireRoles: (...roles: Role[]) => preHandlerAsyncHookHandler;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessClaims;
    user: AccessClaims;
  }
}

export default fp(
  async (app) => {
    await app.register(jwt, {
      secret: app.config.JWT_SECRET,
      sign: { expiresIn: `${app.config.ACCESS_TOKEN_TTL_SEC}s` },
    });
    app.decorateRequest('principal', null);

    async function loadUserPrincipal(req: FastifyRequest): Promise<UserPrincipal> {
      if (!req.headers.authorization?.startsWith('Bearer ')) throw unauthorized();
      let claims: AccessClaims;
      try {
        claims = await req.jwtVerify<AccessClaims>();
      } catch {
        throw unauthorized('Invalid or expired token', 'INVALID_TOKEN');
      }
      if (!ObjectId.isValid(claims.sub)) throw unauthorized('Invalid or expired token', 'INVALID_TOKEN');
      const user = await findUserById(app.db, new ObjectId(claims.sub));
      if (!user || !user.active) throw unauthorized('User is inactive', 'USER_INACTIVE');
      return {
        kind: 'user',
        userId: user._id.toHexString(),
        username: user.username,
        roles: user.roles,
        driverId: user.driverId?.toHexString() ?? null,
      };
    }

    app.decorate('requireRoles', (...roles: Role[]): preHandlerAsyncHookHandler => {
      return async (req) => {
        const principal = await loadUserPrincipal(req);
        if (roles.length > 0 && !principal.roles.some((r) => roles.includes(r))) throw forbidden();
        req.principal = principal;
      };
    });
  },
  { name: 'auth', dependencies: ['mongo'] },
);
```

`src/modules/auth/auth.routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { AppError, unauthorized } from '../../lib/errors.js';
import { dummyHash, verifyPassword } from '../../lib/passwords.js';
import { UserOutSchema, findUserById, findUserByUsername, userOut } from '../users/users.repo.js';
import { TokenResponseSchema, issueTokens } from './auth.service.js';

const LoginBody = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/auth/login',
    {
      schema: { tags: ['auth'], body: LoginBody, response: { 200: TokenResponseSchema } },
      config: { rateLimit: { max: app.config.LOGIN_RATE_LIMIT_PER_MIN, timeWindow: '1 minute' } },
    },
    async (req) => {
      const user = await findUserByUsername(app.db, req.body.username);
      const ok = user ? await verifyPassword(user.passwordHash, req.body.password) : await verifyPassword(await dummyHash(), req.body.password).then(() => false);
      if (!user || !ok || !user.active) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
      }
      await app.db.collection(C.users).updateOne(
        { _id: user._id },
        { $set: { lastLogin: { at: new Date(), lat: req.body.lat ?? null, lng: req.body.lng ?? null } } },
      );
      return issueTokens(app, user);
    },
  );

  app.get(
    '/me',
    { schema: { tags: ['auth'], response: { 200: UserOutSchema } }, preHandler: app.requireRoles() },
    async (req) => {
      if (req.principal?.kind !== 'user') throw unauthorized();
      const user = await findUserById(app.db, new ObjectId(req.principal.userId));
      if (!user) throw unauthorized();
      return userOut(user);
    },
  );
};
```

`src/routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authRoutes } from './modules/auth/auth.routes.js';

export const apiRoutes: FastifyPluginAsyncZod = async (api) => {
  await api.register(authRoutes);
};
```

Modify `src/app.ts` — add imports:
```ts
import rateLimit from '@fastify/rate-limit';
import { AppError } from './lib/errors.js';
import authPlugin from './plugins/auth.js';
import { apiRoutes } from './routes.js';
```
and after `await app.register(mongoPlugin);` add:
```ts
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) =>
      new AppError(429, 'RATE_LIMITED', `Too many requests, retry in ${ctx.after}`),
  });
  await app.register(authPlugin);
  await app.register(apiRoutes, { prefix: '/api/v1' });
```

Modify `src/db/indexes.ts` — replace the `INDEXES` declaration with:
```ts
import { C } from './collections.js';

export const INDEXES: Record<string, IndexDescription[]> = {
  [C.users]: [
    { key: { username: 1 }, unique: true },
    { key: { driverId: 1 }, unique: true, partialFilterExpression: { driverId: { $type: 'objectId' } } },
  ],
  [C.refreshTokens]: [{ key: { familyId: 1 } }, { key: { userId: 1 } }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  [C.auditLog]: [{ key: { entity: 1, entityId: 1, at: -1 } }],
};
```
(keep the `import type { Db, IndexDescription } from 'mongodb';` line and `ensureIndexes`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: users, argon2 login with rate limit, JWT role guard and audit helper" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 5: Refresh rotation, logout, change password

**Files:**
- Modify: `src/modules/auth/refresh-tokens.ts`, `src/modules/auth/auth.routes.ts`
- Test: `test/api/auth-refresh.test.ts`

**Interfaces:**
- Consumes: `issueRefreshToken`, `issueTokens`, `findUserById`, `hashPassword`, `verifyPassword`.
- Produces: `rotateRefreshToken(db, token, graceSec) → { userId: ObjectId; familyId: ObjectId }` (throws 401 `INVALID_REFRESH_TOKEN` / `REFRESH_TOKEN_REUSED`); `revokeRefreshToken(db, token)`; `revokeAllForUser(db, userId)`; routes `POST /auth/refresh`, `POST /auth/logout` (204), `POST /me/password` (204).

- [ ] **Step 1: Write the failing test**

`test/api/auth-refresh.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { TEST_PASSWORD, createUserAndLogin } from '../helpers/auth.js';

const refresh = (app: App, refreshToken: string) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken } });

describe('refresh tokens (default 30 s reuse grace)', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => closeTestApp(app));

  it('rotates: returns a new pair', async () => {
    const { refreshToken } = await createUserAndLogin(app, ['planner']);
    const res = await refresh(app, refreshToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().refreshToken).not.toBe(refreshToken);
    expect(res.json().accessToken).toBeTruthy();
  });

  it('tolerates a quick retry of the same token (flaky network)', async () => {
    const { refreshToken } = await createUserAndLogin(app, ['driver'], { driverId: null });
    const a = await refresh(app, refreshToken);
    const b = await refresh(app, refreshToken);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
  });

  it('rejects garbage tokens', async () => {
    expect((await refresh(app, 'nope')).json().code).toBe('INVALID_REFRESH_TOKEN');
    expect((await refresh(app, `${'a'.repeat(24)}.xyz`)).statusCode).toBe(401);
  });

  it('logout revokes the token', async () => {
    const { refreshToken } = await createUserAndLogin(app, ['planner']);
    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', payload: { refreshToken } });
    expect(out.statusCode).toBe(204);
    expect((await refresh(app, refreshToken)).statusCode).toBe(401);
  });

  it('refuses refresh for a deactivated user', async () => {
    const { refreshToken, user } = await createUserAndLogin(app, ['planner']);
    await app.db.collection(C.users).updateOne({ _id: user._id }, { $set: { active: false } });
    expect((await refresh(app, refreshToken)).statusCode).toBe(401);
  });

  it('changes password, revokes sessions, and the new password works', async () => {
    const { headers, refreshToken, user } = await createUserAndLogin(app, ['viewer']);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/me/password', headers, payload: { currentPassword: 'wrong', newPassword: 'NewPassw0rd!' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('INVALID_CURRENT_PASSWORD');
    const ok = await app.inject({ method: 'POST', url: '/api/v1/me/password', headers, payload: { currentPassword: TEST_PASSWORD, newPassword: 'NewPassw0rd!' } });
    expect(ok.statusCode).toBe(204);
    expect((await refresh(app, refreshToken)).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: user.username, password: 'NewPassw0rd!' } });
    expect(login.statusCode).toBe(200);
  });
});

describe('refresh token reuse detection (no grace)', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildTestApp({ REFRESH_REUSE_GRACE_SEC: '0' });
  });
  afterAll(async () => closeTestApp(app));

  it('revokes the whole family when an old token is replayed', async () => {
    const { refreshToken } = await createUserAndLogin(app, ['planner']);
    const first = await refresh(app, refreshToken);
    expect(first.statusCode).toBe(200);
    const replay = await refresh(app, refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('REFRESH_TOKEN_REUSED');
    expect((await refresh(app, first.json().refreshToken)).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/auth-refresh.test.ts`
Expected: FAIL — 404 ROUTE_NOT_FOUND on `/auth/refresh`.

- [ ] **Step 3: Implement rotation**

Append to `src/modules/auth/refresh-tokens.ts` (add `timingSafeEqual` to the `node:crypto` import and `AppError` import):
```ts
import { AppError } from '../../lib/errors.js';

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

async function revokeFamily(db: Db, familyId: ObjectId): Promise<void> {
  await db
    .collection<RefreshTokenDoc>(C.refreshTokens)
    .updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
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
  if (doc.revokedAt) {
    await revokeFamily(db, doc.familyId);
    throw reused();
  }
  if (doc.expiresAt <= now) throw invalid();
  if (doc.replacedAt) {
    // A quick retry (lost response on a mobile network) is allowed; anything later is treated as theft.
    if (now.getTime() - doc.replacedAt.getTime() <= graceSec * 1000) {
      return { userId: doc.userId, familyId: doc.familyId };
    }
    await revokeFamily(db, doc.familyId);
    throw reused();
  }
  const updated = await coll.findOneAndUpdate(
    { _id: doc._id, replacedAt: null, revokedAt: null },
    { $set: { replacedAt: now } },
  );
  if (!updated && graceSec === 0) {
    await revokeFamily(db, doc.familyId);
    throw reused();
  }
  return { userId: doc.userId, familyId: doc.familyId };
}

export async function revokeRefreshToken(db: Db, token: string): Promise<void> {
  const parsed = parseToken(token);
  if (!parsed) return;
  const doc = await db.collection<RefreshTokenDoc>(C.refreshTokens).findOne({ _id: parsed.id });
  if (doc && hashMatches(doc.tokenHash, parsed.secret)) await revokeFamily(db, doc.familyId);
}

export async function revokeAllForUser(db: Db, userId: ObjectId): Promise<void> {
  await db
    .collection<RefreshTokenDoc>(C.refreshTokens)
    .updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}
```

- [ ] **Step 4: Add the routes**

In `src/modules/auth/auth.routes.ts` add imports:
```ts
import { hashPassword } from '../../lib/passwords.js';
import { revokeAllForUser, revokeRefreshToken, rotateRefreshToken } from './refresh-tokens.js';
```
and inside `authRoutes`, after the `/auth/login` route:
```ts
  const RefreshBody = z.object({ refreshToken: z.string().min(1) });

  app.post(
    '/auth/refresh',
    { schema: { tags: ['auth'], body: RefreshBody, response: { 200: TokenResponseSchema } } },
    async (req) => {
      const { userId, familyId } = await rotateRefreshToken(app.db, req.body.refreshToken, app.config.REFRESH_REUSE_GRACE_SEC);
      const user = await findUserById(app.db, userId);
      if (!user || !user.active) throw new AppError(401, 'USER_INACTIVE', 'User is inactive');
      return issueTokens(app, user, familyId);
    },
  );

  app.post('/auth/logout', { schema: { tags: ['auth'], body: RefreshBody } }, async (req, reply) => {
    await revokeRefreshToken(app.db, req.body.refreshToken);
    return reply.status(204).send();
  });

  app.post(
    '/me/password',
    {
      schema: {
        tags: ['auth'],
        body: z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(128) }),
      },
      preHandler: app.requireRoles(),
    },
    async (req, reply) => {
      if (req.principal?.kind !== 'user') throw unauthorized();
      const user = await findUserById(app.db, new ObjectId(req.principal.userId));
      if (!user) throw unauthorized();
      if (!(await verifyPassword(user.passwordHash, req.body.currentPassword))) {
        throw new AppError(422, 'INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
      }
      await app.db
        .collection(C.users)
        .updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(req.body.newPassword), updatedAt: new Date() } });
      await revokeAllForUser(app.db, user._id);
      return reply.status(204).send();
    },
  );
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: rotating refresh tokens with reuse grace, logout and password change" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 6: User administration, API keys, scope guard

**Files:**
- Create: `src/modules/users/users.routes.ts`, `src/modules/api-keys/api-keys.service.ts`, `src/modules/api-keys/api-keys.routes.ts`
- Modify: `src/plugins/auth.ts`, `src/routes.ts`, `src/db/indexes.ts`
- Test: `test/api/users-admin.test.ts`, `test/api/api-keys.test.ts`

**Interfaces:**
- Consumes: `createUser`, `UserDoc`, `revokeAllForUser`, `writeAudit`, `actorOf`, `paginate`, `PageQuery`, `pageResponse`, `toApi`.
- Produces:
  - `API_KEY_SCOPES = ['gps:write']`, `createApiKey(db, pepper, { name, scopes, createdBy }) → { doc, key }` (key format `mk_<24hex>_<secret>`), `authenticateApiKey(db, pepper, raw) → ApiKeyPrincipal | null`.
  - `app.requireScope(scope)` preHandler reading header `x-api-key` (401 missing/invalid, 403 missing scope). Used by Plan 4 GPS ingest.
  - Routes (admin only): `GET/POST /users`, `GET/PATCH /users/:id`; `GET/POST /api-keys`, `DELETE /api-keys/:id`.
  - Rule: a user with role `driver` must have `driverId` (422 `DRIVER_LINK_REQUIRED`); `driverId` must exist (422 `INVALID_REFERENCE`); one user per driver (409 `DUPLICATE_KEY`).

- [ ] **Step 1: Write the failing tests**

`test/api/users-admin.test.ts`:
```ts
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';

describe('user administration', () => {
  let app: App;
  let admin: { authorization: string };
  let planner: { authorization: string };
  let driverId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    admin = (await createUserAndLogin(app, ['admin'])).headers;
    planner = (await createUserAndLogin(app, ['planner'])).headers;
    const d = await app.db.collection(C.drivers).insertOne({ code: 'D001', name: 'สมชาย', active: true });
    driverId = d.insertedId.toHexString();
  });
  afterAll(async () => closeTestApp(app));

  it('admin creates a user; response has no password hash; audit is written', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/users', headers: admin,
      payload: { username: 'planner2', password: 'Passw0rd!', roles: ['planner'] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ username: 'planner2', roles: ['planner'], active: true, driverId: null });
    expect(JSON.stringify(res.json())).not.toContain('passwordHash');
    const audit = await app.db.collection(C.auditLog).findOne({ entity: 'user', entityId: res.json().id });
    expect(audit?.action).toBe('create');
    expect(JSON.stringify(audit)).not.toContain('passwordHash');
  });

  it('forbids non-admins', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/users', headers: planner });
    expect(res.statusCode).toBe(403);
  });

  it('rejects duplicate usernames with 409', async () => {
    const payload = { username: 'dupe', password: 'Passw0rd!', roles: ['viewer'] };
    await app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload });
    const res = await app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload });
    expect(res.statusCode).toBe(409);
  });

  it('requires a driver link for the driver role and validates it', async () => {
    const noLink = await app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload: { username: 'drv0', password: 'Passw0rd!', roles: ['driver'] } });
    expect(noLink.json().code).toBe('DRIVER_LINK_REQUIRED');
    const badLink = await app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload: { username: 'drv1', password: 'Passw0rd!', roles: ['driver'], driverId: new ObjectId().toHexString() } });
    expect(badLink.json().code).toBe('INVALID_REFERENCE');
    const ok = await app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload: { username: 'drv2', password: 'Passw0rd!', roles: ['driver'], driverId } });
    expect(ok.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload: { username: 'drv3', password: 'Passw0rd!', roles: ['driver'], driverId } });
    expect(second.statusCode).toBe(409);
  });

  it('PATCH deactivates a user and resets a password (revoking sessions)', async () => {
    const target = await createUserAndLogin(app, ['viewer']);
    const id = target.user._id.toHexString();
    const reset = await app.inject({ method: 'PATCH', url: `/api/v1/users/${id}`, headers: admin, payload: { password: 'Brand-new-1' } });
    expect(reset.statusCode).toBe(200);
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: target.refreshToken } });
    expect(r.statusCode).toBe(401);
    const off = await app.inject({ method: 'PATCH', url: `/api/v1/users/${id}`, headers: admin, payload: { active: false } });
    expect(off.json().active).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: target.headers })).statusCode).toBe(401);
  });
});
```

`test/api/api-keys.test.ts`:
```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { AppError } from '../../src/lib/errors.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';

async function runScopeGuard(app: App, scope: string, key?: string) {
  const req = { headers: key ? { 'x-api-key': key } : {}, principal: null } as unknown as FastifyRequest;
  await app.requireScope(scope).call(app, req, {} as FastifyReply);
  return req;
}

describe('API keys', () => {
  let app: App;
  let admin: { authorization: string };
  beforeAll(async () => {
    app = await buildTestApp();
    admin = (await createUserAndLogin(app, ['admin'])).headers;
  });
  afterAll(async () => closeTestApp(app));

  it('creates a key shown once, lists without secrets, and authenticates it', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: admin, payload: { name: 'hino-gps-sync', scopes: ['gps:write'] } });
    expect(res.statusCode).toBe(201);
    const { key, id } = res.json();
    expect(key).toMatch(/^mk_[a-f0-9]{24}_/);
    const list = await app.inject({ method: 'GET', url: '/api/v1/api-keys', headers: admin });
    expect(JSON.stringify(list.json())).not.toContain(key.split('_')[2]);
    expect(list.json().items[0]).not.toHaveProperty('keyHash');
    const req = await runScopeGuard(app, 'gps:write', key);
    expect(req.principal).toMatchObject({ kind: 'apiKey', keyId: id, name: 'hino-gps-sync' });
  });

  it('rejects missing, wrong, out-of-scope and revoked keys', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: admin, payload: { name: 'dtc', scopes: ['gps:write'] } })).json();
    await expect(runScopeGuard(app, 'gps:write')).rejects.toMatchObject({ statusCode: 401 });
    await expect(runScopeGuard(app, 'gps:write', `${created.key}x`)).rejects.toMatchObject({ statusCode: 401 });
    await expect(runScopeGuard(app, 'other:scope', created.key)).rejects.toMatchObject({ statusCode: 403 });
    await app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${created.id}`, headers: admin });
    await expect(runScopeGuard(app, 'gps:write', created.key)).rejects.toBeInstanceOf(AppError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/api/users-admin.test.ts test/api/api-keys.test.ts`
Expected: FAIL — 404 routes, `app.requireScope` undefined.

- [ ] **Step 3: Implement API key service and scope guard**

`src/modules/api-keys/api-keys.service.ts`:
```ts
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import { C } from '../../db/collections.js';
import type { ApiKeyPrincipal } from '../../lib/principal.js';

export const API_KEY_SCOPES = ['gps:write'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface ApiKeyDoc {
  _id: ObjectId;
  name: string;
  keyHash: string;
  scopes: ApiKeyScope[];
  active: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
  createdBy: string;
}

const hmac = (pepper: string, secret: string) => createHmac('sha256', pepper).update(secret).digest('hex');

export async function createApiKey(
  db: Db,
  pepper: string,
  input: { name: string; scopes: ApiKeyScope[]; createdBy: string },
): Promise<{ doc: ApiKeyDoc; key: string }> {
  const _id = new ObjectId();
  const secret = randomBytes(24).toString('base64url');
  const doc: ApiKeyDoc = {
    _id,
    name: input.name,
    keyHash: hmac(pepper, secret),
    scopes: input.scopes,
    active: true,
    lastUsedAt: null,
    createdAt: new Date(),
    createdBy: input.createdBy,
  };
  await db.collection<ApiKeyDoc>(C.apiKeys).insertOne(doc);
  return { doc, key: `mk_${_id.toHexString()}_${secret}` };
}

export async function authenticateApiKey(db: Db, pepper: string, raw: string): Promise<ApiKeyPrincipal | null> {
  const m = /^mk_([a-f0-9]{24})_([A-Za-z0-9_-]+)$/.exec(raw);
  if (!m) return null;
  const coll = db.collection<ApiKeyDoc>(C.apiKeys);
  const doc = await coll.findOne({ _id: new ObjectId(m[1]), active: true });
  if (!doc) return null;
  const a = Buffer.from(doc.keyHash, 'hex');
  const b = Buffer.from(hmac(pepper, m[2]!), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  await coll.updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } });
  return { kind: 'apiKey', keyId: doc._id.toHexString(), name: doc.name, scopes: [...doc.scopes] };
}
```

In `src/plugins/auth.ts`:
- add to the `FastifyInstance` augmentation: `requireScope: (scope: string) => preHandlerAsyncHookHandler;`
- add import: `import { authenticateApiKey } from '../modules/api-keys/api-keys.service.js';`
- after the `requireRoles` decorate, add:
```ts
    app.decorate('requireScope', (scope: string): preHandlerAsyncHookHandler => {
      return async (req) => {
        const raw = req.headers['x-api-key'];
        if (typeof raw !== 'string' || raw.length === 0) throw unauthorized('API key required', 'API_KEY_REQUIRED');
        const principal = await authenticateApiKey(app.db, app.config.API_KEY_PEPPER, raw);
        if (!principal) throw unauthorized('Invalid API key', 'INVALID_API_KEY');
        if (!principal.scopes.includes(scope)) throw forbidden(`API key lacks scope ${scope}`);
        req.principal = principal;
      };
    });
```

- [ ] **Step 4: Implement routes**

`src/modules/api-keys/api-keys.routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf, writeAudit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { IdParams } from '../../lib/ids.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import { toApi } from '../../lib/serialize.js';
import { API_KEY_SCOPES, type ApiKeyDoc, createApiKey } from './api-keys.service.js';

const ApiKeyItem = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(z.enum(API_KEY_SCOPES)),
  active: z.boolean(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string(),
});

const publicKey = (d: ApiKeyDoc) => {
  const { keyHash: _hidden, ...rest } = d;
  return toApi(rest);
};

export const apiKeyRoutes: FastifyPluginAsyncZod = async (app) => {
  const admin = app.requireRoles('admin');

  app.get('/api-keys', { schema: { tags: ['api-keys'], querystring: PageQuery, response: { 200: pageResponse(ApiKeyItem) } }, preHandler: admin }, async (req) => {
    const page = await paginate(app.db.collection<ApiKeyDoc>(C.apiKeys), {}, req.query);
    return { items: page.items.map(publicKey), nextCursor: page.nextCursor };
  });

  app.post(
    '/api-keys',
    {
      schema: {
        tags: ['api-keys'],
        body: z.object({ name: z.string().trim().min(1).max(100), scopes: z.array(z.enum(API_KEY_SCOPES)).min(1) }),
        response: { 201: ApiKeyItem.extend({ key: z.string() }) },
      },
      preHandler: admin,
    },
    async (req, reply) => {
      const by = actorOf(req);
      const { doc, key } = await createApiKey(app.db, app.config.API_KEY_PEPPER, { ...req.body, createdBy: by });
      await writeAudit(app.db, { entity: 'apiKey', entityId: doc._id.toHexString(), action: 'create', by, after: publicKey(doc) });
      return reply.status(201).send({ ...publicKey(doc), key });
    },
  );

  app.delete('/api-keys/:id', { schema: { tags: ['api-keys'], params: IdParams, response: { 200: ApiKeyItem } }, preHandler: admin }, async (req) => {
    const updated = await app.db
      .collection<ApiKeyDoc>(C.apiKeys)
      .findOneAndUpdate({ _id: new ObjectId(req.params.id) }, { $set: { active: false } }, { returnDocument: 'after' });
    if (!updated) throw notFound('API key');
    await writeAudit(app.db, { entity: 'apiKey', entityId: req.params.id, action: 'revoke', by: actorOf(req) });
    return publicKey(updated);
  });
};
```

`src/modules/users/users.routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Db, type Filter } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf, writeAudit } from '../../lib/audit.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { IdParams, objectIdString } from '../../lib/ids.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import { hashPassword } from '../../lib/passwords.js';
import { escapeRegex } from '../../lib/regex.js';
import { ROLES, type Role } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import { revokeAllForUser } from '../auth/refresh-tokens.js';
import { type UserDoc, createUser } from './users.repo.js';

const UserItem = z.object({
  id: z.string(),
  username: z.string(),
  roles: z.array(z.enum(ROLES)),
  driverId: z.string().nullable(),
  active: z.boolean(),
  lastLogin: z.object({ at: z.string(), lat: z.number().nullable(), lng: z.number().nullable() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CreateUserBody = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(8).max(128),
  roles: z.array(z.enum(ROLES)).min(1),
  driverId: objectIdString.nullable().default(null),
});

const PatchUserBody = z.object({
  password: z.string().min(8).max(128).optional(),
  roles: z.array(z.enum(ROLES)).min(1).optional(),
  driverId: objectIdString.nullable().optional(),
  active: z.boolean().optional(),
});

const safeUser = (u: UserDoc) => {
  const { passwordHash: _hidden, ...rest } = u;
  return toApi(rest);
};

async function assertDriverLink(db: Db, roles: Role[], driverId: ObjectId | null): Promise<void> {
  if (roles.includes('driver') && !driverId) {
    throw unprocessable('DRIVER_LINK_REQUIRED', 'Users with the driver role must be linked to a driver');
  }
  if (driverId && !(await db.collection(C.drivers).countDocuments({ _id: driverId }, { limit: 1 }))) {
    throw unprocessable('INVALID_REFERENCE', 'driverId does not exist', { field: 'driverId' });
  }
}

export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  const admin = app.requireRoles('admin');
  const users = () => app.db.collection<UserDoc>(C.users);

  app.get(
    '/users',
    { schema: { tags: ['users'], querystring: PageQuery.extend({ q: z.string().optional() }), response: { 200: pageResponse(UserItem) } }, preHandler: admin },
    async (req) => {
      const filter: Filter<UserDoc> = req.query.q ? { username: { $regex: escapeRegex(req.query.q), $options: 'i' } } : {};
      const page = await paginate(users(), filter, req.query);
      return { items: page.items.map(safeUser), nextCursor: page.nextCursor };
    },
  );

  app.get('/users/:id', { schema: { tags: ['users'], params: IdParams, response: { 200: UserItem } }, preHandler: admin }, async (req) => {
    const u = await users().findOne({ _id: new ObjectId(req.params.id) });
    if (!u) throw notFound('User');
    return safeUser(u);
  });

  app.post('/users', { schema: { tags: ['users'], body: CreateUserBody, response: { 201: UserItem } }, preHandler: admin }, async (req, reply) => {
    const driverId = req.body.driverId ? new ObjectId(req.body.driverId) : null;
    await assertDriverLink(app.db, req.body.roles, driverId);
    const u = await createUser(app.db, { ...req.body, driverId });
    await writeAudit(app.db, { entity: 'user', entityId: u._id.toHexString(), action: 'create', by: actorOf(req), after: safeUser(u) });
    return reply.status(201).send(safeUser(u));
  });

  app.patch('/users/:id', { schema: { tags: ['users'], params: IdParams, body: PatchUserBody, response: { 200: UserItem } }, preHandler: admin }, async (req) => {
    const _id = new ObjectId(req.params.id);
    const existing = await users().findOne({ _id });
    if (!existing) throw notFound('User');
    const roles = req.body.roles ?? existing.roles;
    const driverId = req.body.driverId === undefined ? existing.driverId : req.body.driverId ? new ObjectId(req.body.driverId) : null;
    await assertDriverLink(app.db, roles, driverId);
    const set: Partial<UserDoc> = { roles, driverId, updatedAt: new Date() };
    if (req.body.active !== undefined) set.active = req.body.active;
    if (req.body.password) set.passwordHash = await hashPassword(req.body.password);
    const updated = await users().findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after' });
    if (!updated) throw notFound('User');
    if (req.body.password || req.body.active === false) await revokeAllForUser(app.db, _id);
    await writeAudit(app.db, { entity: 'user', entityId: req.params.id, action: 'update', by: actorOf(req), before: safeUser(existing), after: safeUser(updated) });
    return safeUser(updated);
  });
};
```

Update `src/routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { apiKeyRoutes } from './modules/api-keys/api-keys.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { userRoutes } from './modules/users/users.routes.js';

export const apiRoutes: FastifyPluginAsyncZod = async (api) => {
  await api.register(authRoutes);
  await api.register(userRoutes);
  await api.register(apiKeyRoutes);
};
```

Add to `INDEXES` in `src/db/indexes.ts`:
```ts
  [C.apiKeys]: [{ key: { active: 1 } }],
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: admin user management, hashed API keys and scope guard" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 7: Master-data resource factory + simple resources

**Files:**
- Create: `src/modules/master/resource.ts`, `src/modules/master/simple.ts`, `src/modules/master/master.routes.ts`
- Modify: `src/routes.ts`, `src/db/indexes.ts`
- Test: `test/api/master-simple.test.ts`

**Interfaces:**
- Consumes: `paginate`, `PageQuery`, `pageResponse`, `toApi`, `objectIdString`, `escapeRegex`, `writeAudit`, `actorOf`, `STAFF_ROLES`, errors.
- Produces:
  - `interface RefSpec { path: string; collection: string; many?: boolean }` (dot paths, e.g. `criteria.zoneIds`).
  - `interface ParentSpec { param: string; field: string; collection: string }`.
  - `interface ResourceDef { name; path; collection; body: z.ZodObject<z.ZodRawShape>; item: z.ZodObject<z.ZodRawShape>; refs?; parent?; searchFields?; filterFields?: { name: string; ref?: boolean; boolean?: boolean }[]; toDb?(body) ; fromDb?(apiDoc); validate?(merged, { db, existing }); writeRoles?: Role[] }`.
  - `prepareDoc(def, db, body, existing, parentFields?) → Promise<Record<string, unknown>>` (runs `toDb`, converts/validates refs → 422 `INVALID_REFERENCE`, runs `validate`). Used by imports (Task 11).
  - `resourceRoutes(def): FastifyPluginAsyncZod` → `GET path`, `POST path`, `GET path/:id`, `PATCH path/:id` (body partial + `active?`), `DELETE path/:id` (deactivate). List query: `limit`, `cursor`, `q`, `active=true|false|all` (default `true`), plus `filterFields`.
  - Definitions: `clientsDef`, `zonesDef`, `materialsDef`, `serviceTypesDef`, `truckTypesDef` (`category: 'tractor'|'rigid'`), `palletMovementTypesDef` (`sign: -1|0|1`, admin-only writes). Shared zod atoms `Code`, `Name`.
  - `masterRoutes` plugin registering `ALL_RESOURCE_DEFS`.

- [ ] **Step 1: Write the failing test**

`test/api/master-simple.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';

describe('simple master data', () => {
  let app: App;
  let planner: { authorization: string };
  let viewer: { authorization: string };
  let driver: { authorization: string };

  beforeAll(async () => {
    app = await buildTestApp();
    planner = (await createUserAndLogin(app, ['planner'])).headers;
    viewer = (await createUserAndLogin(app, ['viewer'])).headers;
    driver = (await createUserAndLogin(app, ['driver'])).headers;
  });
  afterAll(async () => closeTestApp(app));

  const post = (url: string, payload: unknown, headers = planner) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers, payload });
  const get = (url: string, headers = planner) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers });

  it('creates, reads, updates and deactivates a zone with audit', async () => {
    const created = await post('/zones', { code: 'BKK', name: 'กรุงเทพ' });
    expect(created.statusCode).toBe(201);
    const zone = created.json();
    expect(zone).toMatchObject({ code: 'BKK', name: 'กรุงเทพ', active: true });
    expect((await get(`/zones/${zone.id}`, viewer)).json().name).toBe('กรุงเทพ');
    const patched = await app.inject({ method: 'PATCH', url: `/api/v1/zones/${zone.id}`, headers: planner, payload: { name: 'Bangkok' } });
    expect(patched.json().name).toBe('Bangkok');
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/zones/${zone.id}`, headers: planner });
    expect(del.json().active).toBe(false);
    expect((await get('/zones')).json().items.find((z: { id: string }) => z.id === zone.id)).toBeUndefined();
    expect((await get('/zones?active=all')).json().items.find((z: { id: string }) => z.id === zone.id)).toBeDefined();
    const actions = await app.db
      .collection(C.auditLog)
      .find({ entity: 'zone', entityId: zone.id })
      .sort({ _id: 1 })
      .map((a) => a.action)
      .toArray();
    expect(actions).toEqual(['create', 'update', 'deactivate']);
  });

  it('enforces roles: viewer cannot write, driver cannot read master data', async () => {
    expect((await post('/clients', { code: 'X', name: 'X' }, viewer)).statusCode).toBe(403);
    expect((await get('/clients', driver)).statusCode).toBe(403);
  });

  it('returns 409 on duplicate code, 400 on bad id, 404 on unknown id', async () => {
    await post('/clients', { code: 'SCG', name: 'SCG' });
    expect((await post('/clients', { code: 'SCG', name: 'again' })).statusCode).toBe(409);
    expect((await get('/clients/not-an-id')).json().code).toBe('VALIDATION_ERROR');
    expect((await get('/clients/0123456789abcdef01234567')).statusCode).toBe(404);
  });

  it('paginates and searches', async () => {
    for (const code of ['M1', 'M2', 'M3']) await post('/materials', { code, name: `ปูน ${code}`, unit: 'ton' });
    const p1 = (await get('/materials?limit=2')).json();
    expect(p1.items).toHaveLength(2);
    const p2 = (await get(`/materials?limit=2&cursor=${p1.nextCursor}`)).json();
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect((await get('/materials?q=m2')).json().items.map((m: { code: string }) => m.code)).toEqual(['M2']);
  });

  it('validates truck type category and service types', async () => {
    expect((await post('/truck-types', { code: 'MIXER', name: 'Mixer', category: 'rigid' })).statusCode).toBe(201);
    expect((await post('/truck-types', { code: 'BAD', name: 'Bad', category: 'boat' })).statusCode).toBe(400);
    expect((await post('/service-types', { code: 'DAILY', name: 'เหมาวัน' })).statusCode).toBe(201);
  });

  it('restricts pallet movement type writes to admin', async () => {
    expect((await post('/pallet-movement-types', { code: 'RETURN_IN', name: 'รับคืน', sign: 1 })).statusCode).toBe(403);
    const admin = (await createUserAndLogin(app, ['admin'])).headers;
    expect((await post('/pallet-movement-types', { code: 'RETURN_IN', name: 'รับคืน', sign: 1 }, admin)).statusCode).toBe(201);
    expect((await post('/pallet-movement-types', { code: 'X', name: 'x', sign: 2 }, admin)).statusCode).toBe(400);
  });
});
```

Note: `createUserAndLogin(app, ['driver'])` creates a driver-role user without a driver link directly through the repo (the link rule is enforced only by the admin API), which is fine for this test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/master-simple.test.ts`
Expected: FAIL — 404 ROUTE_NOT_FOUND.

- [ ] **Step 3: Implement the factory**

`src/modules/master/resource.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Db, type Document } from 'mongodb';
import { z } from 'zod';
import { actorOf, writeAudit } from '../../lib/audit.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { objectIdString } from '../../lib/ids.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import { escapeRegex } from '../../lib/regex.js';
import { STAFF_ROLES, type Role } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';

export interface RefSpec {
  path: string;
  collection: string;
  many?: boolean;
}

export interface ParentSpec {
  param: string;
  field: string;
  collection: string;
}

type Obj = Record<string, unknown>;

export interface ResourceDef {
  name: string;
  path: string;
  collection: string;
  body: z.ZodObject<z.ZodRawShape>;
  item: z.ZodObject<z.ZodRawShape>;
  refs?: RefSpec[];
  parent?: ParentSpec;
  searchFields?: string[];
  filterFields?: { name: string; ref?: boolean; boolean?: boolean }[];
  toDb?: (body: Obj) => Obj;
  fromDb?: (apiDoc: Obj) => Obj;
  validate?: (merged: Obj, ctx: { db: Db; existing: Document | null }) => Promise<void>;
  writeRoles?: Role[];
}

function getPath(obj: Obj, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Obj)[k] : undefined), obj);
}

function setPath(obj: Obj, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: Obj = obj;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') return;
    cur = cur[k] as Obj;
  }
  cur[keys[keys.length - 1]!] = value;
}

async function convertRef(db: Db, doc: Obj, ref: RefSpec): Promise<void> {
  const raw = getPath(doc, ref.path);
  if (raw === undefined || raw === null) return;
  const hexes = ref.many ? (raw as string[]) : [raw as string];
  const ids = [...new Set(hexes)].map((h) => new ObjectId(h));
  if (ids.length > 0) {
    const found = await db.collection(ref.collection).find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray();
    const foundSet = new Set(found.map((d) => d._id.toHexString()));
    const missing = ids.map((i) => i.toHexString()).filter((h) => !foundSet.has(h));
    if (missing.length > 0) {
      throw unprocessable('INVALID_REFERENCE', `${ref.path} references unknown ${ref.collection}`, { field: ref.path, missing });
    }
  }
  setPath(doc, ref.path, ref.many ? hexes.map((h) => new ObjectId(h)) : new ObjectId(hexes[0]!));
}

export async function prepareDoc(
  def: ResourceDef,
  db: Db,
  body: Obj,
  existing: Document | null,
  parentFields: Obj = {},
): Promise<Obj> {
  const doc = def.toDb ? def.toDb({ ...body }) : { ...body };
  for (const ref of def.refs ?? []) await convertRef(db, doc, ref);
  if (def.validate) {
    const merged = { ...(existing ?? {}), ...parentFields, ...doc };
    await def.validate(merged, { db, existing });
  }
  return doc;
}

export function resourceRoutes(def: ResourceDef): FastifyPluginAsyncZod {
  const writeRoles = def.writeRoles ?? (['admin', 'planner'] as Role[]);
  const itemSchema = def.item.extend({ id: z.string(), active: z.boolean(), createdAt: z.string(), updatedAt: z.string() });
  const parentParams = def.parent ? z.object({ [def.parent.param]: objectIdString }) : z.object({});
  const idParams = parentParams.extend({ id: objectIdString });
  const filterShape = Object.fromEntries(
    (def.filterFields ?? []).map((f) => [f.name, f.ref ? objectIdString.optional() : f.boolean ? z.enum(['true', 'false']).optional() : z.string().optional()]),
  );
  const listQuery = PageQuery.extend({ q: z.string().optional(), active: z.enum(['true', 'false', 'all']).default('true'), ...filterShape });
  const patchBody = def.body.partial().extend({ active: z.boolean().optional() });
  const out = (doc: Document) => {
    const api = toApi(doc) as Obj;
    return def.fromDb ? def.fromDb(api) : api;
  };

  return async (app) => {
    const coll = () => app.db.collection(def.collection);
    const readGuard = app.requireRoles(...STAFF_ROLES);
    const writeGuard = app.requireRoles(...writeRoles);

    const parentFilter = async (params: Obj): Promise<Obj> => {
      if (!def.parent) return {};
      const pid = new ObjectId(params[def.parent.param] as string);
      const exists = await app.db.collection(def.parent.collection).countDocuments({ _id: pid }, { limit: 1 });
      if (!exists) throw notFound(def.parent.collection);
      return { [def.parent.field]: pid };
    };

    app.get(def.path, { schema: { tags: [def.name], params: parentParams, querystring: listQuery, response: { 200: pageResponse(itemSchema) } }, preHandler: readGuard }, async (req) => {
      const q = req.query as Obj & { limit: number; cursor?: string; q?: string; active: string };
      const filter: Document = { ...(await parentFilter(req.params as Obj)) };
      if (q.active !== 'all') filter.active = q.active === 'true';
      if (q.q && def.searchFields?.length) {
        const rx = { $regex: escapeRegex(q.q), $options: 'i' };
        filter.$or = def.searchFields.map((f) => ({ [f]: rx }));
      }
      for (const f of def.filterFields ?? []) {
        const v = q[f.name];
        if (v === undefined) continue;
        filter[f.name] = f.ref ? new ObjectId(v as string) : f.boolean ? v === 'true' : v;
      }
      const page = await paginate(coll(), filter, { limit: q.limit, cursor: q.cursor });
      return { items: page.items.map(out), nextCursor: page.nextCursor };
    });

    app.get(`${def.path}/:id`, { schema: { tags: [def.name], params: idParams, response: { 200: itemSchema } }, preHandler: readGuard }, async (req) => {
      const params = req.params as Obj & { id: string };
      const doc = await coll().findOne({ _id: new ObjectId(params.id), ...(await parentFilter(params)) });
      if (!doc) throw notFound(def.name);
      return out(doc);
    });

    app.post(def.path, { schema: { tags: [def.name], params: parentParams, body: def.body, response: { 201: itemSchema } }, preHandler: writeGuard }, async (req, reply) => {
      const pf = await parentFilter(req.params as Obj);
      const prepared = await prepareDoc(def, app.db, req.body as Obj, null, pf);
      const now = new Date();
      const doc: Obj = { ...prepared, ...pf, active: true, createdAt: now, updatedAt: now };
      const res = await coll().insertOne(doc);
      const saved = { ...doc, _id: res.insertedId };
      await writeAudit(app.db, { entity: def.name, entityId: res.insertedId.toHexString(), action: 'create', by: actorOf(req), after: toApi(saved) });
      return reply.status(201).send(out(saved));
    });

    app.patch(`${def.path}/:id`, { schema: { tags: [def.name], params: idParams, body: patchBody, response: { 200: itemSchema } }, preHandler: writeGuard }, async (req) => {
      const params = req.params as Obj & { id: string };
      const pf = await parentFilter(params);
      const _id = new ObjectId(params.id);
      const existing = await coll().findOne({ _id, ...pf });
      if (!existing) throw notFound(def.name);
      const { active, ...fields } = req.body as Obj & { active?: boolean };
      const prepared = await prepareDoc(def, app.db, fields, existing, pf);
      const set: Obj = { ...prepared, updatedAt: new Date() };
      if (active !== undefined) set.active = active;
      const updated = await coll().findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after' });
      if (!updated) throw notFound(def.name);
      await writeAudit(app.db, { entity: def.name, entityId: params.id, action: 'update', by: actorOf(req), before: toApi(existing), after: toApi(updated) });
      return out(updated);
    });

    app.delete(`${def.path}/:id`, { schema: { tags: [def.name], params: idParams, response: { 200: itemSchema } }, preHandler: writeGuard }, async (req) => {
      const params = req.params as Obj & { id: string };
      const pf = await parentFilter(params);
      const updated = await coll().findOneAndUpdate(
        { _id: new ObjectId(params.id), ...pf },
        { $set: { active: false, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      if (!updated) throw notFound(def.name);
      await writeAudit(app.db, { entity: def.name, entityId: params.id, action: 'deactivate', by: actorOf(req) });
      return out(updated);
    });
  };
}
```

- [ ] **Step 4: Implement simple definitions and routing**

`src/modules/master/simple.ts`:
```ts
import { z } from 'zod';
import { C } from '../../db/collections.js';
import type { ResourceDef } from './resource.js';

export const Code = z.string().trim().min(1).max(40);
export const Name = z.string().trim().min(1).max(200);

const codeName = z.object({ code: Code, name: Name });

export const clientsDef: ResourceDef = {
  name: 'client', path: '/clients', collection: C.clients,
  body: codeName, item: codeName, searchFields: ['code', 'name'],
};

export const zonesDef: ResourceDef = {
  name: 'zone', path: '/zones', collection: C.zones,
  body: codeName, item: codeName, searchFields: ['code', 'name'],
};

const material = codeName.extend({ unit: z.string().trim().min(1).max(20) });
export const materialsDef: ResourceDef = {
  name: 'material', path: '/materials', collection: C.materials,
  body: material, item: material, searchFields: ['code', 'name'],
};

export const serviceTypesDef: ResourceDef = {
  name: 'serviceType', path: '/service-types', collection: C.serviceTypes,
  body: codeName, item: codeName, searchFields: ['code', 'name'],
};

export const TRUCK_CATEGORIES = ['tractor', 'rigid'] as const;
const truckType = codeName.extend({ category: z.enum(TRUCK_CATEGORIES) });
export const truckTypesDef: ResourceDef = {
  name: 'truckType', path: '/truck-types', collection: C.truckTypes,
  body: truckType, item: truckType, searchFields: ['code', 'name'], filterFields: [{ name: 'category' }],
};

const palletMovementType = codeName.extend({ sign: z.union([z.literal(-1), z.literal(0), z.literal(1)]) });
export const palletMovementTypesDef: ResourceDef = {
  name: 'palletMovementType', path: '/pallet-movement-types', collection: C.palletMovementTypes,
  body: palletMovementType, item: palletMovementType, searchFields: ['code', 'name'], writeRoles: ['admin'],
};
```

`src/modules/master/master.routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { type ResourceDef, resourceRoutes } from './resource.js';
import { clientsDef, materialsDef, palletMovementTypesDef, serviceTypesDef, truckTypesDef, zonesDef } from './simple.js';

export const ALL_RESOURCE_DEFS: ResourceDef[] = [
  clientsDef,
  zonesDef,
  materialsDef,
  serviceTypesDef,
  truckTypesDef,
  palletMovementTypesDef,
];

export const masterRoutes: FastifyPluginAsyncZod = async (app) => {
  for (const def of ALL_RESOURCE_DEFS) await app.register(resourceRoutes(def));
};
```

In `src/routes.ts` add `import { masterRoutes } from './modules/master/master.routes.js';` and `await api.register(masterRoutes);`.

Add to `INDEXES` in `src/db/indexes.ts`:
```ts
  [C.clients]: [{ key: { code: 1 }, unique: true }],
  [C.zones]: [{ key: { code: 1 }, unique: true }],
  [C.materials]: [{ key: { code: 1 }, unique: true }],
  [C.serviceTypes]: [{ key: { code: 1 }, unique: true }],
  [C.truckTypes]: [{ key: { code: 1 }, unique: true }],
  [C.palletMovementTypes]: [{ key: { code: 1 }, unique: true }],
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: generic master-data resource factory with clients, zones, materials, service/truck/pallet types" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 8: Locations, vehicles, drivers

**Files:**
- Create: `src/modules/master/locations.ts`, `src/modules/master/fleet.ts`
- Modify: `src/modules/master/master.routes.ts`, `src/db/indexes.ts`
- Test: `test/unit/plate.test.ts`, `test/api/master-fleet.test.ts`

**Interfaces:**
- Consumes: `ResourceDef`, `Code`, `Name`, `objectIdString`, `unprocessable`.
- Produces:
  - `locationsDef`: API `{ code, name, clientId: string|null, zoneId, isSite, address: string|null, lat, lng, geofenceRadiusM }`; DB stores `geo: { type: 'Point', coordinates: [lng, lat] }` (2dsphere). `lat`/`lng` must come together (422 `LAT_LNG_PAIR`). Filters: `zoneId`, `clientId`, `isSite`.
  - `normalizePlate(p: string): string` (trim, collapse whitespace, upper-case).
  - `vehiclesDef`: `{ plate, part: 'head'|'tail'|'rigid', truckTypeId, gpsVendor: string|null, gpsId: string|null }`; rule: `part==='rigid'` ⇔ truck type `category==='rigid'` (422 `PART_CATEGORY_MISMATCH`). Filters: `part`, `truckTypeId`.
  - `driversDef`: `{ code, name, phone: string|null, licenseType: string|null, licenseExpiry: 'YYYY-MM-DD'|null }`.
  - `VEHICLE_PARTS = ['head','tail','rigid']`.

- [ ] **Step 1: Write the failing tests**

`test/unit/plate.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { normalizePlate } from '../../src/modules/master/fleet.js';

describe('normalizePlate', () => {
  it('trims, collapses whitespace and upper-cases', () => {
    expect(normalizePlate('  70-1234 ')).toBe('70-1234');
    expect(normalizePlate('ab   1234')).toBe('AB 1234');
    expect(normalizePlate('สบ  1234')).toBe('สบ 1234');
  });
});
```

`test/api/master-fleet.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';

describe('locations, vehicles, drivers', () => {
  let app: App;
  let h: { authorization: string };
  let zoneId: string;
  let tractorType: string;
  let rigidType: string;

  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });
  const patch = (url: string, payload: unknown) => app.inject({ method: 'PATCH', url: `/api/v1${url}`, headers: h, payload });

  beforeAll(async () => {
    app = await buildTestApp();
    h = (await createUserAndLogin(app, ['planner'])).headers;
    zoneId = (await post('/zones', { code: 'CEN', name: 'ภาคกลาง' })).json().id;
    tractorType = (await post('/truck-types', { code: 'TRAILER', name: 'Trailer', category: 'tractor' })).json().id;
    rigidType = (await post('/truck-types', { code: 'MIXER', name: 'Mixer', category: 'rigid' })).json().id;
  });
  afterAll(async () => closeTestApp(app));

  it('stores a location as a GeoJSON point and returns lat/lng', async () => {
    const res = await post('/locations', { code: 'SRB-PLANT', name: 'โรงงานสระบุรี', zoneId, isSite: true, lat: 14.53, lng: 100.91 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ lat: 14.53, lng: 100.91, geofenceRadiusM: 300, isSite: true, clientId: null, address: null });
    const raw = await app.db.collection(C.locations).findOne({ code: 'SRB-PLANT' });
    expect(raw?.geo).toEqual({ type: 'Point', coordinates: [100.91, 14.53] });
    expect(raw).not.toHaveProperty('lat');
    const filtered = await app.inject({ method: 'GET', url: `/api/v1/locations?zoneId=${zoneId}&isSite=true`, headers: h });
    expect(filtered.json().items).toHaveLength(1);
  });

  it('rejects an unknown zone and a lat without lng', async () => {
    const bad = await post('/locations', { code: 'X', name: 'X', zoneId: '0123456789abcdef01234567', lat: 1, lng: 1 });
    expect(bad.json().code).toBe('INVALID_REFERENCE');
    const loc = (await post('/locations', { code: 'Y', name: 'Y', zoneId, lat: 13.7, lng: 100.5 })).json();
    const half = await patch(`/locations/${loc.id}`, { lat: 13.8 });
    expect(half.statusCode).toBe(422);
    expect(half.json().code).toBe('LAT_LNG_PAIR');
    const both = await patch(`/locations/${loc.id}`, { lat: 13.8, lng: 100.6 });
    expect(both.json()).toMatchObject({ lat: 13.8, lng: 100.6 });
  });

  it('normalises plates and treats spacing/case variants as duplicates', async () => {
    const res = await post('/vehicles', { plate: ' 70-1234 ', part: 'head', truckTypeId: tractorType });
    expect(res.statusCode).toBe(201);
    expect(res.json().plate).toBe('70-1234');
    expect((await post('/vehicles', { plate: '70-1234', part: 'head', truckTypeId: tractorType })).statusCode).toBe(409);
    await post('/vehicles', { plate: 'ab 1234', part: 'tail', truckTypeId: tractorType });
    expect((await post('/vehicles', { plate: 'AB  1234', part: 'tail', truckTypeId: tractorType })).statusCode).toBe(409);
  });

  it('enforces part vs truck-type category, including on PATCH', async () => {
    expect((await post('/vehicles', { plate: 'MX-1', part: 'rigid', truckTypeId: tractorType })).json().code).toBe('PART_CATEGORY_MISMATCH');
    expect((await post('/vehicles', { plate: 'MX-2', part: 'head', truckTypeId: rigidType })).json().code).toBe('PART_CATEGORY_MISMATCH');
    const mixer = (await post('/vehicles', { plate: 'MX-3', part: 'rigid', truckTypeId: rigidType })).json();
    expect((await patch(`/vehicles/${mixer.id}`, { part: 'head' })).json().code).toBe('PART_CATEGORY_MISMATCH');
  });

  it('creates drivers and validates licence expiry format', async () => {
    const ok = await post('/drivers', { code: 'D001', name: 'สมชาย ใจดี', phone: '0812345678', licenseType: 'ท.4', licenseExpiry: '2027-05-31' });
    expect(ok.statusCode).toBe(201);
    expect((await post('/drivers', { code: 'D002', name: 'x', licenseExpiry: '31/05/2027' })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/plate.test.ts test/api/master-fleet.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/modules/master/locations.ts`:
```ts
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { unprocessable } from '../../lib/errors.js';
import { objectIdString } from '../../lib/ids.js';
import type { ResourceDef } from './resource.js';
import { Code, Name } from './simple.js';

const LocationBody = z.object({
  code: Code,
  name: Name,
  clientId: objectIdString.nullable().default(null),
  zoneId: objectIdString,
  isSite: z.boolean().default(false),
  address: z.string().trim().max(500).nullable().default(null),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  geofenceRadiusM: z.number().int().min(50).max(5000).default(300),
});

const LocationItem = LocationBody.extend({ clientId: z.string().nullable(), zoneId: z.string() });

export const locationsDef: ResourceDef = {
  name: 'location',
  path: '/locations',
  collection: C.locations,
  body: LocationBody,
  item: LocationItem,
  refs: [
    { path: 'clientId', collection: C.clients },
    { path: 'zoneId', collection: C.zones },
  ],
  searchFields: ['code', 'name', 'address'],
  filterFields: [{ name: 'zoneId', ref: true }, { name: 'clientId', ref: true }, { name: 'isSite', boolean: true }],
  toDb: (body) => {
    const { lat, lng, ...rest } = body;
    if ((lat === undefined) !== (lng === undefined)) {
      throw unprocessable('LAT_LNG_PAIR', 'lat and lng must be provided together');
    }
    return lat === undefined ? rest : { ...rest, geo: { type: 'Point', coordinates: [lng, lat] } };
  },
  fromDb: (doc) => {
    const { geo, ...rest } = doc as { geo?: { coordinates: [number, number] } } & Record<string, unknown>;
    return geo ? { ...rest, lat: geo.coordinates[1], lng: geo.coordinates[0] } : rest;
  },
};
```

`src/modules/master/fleet.ts`:
```ts
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { unprocessable } from '../../lib/errors.js';
import { objectIdString } from '../../lib/ids.js';
import type { ResourceDef } from './resource.js';
import { Code, Name } from './simple.js';

export function normalizePlate(p: string): string {
  return p.trim().replace(/\s+/g, ' ').toUpperCase();
}

export const VEHICLE_PARTS = ['head', 'tail', 'rigid'] as const;

const VehicleBody = z.object({
  plate: z.string().trim().min(2).max(20),
  part: z.enum(VEHICLE_PARTS),
  truckTypeId: objectIdString,
  gpsVendor: z.string().trim().max(40).nullable().default(null),
  gpsId: z.string().trim().max(60).nullable().default(null),
});

export const vehiclesDef: ResourceDef = {
  name: 'vehicle',
  path: '/vehicles',
  collection: C.vehicles,
  body: VehicleBody,
  item: VehicleBody.extend({ truckTypeId: z.string() }),
  refs: [{ path: 'truckTypeId', collection: C.truckTypes }],
  searchFields: ['plate', 'gpsId'],
  filterFields: [{ name: 'part' }, { name: 'truckTypeId', ref: true }],
  toDb: (body) => (typeof body.plate === 'string' ? { ...body, plate: normalizePlate(body.plate) } : body),
  validate: async (merged, { db }) => {
    const tt = await db.collection(C.truckTypes).findOne({ _id: merged.truckTypeId as ObjectId });
    const isRigidPart = merged.part === 'rigid';
    const isRigidType = tt?.category === 'rigid';
    if (isRigidPart !== isRigidType) {
      throw unprocessable('PART_CATEGORY_MISMATCH', `A ${String(merged.part)} vehicle cannot use a ${String(tt?.category)} truck type`);
    }
  },
};

const DriverBody = z.object({
  code: Code,
  name: Name,
  phone: z.string().trim().max(30).nullable().default(null),
  licenseType: z.string().trim().max(30).nullable().default(null),
  licenseExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').nullable().default(null),
});

export const driversDef: ResourceDef = {
  name: 'driver',
  path: '/drivers',
  collection: C.drivers,
  body: DriverBody,
  item: DriverBody,
  searchFields: ['code', 'name', 'phone'],
};
```

Update `src/modules/master/master.routes.ts` imports and list:
```ts
import { driversDef, vehiclesDef } from './fleet.js';
import { locationsDef } from './locations.js';
```
```ts
export const ALL_RESOURCE_DEFS: ResourceDef[] = [
  clientsDef,
  zonesDef,
  materialsDef,
  serviceTypesDef,
  truckTypesDef,
  palletMovementTypesDef,
  locationsDef,
  vehiclesDef,
  driversDef,
];
```

Add to `INDEXES`:
```ts
  [C.locations]: [{ key: { code: 1 }, unique: true }, { key: { geo: '2dsphere' } }, { key: { zoneId: 1 } }, { key: { clientId: 1 } }],
  [C.vehicles]: [{ key: { plate: 1 }, unique: true }, { key: { truckTypeId: 1 } }, { key: { gpsId: 1 } }],
  [C.drivers]: [{ key: { code: 1 }, unique: true }],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: locations with GeoJSON geofences, vehicles with plate normalisation, drivers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 9: Job groups + matching

**Files:**
- Create: `src/modules/master/job-group-match.ts`, `src/modules/master/job-groups.ts`
- Modify: `src/modules/master/master.routes.ts`, `src/db/indexes.ts`
- Test: `test/unit/job-group-match.test.ts`, `test/api/job-groups.test.ts`

**Interfaces:**
- Consumes: `ResourceDef`, `resourceRoutes`, `Code`, `Name`, `objectIdString`.
- Produces:
  - `interface JobGroupCriteria { truckTypeIds: string[]; serviceTypeIds: string[]; siteIds: string[]; materialIds: string[]; originZoneIds: string[]; destZoneIds: string[] }`
  - `interface MatchInput { truckTypeId: string | null; serviceTypeId: string; materialId: string; siteIds: string[]; originZoneId: string; destZoneId: string }`
  - `interface MatchableGroup { id: string; criteria: JobGroupCriteria }`
  - `type MatchResult = { status: 'auto'; jobGroupId: string; candidates: string[] } | { status: 'ambiguous'; jobGroupId: null; candidates: string[] } | { status: 'none'; jobGroupId: null; candidates: [] }`
  - `matchJobGroup(input: MatchInput, groups: MatchableGroup[]): MatchResult` (pure).
  - `interface DoMatchFields { truckTypeId: ObjectId | null; serviceTypeId: ObjectId; materialId: ObjectId; originLocationId: ObjectId; destLocationId: ObjectId }`
  - `matchJobGroupForDo(db, clientId: ObjectId, fields: DoMatchFields): Promise<MatchResult>` — used by Plan 2.
  - `jobGroupsDef` at `/clients/:clientId/job-groups`; `POST /clients/:clientId/job-groups/match` preview.
  - Rules: every `siteIds` entry must be a location with `isSite: true` (422 `NOT_A_SITE`); `code` unique per client.

- [ ] **Step 1: Write the failing tests**

`test/unit/job-group-match.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { type JobGroupCriteria, type MatchInput, matchJobGroup } from '../../src/modules/master/job-group-match.js';

const empty: JobGroupCriteria = { truckTypeIds: [], serviceTypeIds: [], siteIds: [], materialIds: [], originZoneIds: [], destZoneIds: [] };
const input: MatchInput = { truckTypeId: 'T1', serviceTypeId: 'S1', materialId: 'M1', siteIds: ['SITE1'], originZoneId: 'Z1', destZoneId: 'Z2' };

describe('matchJobGroup', () => {
  it('returns none when no group matches', () => {
    expect(matchJobGroup(input, [{ id: 'g1', criteria: { ...empty, materialIds: ['M9'] } }])).toEqual({ status: 'none', jobGroupId: null, candidates: [] });
  });

  it('an all-empty group matches anything', () => {
    expect(matchJobGroup(input, [{ id: 'g1', criteria: empty }])).toMatchObject({ status: 'auto', jobGroupId: 'g1' });
  });

  it('the most specific group wins', () => {
    const r = matchJobGroup(input, [
      { id: 'generic', criteria: { ...empty, materialIds: ['M1'] } },
      { id: 'specific', criteria: { ...empty, materialIds: ['M1'], destZoneIds: ['Z2'] } },
    ]);
    expect(r).toEqual({ status: 'auto', jobGroupId: 'specific', candidates: ['generic', 'specific'] });
  });

  it('equal specificity is ambiguous', () => {
    const r = matchJobGroup(input, [
      { id: 'b', criteria: { ...empty, materialIds: ['M1'] } },
      { id: 'a', criteria: { ...empty, serviceTypeIds: ['S1'] } },
    ]);
    expect(r).toEqual({ status: 'ambiguous', jobGroupId: null, candidates: ['a', 'b'] });
  });

  it('a truck-type criterion never matches an unknown truck type', () => {
    const r = matchJobGroup({ ...input, truckTypeId: null }, [{ id: 'g', criteria: { ...empty, truckTypeIds: ['T1'] } }]);
    expect(r.status).toBe('none');
  });

  it('site criterion matches when either end is a listed site', () => {
    expect(matchJobGroup(input, [{ id: 'g', criteria: { ...empty, siteIds: ['OTHER', 'SITE1'] } }]).status).toBe('auto');
    expect(matchJobGroup({ ...input, siteIds: [] }, [{ id: 'g', criteria: { ...empty, siteIds: ['SITE1'] } }]).status).toBe('none');
  });
});
```

`test/api/job-groups.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';

describe('job groups', () => {
  let app: App;
  let h: { authorization: string };
  const ids: Record<string, string> = {};
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });

  beforeAll(async () => {
    app = await buildTestApp();
    h = (await createUserAndLogin(app, ['planner'])).headers;
    ids.scg = (await post('/clients', { code: 'SCG', name: 'SCG' })).json().id;
    ids.cpac = (await post('/clients', { code: 'CPAC', name: 'CPAC' })).json().id;
    ids.zCen = (await post('/zones', { code: 'CEN', name: 'Central' })).json().id;
    ids.zNe = (await post('/zones', { code: 'NE', name: 'Northeast' })).json().id;
    ids.bulk = (await post('/materials', { code: 'BULK', name: 'ปูนผง', unit: 'ton' })).json().id;
    ids.bag = (await post('/materials', { code: 'BAG', name: 'ปูนถุง', unit: 'bag' })).json().id;
    ids.single = (await post('/service-types', { code: 'SINGLE', name: 'Single' })).json().id;
    ids.trailer = (await post('/truck-types', { code: 'TRAILER', name: 'Trailer', category: 'tractor' })).json().id;
    ids.plant = (await post('/locations', { code: 'SRB', name: 'Saraburi plant', zoneId: ids.zCen, isSite: true, lat: 14.5, lng: 100.9 })).json().id;
    ids.shop = (await post('/locations', { code: 'KKN', name: 'Khon Kaen shop', zoneId: ids.zNe, lat: 16.4, lng: 102.8 })).json().id;
  });
  afterAll(async () => closeTestApp(app));

  it('creates job groups scoped to a client with validated criteria', async () => {
    const res = await post(`/clients/${ids.scg}/job-groups`, {
      code: 'BULK-SRB', name: 'ปูนผง-สระบุรี-หัวลาก',
      criteria: { materialIds: [ids.bulk], siteIds: [ids.plant], truckTypeIds: [ids.trailer] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ clientId: ids.scg, criteria: { materialIds: [ids.bulk], serviceTypeIds: [] } });
    const same = await post(`/clients/${ids.cpac}/job-groups`, { code: 'BULK-SRB', name: 'same code, other client', criteria: {} });
    expect(same.statusCode).toBe(201);
    expect((await post(`/clients/${ids.scg}/job-groups`, { code: 'BULK-SRB', name: 'dupe', criteria: {} })).statusCode).toBe(409);
    const list = await app.inject({ method: 'GET', url: `/api/v1/clients/${ids.scg}/job-groups`, headers: h });
    expect(list.json().items).toHaveLength(1);
  });

  it('rejects unknown refs, non-site sites and unknown clients', async () => {
    expect((await post(`/clients/${ids.scg}/job-groups`, { code: 'A', name: 'A', criteria: { materialIds: ['0123456789abcdef01234567'] } })).json().code).toBe('INVALID_REFERENCE');
    expect((await post(`/clients/${ids.scg}/job-groups`, { code: 'B', name: 'B', criteria: { siteIds: [ids.shop] } })).json().code).toBe('NOT_A_SITE');
    expect((await post('/clients/0123456789abcdef01234567/job-groups', { code: 'C', name: 'C', criteria: {} })).statusCode).toBe(404);
  });

  it('previews matching for DO fields', async () => {
    await post(`/clients/${ids.scg}/job-groups`, { code: 'BAG-NE', name: 'ปูนถุง-อีสาน', criteria: { materialIds: [ids.bag], destZoneIds: [ids.zNe] } });
    const match = (payload: unknown) => post(`/clients/${ids.scg}/job-groups/match`, payload);
    const auto = await match({ truckTypeId: ids.trailer, serviceTypeId: ids.single, materialId: ids.bulk, originLocationId: ids.plant, destLocationId: ids.shop });
    expect(auto.json()).toMatchObject({ status: 'auto' });
    const noTruck = await match({ truckTypeId: null, serviceTypeId: ids.single, materialId: ids.bulk, originLocationId: ids.plant, destLocationId: ids.shop });
    expect(noTruck.json().status).toBe('none');
    const bag = await match({ truckTypeId: null, serviceTypeId: ids.single, materialId: ids.bag, originLocationId: ids.plant, destLocationId: ids.shop });
    expect(bag.json().status).toBe('auto');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/job-group-match.test.ts test/api/job-groups.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the pure matcher**

`src/modules/master/job-group-match.ts`:
```ts
export interface JobGroupCriteria {
  truckTypeIds: string[];
  serviceTypeIds: string[];
  siteIds: string[];
  materialIds: string[];
  originZoneIds: string[];
  destZoneIds: string[];
}

export interface MatchInput {
  truckTypeId: string | null;
  serviceTypeId: string;
  materialId: string;
  siteIds: string[];
  originZoneId: string;
  destZoneId: string;
}

export interface MatchableGroup {
  id: string;
  criteria: JobGroupCriteria;
}

export type MatchResult =
  | { status: 'auto'; jobGroupId: string; candidates: string[] }
  | { status: 'ambiguous'; jobGroupId: null; candidates: string[] }
  | { status: 'none'; jobGroupId: null; candidates: [] };

const allows = (list: string[], value: string | null) => list.length === 0 || (value !== null && list.includes(value));

function matches(c: JobGroupCriteria, i: MatchInput): boolean {
  return (
    allows(c.truckTypeIds, i.truckTypeId) &&
    allows(c.serviceTypeIds, i.serviceTypeId) &&
    allows(c.materialIds, i.materialId) &&
    allows(c.originZoneIds, i.originZoneId) &&
    allows(c.destZoneIds, i.destZoneId) &&
    (c.siteIds.length === 0 || i.siteIds.some((s) => c.siteIds.includes(s)))
  );
}

function specificity(c: JobGroupCriteria): number {
  return Object.values(c).filter((list) => list.length > 0).length;
}

export function matchJobGroup(input: MatchInput, groups: MatchableGroup[]): MatchResult {
  const hits = groups.filter((g) => matches(g.criteria, input));
  if (hits.length === 0) return { status: 'none', jobGroupId: null, candidates: [] };
  const candidates = hits.map((g) => g.id).sort();
  const best = Math.max(...hits.map((g) => specificity(g.criteria)));
  const top = hits.filter((g) => specificity(g.criteria) === best);
  if (top.length === 1) return { status: 'auto', jobGroupId: top[0]!.id, candidates };
  return { status: 'ambiguous', jobGroupId: null, candidates: top.map((g) => g.id).sort() };
}
```

- [ ] **Step 4: Implement the job-group resource and match route**

`src/modules/master/job-groups.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Db } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { objectIdString } from '../../lib/ids.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { type JobGroupCriteria, type MatchResult, matchJobGroup } from './job-group-match.js';
import type { ResourceDef } from './resource.js';
import { Code, Name } from './simple.js';

const ids = z.array(objectIdString).default([]);
const Criteria = z
  .object({ truckTypeIds: ids, serviceTypeIds: ids, siteIds: ids, materialIds: ids, originZoneIds: ids, destZoneIds: ids })
  .default({});

const JobGroupBody = z.object({ code: Code, name: Name, criteria: Criteria });
const JobGroupItem = z.object({
  clientId: z.string(),
  code: z.string(),
  name: z.string(),
  criteria: z.object({
    truckTypeIds: z.array(z.string()),
    serviceTypeIds: z.array(z.string()),
    siteIds: z.array(z.string()),
    materialIds: z.array(z.string()),
    originZoneIds: z.array(z.string()),
    destZoneIds: z.array(z.string()),
  }),
});

export const jobGroupsDef: ResourceDef = {
  name: 'jobGroup',
  path: '/clients/:clientId/job-groups',
  collection: C.jobGroups,
  body: JobGroupBody,
  item: JobGroupItem,
  parent: { param: 'clientId', field: 'clientId', collection: C.clients },
  refs: [
    { path: 'criteria.truckTypeIds', collection: C.truckTypes, many: true },
    { path: 'criteria.serviceTypeIds', collection: C.serviceTypes, many: true },
    { path: 'criteria.siteIds', collection: C.locations, many: true },
    { path: 'criteria.materialIds', collection: C.materials, many: true },
    { path: 'criteria.originZoneIds', collection: C.zones, many: true },
    { path: 'criteria.destZoneIds', collection: C.zones, many: true },
  ],
  searchFields: ['code', 'name'],
  validate: async (merged, { db }) => {
    const siteIds = ((merged.criteria as { siteIds?: ObjectId[] } | undefined)?.siteIds ?? []) as ObjectId[];
    if (siteIds.length === 0) return;
    const notSites = await db.collection(C.locations).countDocuments({ _id: { $in: siteIds }, isSite: { $ne: true } });
    if (notSites > 0) throw unprocessable('NOT_A_SITE', 'criteria.siteIds must reference locations marked isSite');
  },
};

export interface DoMatchFields {
  truckTypeId: ObjectId | null;
  serviceTypeId: ObjectId;
  materialId: ObjectId;
  originLocationId: ObjectId;
  destLocationId: ObjectId;
}

type CriteriaDoc = { [K in keyof JobGroupCriteria]: ObjectId[] };

export async function matchJobGroupForDo(db: Db, clientId: ObjectId, f: DoMatchFields): Promise<MatchResult> {
  const locs = await db
    .collection(C.locations)
    .find({ _id: { $in: [f.originLocationId, f.destLocationId] } })
    .toArray();
  const origin = locs.find((l) => l._id.equals(f.originLocationId));
  const dest = locs.find((l) => l._id.equals(f.destLocationId));
  if (!origin || !dest) throw unprocessable('INVALID_REFERENCE', 'origin or destination location does not exist');
  const groups = await db.collection(C.jobGroups).find({ clientId, active: true }).toArray();
  const hex = (list: ObjectId[] = []) => list.map((i) => i.toHexString());
  return matchJobGroup(
    {
      truckTypeId: f.truckTypeId?.toHexString() ?? null,
      serviceTypeId: f.serviceTypeId.toHexString(),
      materialId: f.materialId.toHexString(),
      siteIds: [origin, dest].filter((l) => l.isSite === true).map((l) => l._id.toHexString()),
      originZoneId: (origin.zoneId as ObjectId).toHexString(),
      destZoneId: (dest.zoneId as ObjectId).toHexString(),
    },
    groups.map((g) => {
      const c = g.criteria as CriteriaDoc;
      return {
        id: g._id.toHexString(),
        criteria: {
          truckTypeIds: hex(c.truckTypeIds),
          serviceTypeIds: hex(c.serviceTypeIds),
          siteIds: hex(c.siteIds),
          materialIds: hex(c.materialIds),
          originZoneIds: hex(c.originZoneIds),
          destZoneIds: hex(c.destZoneIds),
        },
      };
    }),
  );
}

const MatchBody = z.object({
  truckTypeId: objectIdString.nullable().default(null),
  serviceTypeId: objectIdString,
  materialId: objectIdString,
  originLocationId: objectIdString,
  destLocationId: objectIdString,
});

const MatchResultSchema = z.object({
  status: z.enum(['auto', 'ambiguous', 'none']),
  jobGroupId: z.string().nullable(),
  candidates: z.array(z.string()),
});

export const jobGroupMatchRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/clients/:clientId/job-groups/match',
    {
      schema: { tags: ['jobGroup'], params: z.object({ clientId: objectIdString }), body: MatchBody, response: { 200: MatchResultSchema } },
      preHandler: app.requireRoles(...STAFF_ROLES),
    },
    async (req) => {
      const clientId = new ObjectId(req.params.clientId);
      if (!(await app.db.collection(C.clients).countDocuments({ _id: clientId }, { limit: 1 }))) throw notFound('client');
      const b = req.body;
      return matchJobGroupForDo(app.db, clientId, {
        truckTypeId: b.truckTypeId ? new ObjectId(b.truckTypeId) : null,
        serviceTypeId: new ObjectId(b.serviceTypeId),
        materialId: new ObjectId(b.materialId),
        originLocationId: new ObjectId(b.originLocationId),
        destLocationId: new ObjectId(b.destLocationId),
      });
    },
  );
};
```

Update `src/modules/master/master.routes.ts`: import `{ jobGroupMatchRoutes, jobGroupsDef } from './job-groups.js'`, append `jobGroupsDef` to `ALL_RESOURCE_DEFS`, and inside `masterRoutes` after the loop add `await app.register(jobGroupMatchRoutes);`.

Add to `INDEXES`:
```ts
  [C.jobGroups]: [{ key: { clientId: 1, code: 1 }, unique: true }, { key: { clientId: 1, active: 1 } }],
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: client job groups with criteria and most-specific-wins matching" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 10: POD templates (draft → published versions)

**Files:**
- Create: `src/modules/pod-templates/pod-templates.schemas.ts`, `src/modules/pod-templates/pod-templates.service.ts`, `src/modules/pod-templates/pod-templates.routes.ts`
- Modify: `src/routes.ts`, `src/db/indexes.ts`
- Test: `test/api/pod-templates.test.ts`

**Interfaces:**
- Consumes: `paginate`, `PageQuery`, `pageResponse`, `toApi`, `writeAudit`, `actorOf`, errors, `objectIdString`, `STAFF_ROLES`.
- Produces:
  - `POD_FIELD_TYPES = ['photo','signature','text','number','select','checkbox','qtyLines','palletLines']`, `EXTRA_STEPS = ['DOCS_SUBMITTED','DOCS_RETURNED','SEAL_CHECKED','TEMP_CHECKED']`, `PodFieldSchema`, `type PodField`.
  - `interface PodTemplateDoc { _id; clientId: ObjectId; jobGroupId: ObjectId|null; name; status: 'draft'|'published'; version: number|null; extraSteps; fields: PodField[]; publishedAt: Date|null; publishedBy: string|null; createdAt; updatedAt; createdBy }`
  - `resolvePodTemplate(db, clientId: ObjectId, jobGroupId: ObjectId|null): Promise<PodTemplateDoc|null>` — latest published for the job group, else latest published client default (jobGroupId null). Used by Plan 3.
  - Routes: `GET /pod-templates?clientId&jobGroupId&status`, `GET /pod-templates/:id`, `POST /pod-templates` (draft), `PATCH /pod-templates/:id` (draft only; 422 `TEMPLATE_PUBLISHED`), `POST /pod-templates/:id/publish`, `POST /pod-templates/:id/clone`.

- [ ] **Step 1: Write the failing test**

`test/api/pod-templates.test.ts`:
```ts
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { resolvePodTemplate } from '../../src/modules/pod-templates/pod-templates.service.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';

describe('POD templates', () => {
  let app: App;
  let h: { authorization: string };
  let scg: string;
  let cpac: string;
  let cold: string;
  let cpacGroup: string;
  const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });

  const coldFields = [
    { key: 'goodsPhoto', label: 'รูปสินค้า', type: 'photo', required: true, min: 1, max: 5 },
    { key: 'tempC', label: 'อุณหภูมิ (°C)', type: 'number', required: true, min: -30, max: 10, unit: '°C' },
    { key: 'receiverSign', label: 'ลายเซ็นผู้รับ', type: 'signature', required: true },
    { key: 'condition', label: 'สภาพสินค้า', type: 'select', options: ['ปกติ', 'เสียหาย'] },
  ];

  beforeAll(async () => {
    app = await buildTestApp();
    h = (await createUserAndLogin(app, ['planner'])).headers;
    scg = (await post('/clients', { code: 'SCG', name: 'SCG' })).json().id;
    cpac = (await post('/clients', { code: 'CPAC', name: 'CPAC' })).json().id;
    cold = (await post(`/clients/${scg}/job-groups`, { code: 'COLD', name: 'Coldchain', criteria: {} })).json().id;
    cpacGroup = (await post(`/clients/${cpac}/job-groups`, { code: 'RMC', name: 'Ready-mix', criteria: {} })).json().id;
  });
  afterAll(async () => closeTestApp(app));

  it('creates a draft, publishes version 1 then version 2 for the same scope', async () => {
    const d1 = await post('/pod-templates', { clientId: scg, jobGroupId: cold, name: 'Cold POD', extraSteps: ['TEMP_CHECKED'], fields: coldFields });
    expect(d1.statusCode).toBe(201);
    expect(d1.json()).toMatchObject({ status: 'draft', version: null });
    const p1 = await post(`/pod-templates/${d1.json().id}/publish`);
    expect(p1.json()).toMatchObject({ status: 'published', version: 1 });
    const d2 = await post(`/pod-templates/${d1.json().id}/clone`);
    expect(d2.json()).toMatchObject({ status: 'draft', version: null, fields: expect.any(Array) });
    const p2 = await post(`/pod-templates/${d2.json().id}/publish`);
    expect(p2.json().version).toBe(2);
  });

  it('refuses to edit or re-publish a published version', async () => {
    const d = (await post('/pod-templates', { clientId: scg, name: 'Default', fields: coldFields })).json();
    await post(`/pod-templates/${d.id}/publish`);
    const edit = await app.inject({ method: 'PATCH', url: `/api/v1/pod-templates/${d.id}`, headers: h, payload: { name: 'changed' } });
    expect(edit.statusCode).toBe(422);
    expect(edit.json().code).toBe('TEMPLATE_PUBLISHED');
    expect((await post(`/pod-templates/${d.id}/publish`)).json().code).toBe('TEMPLATE_PUBLISHED');
  });

  it('validates fields', async () => {
    const noOptions = await post('/pod-templates', { clientId: scg, name: 'x', fields: [{ key: 'c', label: 'c', type: 'select' }] });
    expect(noOptions.statusCode).toBe(400);
    const dupKeys = await post('/pod-templates', { clientId: scg, name: 'x', fields: [{ key: 'a', label: 'a', type: 'text' }, { key: 'a', label: 'b', type: 'text' }] });
    expect(dupKeys.statusCode).toBe(400);
    const badKey = await post('/pod-templates', { clientId: scg, name: 'x', fields: [{ key: 'Bad Key', label: 'a', type: 'text' }] });
    expect(badKey.statusCode).toBe(400);
  });

  it('rejects a job group from another client and unknown clients', async () => {
    const res = await post('/pod-templates', { clientId: scg, jobGroupId: cpacGroup, name: 'x', fields: coldFields });
    expect(res.json().code).toBe('JOB_GROUP_CLIENT_MISMATCH');
    const unknown = await post('/pod-templates', { clientId: '0123456789abcdef01234567', name: 'x', fields: coldFields });
    expect(unknown.json().code).toBe('INVALID_REFERENCE');
  });

  it('resolves the latest published template for a group, falling back to the client default', async () => {
    const byGroup = await resolvePodTemplate(app.db, new ObjectId(scg), new ObjectId(cold));
    expect(byGroup?.version).toBe(2);
    const fallback = await resolvePodTemplate(app.db, new ObjectId(scg), new ObjectId());
    expect(fallback?.name).toBe('Default');
    expect(await resolvePodTemplate(app.db, new ObjectId(cpac), null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api/pod-templates.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement schemas and service**

`src/modules/pod-templates/pod-templates.schemas.ts`:
```ts
import { z } from 'zod';
import { objectIdString } from '../../lib/ids.js';

export const POD_FIELD_TYPES = ['photo', 'signature', 'text', 'number', 'select', 'checkbox', 'qtyLines', 'palletLines'] as const;
export const EXTRA_STEPS = ['DOCS_SUBMITTED', 'DOCS_RETURNED', 'SEAL_CHECKED', 'TEMP_CHECKED'] as const;

export const PodFieldSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/, 'key must be camelCase letters/digits, starting with a lowercase letter'),
    label: z.string().trim().min(1).max(200),
    type: z.enum(POD_FIELD_TYPES),
    required: z.boolean().default(false),
    min: z.number().optional(),
    max: z.number().optional(),
    unit: z.string().trim().max(20).optional(),
    options: z.array(z.string().trim().min(1)).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.type === 'select' && !f.options?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'select fields need at least one option' });
    }
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['min'], message: 'min must be <= max' });
    }
  });

export type PodField = z.infer<typeof PodFieldSchema>;

export const PodFieldsSchema = z
  .array(PodFieldSchema)
  .min(1)
  .max(50)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    fields.forEach((f, i) => {
      if (seen.has(f.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'key'], message: `duplicate key ${f.key}` });
      seen.add(f.key);
    });
  });

export const CreatePodTemplateBody = z.object({
  clientId: objectIdString,
  jobGroupId: objectIdString.nullable().default(null),
  name: z.string().trim().min(1).max(200),
  extraSteps: z.array(z.enum(EXTRA_STEPS)).default([]),
  fields: PodFieldsSchema,
});

export const PatchPodTemplateBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  extraSteps: z.array(z.enum(EXTRA_STEPS)).optional(),
  fields: PodFieldsSchema.optional(),
});

export const PodTemplateItem = z.object({
  id: z.string(),
  clientId: z.string(),
  jobGroupId: z.string().nullable(),
  name: z.string(),
  status: z.enum(['draft', 'published']),
  version: z.number().nullable(),
  extraSteps: z.array(z.enum(EXTRA_STEPS)),
  fields: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.enum(POD_FIELD_TYPES),
      required: z.boolean(),
      min: z.number().optional(),
      max: z.number().optional(),
      unit: z.string().optional(),
      options: z.array(z.string()).optional(),
    }),
  ),
  publishedAt: z.string().nullable(),
  publishedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
});
```

`src/modules/pod-templates/pod-templates.service.ts`:
```ts
import type { Db, ObjectId } from 'mongodb';
import { C } from '../../db/collections.js';
import type { EXTRA_STEPS, PodField } from './pod-templates.schemas.js';

export interface PodTemplateDoc {
  _id: ObjectId;
  clientId: ObjectId;
  jobGroupId: ObjectId | null;
  name: string;
  status: 'draft' | 'published';
  version: number | null;
  extraSteps: (typeof EXTRA_STEPS)[number][];
  fields: PodField[];
  publishedAt: Date | null;
  publishedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
}

export async function resolvePodTemplate(db: Db, clientId: ObjectId, jobGroupId: ObjectId | null): Promise<PodTemplateDoc | null> {
  const coll = db.collection<PodTemplateDoc>(C.podTemplates);
  const latest = (jg: ObjectId | null) =>
    coll.find({ clientId, jobGroupId: jg, status: 'published' }).sort({ version: -1 }).limit(1).next();
  if (jobGroupId) {
    const specific = await latest(jobGroupId);
    if (specific) return specific;
  }
  return latest(null);
}
```

- [ ] **Step 4: Implement routes and wiring**

`src/modules/pod-templates/pod-templates.routes.ts`:
```ts
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf, writeAudit } from '../../lib/audit.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { IdParams, objectIdString } from '../../lib/ids.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import { CreatePodTemplateBody, PatchPodTemplateBody, PodTemplateItem } from './pod-templates.schemas.js';
import type { PodTemplateDoc } from './pod-templates.service.js';

const published = () => unprocessable('TEMPLATE_PUBLISHED', 'Published templates cannot be changed; clone it to make a new draft');

export const podTemplateRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = app.requireRoles(...STAFF_ROLES);
  const write = app.requireRoles('admin', 'planner');
  const coll = () => app.db.collection<PodTemplateDoc>(C.podTemplates);

  const load = async (id: string) => {
    const doc = await coll().findOne({ _id: new ObjectId(id) });
    if (!doc) throw notFound('POD template');
    return doc;
  };

  app.get(
    '/pod-templates',
    {
      schema: {
        tags: ['pod-templates'],
        querystring: PageQuery.extend({ clientId: objectIdString.optional(), jobGroupId: objectIdString.optional(), status: z.enum(['draft', 'published']).optional() }),
        response: { 200: pageResponse(PodTemplateItem) },
      },
      preHandler: read,
    },
    async (req) => {
      const f: Filter<PodTemplateDoc> = {};
      if (req.query.clientId) f.clientId = new ObjectId(req.query.clientId);
      if (req.query.jobGroupId) f.jobGroupId = new ObjectId(req.query.jobGroupId);
      if (req.query.status) f.status = req.query.status;
      const page = await paginate(coll(), f, req.query);
      return { items: page.items.map(toApi), nextCursor: page.nextCursor };
    },
  );

  app.get('/pod-templates/:id', { schema: { tags: ['pod-templates'], params: IdParams, response: { 200: PodTemplateItem } }, preHandler: read }, async (req) =>
    toApi(await load(req.params.id)),
  );

  app.post('/pod-templates', { schema: { tags: ['pod-templates'], body: CreatePodTemplateBody, response: { 201: PodTemplateItem } }, preHandler: write }, async (req, reply) => {
    const clientId = new ObjectId(req.body.clientId);
    if (!(await app.db.collection(C.clients).countDocuments({ _id: clientId }, { limit: 1 }))) {
      throw unprocessable('INVALID_REFERENCE', 'clientId does not exist', { field: 'clientId' });
    }
    const jobGroupId = req.body.jobGroupId ? new ObjectId(req.body.jobGroupId) : null;
    if (jobGroupId) {
      const jg = await app.db.collection(C.jobGroups).findOne({ _id: jobGroupId });
      if (!jg) throw unprocessable('INVALID_REFERENCE', 'jobGroupId does not exist', { field: 'jobGroupId' });
      if (!(jg.clientId as ObjectId).equals(clientId)) throw unprocessable('JOB_GROUP_CLIENT_MISMATCH', 'Job group belongs to a different client');
    }
    const now = new Date();
    const by = actorOf(req);
    const doc: Omit<PodTemplateDoc, '_id'> = {
      clientId, jobGroupId, name: req.body.name, status: 'draft', version: null,
      extraSteps: req.body.extraSteps, fields: req.body.fields,
      publishedAt: null, publishedBy: null, createdAt: now, updatedAt: now, createdBy: by,
    };
    const res = await coll().insertOne(doc as PodTemplateDoc);
    const saved = { ...doc, _id: res.insertedId };
    await writeAudit(app.db, { entity: 'podTemplate', entityId: res.insertedId.toHexString(), action: 'create', by, after: toApi(saved) });
    return reply.status(201).send(toApi(saved));
  });

  app.patch('/pod-templates/:id', { schema: { tags: ['pod-templates'], params: IdParams, body: PatchPodTemplateBody, response: { 200: PodTemplateItem } }, preHandler: write }, async (req) => {
    const existing = await load(req.params.id);
    if (existing.status === 'published') throw published();
    const updated = await coll().findOneAndUpdate(
      { _id: existing._id, status: 'draft' },
      { $set: { ...req.body, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!updated) throw published();
    await writeAudit(app.db, { entity: 'podTemplate', entityId: req.params.id, action: 'update', by: actorOf(req), before: toApi(existing), after: toApi(updated) });
    return toApi(updated);
  });

  app.post('/pod-templates/:id/publish', { schema: { tags: ['pod-templates'], params: IdParams, response: { 200: PodTemplateItem } }, preHandler: write }, async (req) => {
    const draft = await load(req.params.id);
    if (draft.status === 'published') throw published();
    const last = await coll()
      .find({ clientId: draft.clientId, jobGroupId: draft.jobGroupId, status: 'published' })
      .sort({ version: -1 })
      .limit(1)
      .next();
    const by = actorOf(req);
    const updated = await coll().findOneAndUpdate(
      { _id: draft._id, status: 'draft' },
      { $set: { status: 'published', version: (last?.version ?? 0) + 1, publishedAt: new Date(), publishedBy: by, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!updated) throw published();
    await writeAudit(app.db, { entity: 'podTemplate', entityId: req.params.id, action: 'publish', by, after: toApi(updated) });
    return toApi(updated);
  });

  app.post('/pod-templates/:id/clone', { schema: { tags: ['pod-templates'], params: IdParams, response: { 201: PodTemplateItem } }, preHandler: write }, async (req, reply) => {
    const src = await load(req.params.id);
    const now = new Date();
    const by = actorOf(req);
    const { _id: _src, ...rest } = src;
    const doc: Omit<PodTemplateDoc, '_id'> = {
      ...rest, status: 'draft', version: null, publishedAt: null, publishedBy: null, createdAt: now, updatedAt: now, createdBy: by,
    };
    const res = await coll().insertOne(doc as PodTemplateDoc);
    const saved = { ...doc, _id: res.insertedId };
    await writeAudit(app.db, { entity: 'podTemplate', entityId: res.insertedId.toHexString(), action: 'clone', by, after: { from: req.params.id } });
    return reply.status(201).send(toApi(saved));
  });
};
```

In `src/routes.ts` add `import { podTemplateRoutes } from './modules/pod-templates/pod-templates.routes.js';` and `await api.register(podTemplateRoutes);`.

Add to `INDEXES`:
```ts
  [C.podTemplates]: [
    { key: { clientId: 1, jobGroupId: 1, status: 1, version: -1 } },
    {
      key: { clientId: 1, jobGroupId: 1, version: 1 },
      unique: true,
      partialFilterExpression: { status: 'published' },
    },
  ],
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: versioned POD templates per client and job group with resolution fallback" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 11: Excel/CSV import for master data

**Files:**
- Create: `src/modules/imports/parse.ts`, `src/modules/imports/specs.ts`, `src/modules/imports/imports.service.ts`, `src/modules/imports/imports.routes.ts`, `test/helpers/multipart.ts`
- Modify: `src/routes.ts`
- Test: `test/unit/import-parse.test.ts`, `test/api/imports.test.ts`

**Interfaces:**
- Consumes: `ResourceDef`, `prepareDoc`, the `*Def` objects from Tasks 7–8, `normalizePlate`, `writeAudit`, errors.
- Produces:
  - `parseTable(buf: Buffer, filename: string): Promise<{ rowNumber: number; values: Record<string, string> }[]>` — header names lower-cased; `.csv` (UTF-8, BOM ok) and `.xlsx` (first sheet; formula → result, dates → `YYYY-MM-DD`, numbers → string).
  - `IMPORT_ENTITIES = ['clients','zones','materials','service-types','truck-types','locations','vehicles','drivers']`; `IMPORT_SPECS: Record<ImportEntity, ImportSpec>`.
  - `runImport(db, entity, rows, { dryRun, by }) → ImportReport` where `ImportReport = { entity, dryRun, total, created, updated, errors, rows: { row, key, action: 'create'|'update'|'error', errors: string[] }[] }`. Non-dry run with any error → 422 `IMPORT_HAS_ERRORS` (details = report), nothing written.
  - Route `POST /imports/:entity?dryRun=true|false` (default `true`), multipart field `file`, max 5 MB.

Column reference (header row, case-insensitive):

| Entity | Columns |
|---|---|
| clients, zones, service-types | `code, name` |
| materials | `code, name, unit` |
| truck-types | `code, name, category` |
| locations | `code, name, zoneCode, clientCode?, isSite?, address?, lat, lng, geofenceRadiusM?` |
| vehicles | `plate, part, truckTypeCode, gpsVendor?, gpsId?` |
| drivers | `code, name, phone?, licenseType?, licenseExpiry?` |

- [ ] **Step 1: Install**

Run: `npm i @fastify/multipart@^9 exceljs@^4 csv-parse@^5`

- [ ] **Step 2: Write the failing tests**

`test/helpers/multipart.ts`:
```ts
import { randomUUID } from 'node:crypto';

export function multipartFile(filename: string, content: Buffer | string, contentType: string) {
  const boundary = `----test${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
```

`test/unit/import-parse.test.ts`:
```ts
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseTable } from '../../src/modules/imports/parse.js';

describe('parseTable', () => {
  it('parses CSV with BOM and Thai text, lower-casing headers', async () => {
    const csv = '﻿Code,Name\nBKK,กรุงเทพ\n\nNE,อีสาน\n';
    const rows = await parseTable(Buffer.from(csv, 'utf8'), 'zones.csv');
    expect(rows.map((r) => r.values)).toEqual([{ code: 'BKK', name: 'กรุงเทพ' }, { code: 'NE', name: 'อีสาน' }]);
  });

  it('parses xlsx numbers, formulas and dates as display strings', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('data');
    ws.addRow(['code', 'lat', 'radius', 'expiry']);
    ws.addRow(['SRB', 14.53, null, new Date('2027-05-31T00:00:00Z')]);
    ws.getCell('C2').value = { formula: '100*3', result: 300 };
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const rows = await parseTable(buf, 'x.xlsx');
    expect(rows).toEqual([{ rowNumber: 2, values: { code: 'SRB', lat: '14.53', radius: '300', expiry: '2027-05-31' } }]);
  });

  it('rejects other file types', async () => {
    await expect(parseTable(Buffer.from('x'), 'x.txt')).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
  });
});
```

`test/api/imports.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';
import { multipartFile } from '../helpers/multipart.js';

describe('imports', () => {
  let app: App;
  let h: { authorization: string };

  const upload = (entity: string, csv: string, dryRun: boolean) => {
    const mp = multipartFile(`${entity}.csv`, csv, 'text/csv');
    return app.inject({ method: 'POST', url: `/api/v1/imports/${entity}?dryRun=${dryRun}`, headers: { ...h, ...mp.headers }, payload: mp.payload });
  };

  beforeAll(async () => {
    app = await buildTestApp();
    h = (await createUserAndLogin(app, ['planner'])).headers;
  });
  afterAll(async () => closeTestApp(app));

  it('dry run reports creates without writing; real run writes', async () => {
    const csv = 'code,name\nBKK,กรุงเทพ\nNE,อีสาน\n';
    const dry = await upload('zones', csv, true);
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ dryRun: true, total: 2, created: 2, updated: 0, errors: 0 });
    expect(await app.db.collection(C.zones).countDocuments()).toBe(0);
    const real = await upload('zones', csv, false);
    expect(real.json()).toMatchObject({ dryRun: false, created: 2 });
    expect(await app.db.collection(C.zones).countDocuments()).toBe(2);
    const again = await upload('zones', 'code,name\nBKK,Bangkok\n', false);
    expect(again.json()).toMatchObject({ created: 0, updated: 1 });
    expect((await app.db.collection(C.zones).findOne({ code: 'BKK' }))?.name).toBe('Bangkok');
  });

  it('resolves codes to ids and reports unknown codes per row without saving anything', async () => {
    const csv = [
      'code,name,zoneCode,isSite,lat,lng',
      'SRB,โรงงานสระบุรี,BKK,yes,14.53,100.91',
      'XXX,Unknown zone,NOPE,no,13,100',
      'BAD,Bad lat,BKK,no,abc,100',
    ].join('\n');
    const res = await upload('locations', csv, false);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('IMPORT_HAS_ERRORS');
    const rows = res.json().details.rows;
    expect(rows[0]).toMatchObject({ row: 2, action: 'create', errors: [] });
    expect(rows[1].errors[0]).toMatch(/zoneCode.*NOPE/);
    expect(rows[2].errors[0]).toMatch(/lat/);
    expect(await app.db.collection(C.locations).countDocuments()).toBe(0);
  });

  it('matches vehicles by normalised plate and flags duplicates within a file', async () => {
    await upload('truck-types', 'code,name,category\nTRAILER,Trailer,tractor\n', false);
    const first = await upload('vehicles', 'plate,part,truckTypeCode\n 70-1234 ,head,TRAILER\n', false);
    expect(first.json().created).toBe(1);
    const second = await upload('vehicles', 'plate,part,truckTypeCode,gpsId\n70-1234,head,TRAILER,G-1\n', false);
    expect(second.json()).toMatchObject({ created: 0, updated: 1 });
    const dup = await upload('vehicles', 'plate,part,truckTypeCode\n71-1,head,TRAILER\n72-2,head,TRAILER\n 71-1 ,head,TRAILER\n', true);
    expect(dup.json().rows[1].errors).toEqual([]);
    expect(dup.json().rows[2].errors[0]).toMatch(/duplicate/i);
  });

  it('rejects unknown entities and missing files', async () => {
    const mp = multipartFile('x.csv', 'code,name\n', 'text/csv');
    expect((await app.inject({ method: 'POST', url: '/api/v1/imports/nope', headers: { ...h, ...mp.headers }, payload: mp.payload })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/unit/import-parse.test.ts test/api/imports.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement parsing**

`src/modules/imports/parse.ts`:
```ts
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { badRequest } from '../../lib/errors.js';

export type ParsedRow = { rowNumber: number; values: Record<string, string> };

const normHeader = (h: string) => h.trim().toLowerCase();

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellText((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('');
    if ('text' in v) return String((v as ExcelJS.CellHyperlinkValue).text);
    return '';
  }
  return String(v);
}

export async function parseTable(buf: Buffer, filename: string): Promise<ParsedRow[]> {
  const name = filename.toLowerCase();
  if (name.endsWith('.csv')) {
    const records = parse(buf, {
      columns: (header: string[]) => header.map(normHeader),
      skip_empty_lines: true,
      trim: true,
      bom: true,
      info: true,
    }) as { record: Record<string, string>; info: { lines: number } }[];
    return records.map((r) => ({ rowNumber: r.info.lines, values: r.record }));
  }
  if (name.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col] = normHeader(cellText(cell.value));
    });
    const rows: ParsedRow[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const values: Record<string, string> = {};
      headers.forEach((h, col) => {
        if (h) values[h] = cellText(row.getCell(col).value).trim();
      });
      if (Object.values(values).some((v) => v !== '')) rows.push({ rowNumber, values });
    });
    return rows;
  }
  throw badRequest('UNSUPPORTED_FILE', 'Upload a .csv or .xlsx file');
}
```

- [ ] **Step 5: Implement specs, service and route**

`src/modules/imports/specs.ts`:
```ts
import { C } from '../../db/collections.js';
import { driversDef, normalizePlate, vehiclesDef } from '../master/fleet.js';
import { locationsDef } from '../master/locations.js';
import type { ResourceDef } from '../master/resource.js';
import { clientsDef, materialsDef, serviceTypesDef, truckTypesDef, zonesDef } from '../master/simple.js';

export class RowError extends Error {}

export interface ImportCtx {
  idByCode(collection: string, code: string, column: string): Promise<string>;
}

type Get = (column: string) => string | undefined;

export interface ImportSpec {
  def: ResourceDef;
  key: 'code' | 'plate';
  keyOf(get: Get): string | undefined;
  toBody(get: Get, ctx: ImportCtx): Promise<Record<string, unknown>>;
}

export const IMPORT_ENTITIES = ['clients', 'zones', 'materials', 'service-types', 'truck-types', 'locations', 'vehicles', 'drivers'] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

function bool(v: string | undefined, column: string): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  throw new RowError(`${column}: expected yes/no, got "${v}"`);
}

function num(v: string | undefined, column: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new RowError(`${column}: expected a number, got "${v}"`);
  return n;
}

const byCode = (get: Get) => get('code');

const simple = (def: ResourceDef, extra: string[] = []): ImportSpec => ({
  def,
  key: 'code',
  keyOf: byCode,
  toBody: async (get) => Object.fromEntries(['code', 'name', ...extra].map((c) => [c, get(c)])),
});

export const IMPORT_SPECS: Record<ImportEntity, ImportSpec> = {
  clients: simple(clientsDef),
  zones: simple(zonesDef),
  materials: simple(materialsDef, ['unit']),
  'service-types': simple(serviceTypesDef),
  'truck-types': simple(truckTypesDef, ['category']),
  locations: {
    def: locationsDef,
    key: 'code',
    keyOf: byCode,
    toBody: async (get, ctx) => {
      const zoneCode = get('zoneCode');
      const clientCode = get('clientCode');
      return {
        code: get('code'),
        name: get('name'),
        zoneId: zoneCode === undefined ? undefined : await ctx.idByCode(C.zones, zoneCode, 'zoneCode'),
        clientId: clientCode === undefined ? undefined : await ctx.idByCode(C.clients, clientCode, 'clientCode'),
        isSite: bool(get('isSite'), 'isSite'),
        address: get('address'),
        lat: num(get('lat'), 'lat'),
        lng: num(get('lng'), 'lng'),
        geofenceRadiusM: num(get('geofenceRadiusM'), 'geofenceRadiusM'),
      };
    },
  },
  vehicles: {
    def: vehiclesDef,
    key: 'plate',
    keyOf: (get) => {
      const p = get('plate');
      return p === undefined ? undefined : normalizePlate(p);
    },
    toBody: async (get, ctx) => {
      const tt = get('truckTypeCode');
      return {
        plate: get('plate'),
        part: get('part'),
        truckTypeId: tt === undefined ? undefined : await ctx.idByCode(C.truckTypes, tt, 'truckTypeCode'),
        gpsVendor: get('gpsVendor'),
        gpsId: get('gpsId'),
      };
    },
  },
  drivers: simple(driversDef, ['phone', 'licenseType', 'licenseExpiry']),
};
```

`src/modules/imports/imports.service.ts`:
```ts
import { ObjectId, type AnyBulkWriteOperation, type Db, type Document } from 'mongodb';
import { AppError, unprocessable } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { prepareDoc } from '../master/resource.js';
import type { ParsedRow } from './parse.js';
import { IMPORT_SPECS, type ImportCtx, type ImportEntity, RowError } from './specs.js';

export interface ImportRowResult {
  row: number;
  key: string | null;
  action: 'create' | 'update' | 'error';
  errors: string[];
}

export interface ImportReport {
  entity: ImportEntity;
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  errors: number;
  rows: ImportRowResult[];
}

export async function runImport(
  db: Db,
  entity: ImportEntity,
  rows: ParsedRow[],
  opts: { dryRun: boolean; by: string },
): Promise<ImportReport> {
  const spec = IMPORT_SPECS[entity];
  const coll = db.collection(spec.def.collection);
  const cache = new Map<string, string>();
  const ctx: ImportCtx = {
    async idByCode(collection, code, column) {
      const k = `${collection}:${code}`;
      const hit = cache.get(k);
      if (hit) return hit;
      const doc = await db.collection(collection).findOne({ code }, { projection: { _id: 1 } });
      if (!doc) throw new RowError(`${column}: unknown code "${code}"`);
      const id = doc._id.toHexString();
      cache.set(k, id);
      return id;
    },
  };

  const results: ImportRowResult[] = [];
  const ops: AnyBulkWriteOperation<Document>[] = [];
  const seen = new Set<string>();
  const now = new Date();

  for (const { rowNumber, values } of rows) {
    const get = (column: string) => {
      const v = values[column.toLowerCase()];
      return v === undefined || v === '' ? undefined : v;
    };
    const dupKey = spec.keyOf(get) ?? null;
    const result: ImportRowResult = { row: rowNumber, key: dupKey, action: 'error', errors: [] };
    try {
      if (dupKey !== null) {
        if (seen.has(dupKey)) throw new RowError(`duplicate ${spec.key} "${dupKey}" earlier in this file`);
        seen.add(dupKey);
      }
      const parsed = spec.def.body.safeParse(await spec.toBody(get, ctx));
      if (!parsed.success) {
        result.errors = parsed.error.issues.map((i) => `${i.path.join('.') || 'row'}: ${i.message}`);
      } else {
        const keyValue = (spec.def.toDb ? spec.def.toDb({ ...parsed.data }) : parsed.data)[spec.key];
        result.key = String(keyValue);
        const existing = await coll.findOne({ [spec.key]: keyValue });
        const prepared = await prepareDoc(spec.def, db, parsed.data as Record<string, unknown>, existing);
        if (existing) {
          result.action = 'update';
          ops.push({ updateOne: { filter: { _id: existing._id as ObjectId }, update: { $set: { ...prepared, updatedAt: now } } } });
        } else {
          result.action = 'create';
          ops.push({ insertOne: { document: { ...prepared, active: true, createdAt: now, updatedAt: now } } });
        }
      }
    } catch (e) {
      if (e instanceof RowError || e instanceof AppError) result.errors = [e.message];
      else throw e;
    }
    if (result.errors.length > 0) result.action = 'error';
    results.push(result);
  }

  const report: ImportReport = {
    entity,
    dryRun: opts.dryRun,
    total: results.length,
    created: results.filter((r) => r.action === 'create').length,
    updated: results.filter((r) => r.action === 'update').length,
    errors: results.filter((r) => r.action === 'error').length,
    rows: results,
  };

  if (opts.dryRun) return report;
  if (report.errors > 0) throw unprocessable('IMPORT_HAS_ERRORS', `${report.errors} row(s) have errors; nothing was saved`, report);
  if (ops.length > 0) await coll.bulkWrite(ops, { ordered: true });
  await writeAudit(db, { entity: 'import', entityId: entity, action: 'import', by: opts.by, after: { created: report.created, updated: report.updated } });
  return report;
}
```

`src/modules/imports/imports.routes.ts`:
```ts
import multipart from '@fastify/multipart';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf } from '../../lib/audit.js';
import { badRequest } from '../../lib/errors.js';
import { runImport } from './imports.service.js';
import { parseTable } from './parse.js';
import { IMPORT_ENTITIES } from './specs.js';

const ReportSchema = z.object({
  entity: z.enum(IMPORT_ENTITIES),
  dryRun: z.boolean(),
  total: z.number(),
  created: z.number(),
  updated: z.number(),
  errors: z.number(),
  rows: z.array(z.object({ row: z.number(), key: z.string().nullable(), action: z.enum(['create', 'update', 'error']), errors: z.array(z.string()) })),
});

export const importRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

  app.post(
    '/imports/:entity',
    {
      schema: {
        tags: ['imports'],
        consumes: ['multipart/form-data'],
        params: z.object({ entity: z.enum(IMPORT_ENTITIES) }),
        querystring: z.object({ dryRun: z.enum(['true', 'false']).default('true') }),
        response: { 200: ReportSchema },
      },
      preHandler: app.requireRoles('admin', 'planner'),
    },
    async (req) => {
      const file = await req.file();
      if (!file) throw badRequest('FILE_REQUIRED', 'Attach the file in the "file" form field');
      const rows = await parseTable(await file.toBuffer(), file.filename);
      return runImport(app.db, req.params.entity, rows, { dryRun: req.query.dryRun === 'true', by: actorOf(req) });
    },
  );
};
```

In `src/routes.ts` add `import { importRoutes } from './modules/imports/imports.routes.js';` and `await api.register(importRoutes);`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: CSV/Excel master-data import with dry run and all-or-nothing apply" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

### Task 12: Seed script and README

**Files:**
- Create: `src/seed/seed.ts`, `scripts/seed.ts`, `README.md`
- Test: `test/unit/seed.test.ts`

**Interfaces:**
- Consumes: `createUser`, `findUserByUsername`, `ensureIndexes`, `matchJobGroupForDo`, `C`.
- Produces: `BASE_TRUCK_TYPES` (MIXER rigid, TRAILER tractor, FEEDMILL rigid, COLDCHAIN rigid, SIDE_CURTAIN rigid), `BASE_PALLET_MOVEMENT_TYPES` (RETURN_IN รับคืน +1, BORROW_CUSTOMER ยืมลค. +1, DEPOSIT นำฝาก −1, RETURN_CUSTOMER คืนลค. −1), `seedBase(db)`, `seedAdmin(db, username, password) → 'created'|'exists'`, `seedDemo(db)`; CLI `npm run seed [-- --demo]`.

- [ ] **Step 1: Write the failing test**

`test/unit/seed.test.ts`:
```ts
import type { Db, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { C } from '../../src/db/collections.js';
import { ensureIndexes } from '../../src/db/indexes.js';
import { verifyPassword } from '../../src/lib/passwords.js';
import { matchJobGroupForDo } from '../../src/modules/master/job-groups.js';
import { findUserByUsername } from '../../src/modules/users/users.repo.js';
import { seedAdmin, seedBase, seedDemo } from '../../src/seed/seed.js';
import { testDb } from '../helpers/db.js';

describe('seed', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await testDb());
    await ensureIndexes(db);
  });
  afterAll(async () => close());

  it('seeds base data idempotently without overwriting edits', async () => {
    await seedBase(db);
    await db.collection(C.truckTypes).updateOne({ code: 'MIXER' }, { $set: { name: 'Mixer 6 คิว' } });
    await seedBase(db);
    expect(await db.collection(C.truckTypes).countDocuments()).toBe(5);
    expect(await db.collection(C.palletMovementTypes).countDocuments()).toBe(4);
    expect((await db.collection(C.truckTypes).findOne({ code: 'MIXER' }))?.name).toBe('Mixer 6 คิว');
  });

  it('creates the admin once', async () => {
    expect(await seedAdmin(db, 'admin', 'Admin-pass-1')).toBe('created');
    expect(await seedAdmin(db, 'admin', 'other')).toBe('exists');
    const admin = await findUserByUsername(db, 'admin');
    expect(admin?.roles).toEqual(['admin']);
    expect(await verifyPassword(admin!.passwordHash, 'Admin-pass-1')).toBe(true);
  });

  it('seeds demo data idempotently and it matches a job group', async () => {
    await seedDemo(db);
    await seedDemo(db);
    expect(await db.collection(C.clients).countDocuments({ code: 'DEMO' })).toBe(1);
    const client = await db.collection(C.clients).findOne({ code: 'DEMO' });
    const byCode = async (coll: string, code: string) => (await db.collection(coll).findOne({ code }))!._id as ObjectId;
    const result = await matchJobGroupForDo(db, client!._id, {
      truckTypeId: await byCode(C.truckTypes, 'MIXER'),
      serviceTypeId: await byCode(C.serviceTypes, 'SINGLE'),
      materialId: await byCode(C.materials, 'READYMIX'),
      originLocationId: await byCode(C.locations, 'DEMO-PLANT'),
      destLocationId: await byCode(C.locations, 'DEMO-SITE-BKK'),
    });
    expect(result.status).toBe('auto');
    expect(await db.collection(C.podTemplates).countDocuments({ clientId: client!._id, status: 'published' })).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/seed.test.ts`
Expected: FAIL — cannot resolve `seed.js`.

- [ ] **Step 3: Implement seed functions**

`src/seed/seed.ts`:
```ts
import type { Db, Document, ObjectId } from 'mongodb';
import { C } from '../db/collections.js';
import { createUser, findUserByUsername } from '../modules/users/users.repo.js';

export const BASE_TRUCK_TYPES = [
  { code: 'MIXER', name: 'Mixer', category: 'rigid' },
  { code: 'TRAILER', name: 'Trailer (หัวลาก + หาง)', category: 'tractor' },
  { code: 'FEEDMILL', name: 'Feedmill', category: 'rigid' },
  { code: 'COLDCHAIN', name: 'Coldchain', category: 'rigid' },
  { code: 'SIDE_CURTAIN', name: 'Side Curtain', category: 'rigid' },
] as const;

export const BASE_PALLET_MOVEMENT_TYPES = [
  { code: 'RETURN_IN', name: 'รับคืน', sign: 1 },
  { code: 'BORROW_CUSTOMER', name: 'ยืมลค.', sign: 1 },
  { code: 'DEPOSIT', name: 'นำฝาก', sign: -1 },
  { code: 'RETURN_CUSTOMER', name: 'คืนลค.', sign: -1 },
] as const;

// Inserts by `code` only when missing, so later edits in the admin panel are never overwritten.
async function upsertByCode(db: Db, collection: string, doc: Document): Promise<ObjectId> {
  const now = new Date();
  const res = await db.collection(collection).findOneAndUpdate(
    { code: doc.code },
    { $setOnInsert: { ...doc, active: true, createdAt: now, updatedAt: now } },
    { upsert: true, returnDocument: 'after' },
  );
  return res!._id as ObjectId;
}

export async function seedBase(db: Db): Promise<void> {
  for (const t of BASE_TRUCK_TYPES) await upsertByCode(db, C.truckTypes, { ...t });
  for (const p of BASE_PALLET_MOVEMENT_TYPES) await upsertByCode(db, C.palletMovementTypes, { ...p });
}

export async function seedAdmin(db: Db, username: string, password: string): Promise<'created' | 'exists'> {
  if (await findUserByUsername(db, username)) return 'exists';
  await createUser(db, { username, password, roles: ['admin'] });
  return 'created';
}

export async function seedDemo(db: Db): Promise<void> {
  await seedBase(db);
  const clientId = await upsertByCode(db, C.clients, { code: 'DEMO', name: 'Demo Client' });
  const zBkk = await upsertByCode(db, C.zones, { code: 'BKK', name: 'กรุงเทพฯ' });
  const zCen = await upsertByCode(db, C.zones, { code: 'CEN', name: 'ภาคกลาง' });
  const readymix = await upsertByCode(db, C.materials, { code: 'READYMIX', name: 'คอนกรีตผสมเสร็จ', unit: 'm3' });
  await upsertByCode(db, C.materials, { code: 'BAGCEMENT', name: 'ปูนถุง', unit: 'bag' });
  await upsertByCode(db, C.serviceTypes, { code: 'SINGLE', name: 'ส่งเที่ยวเดียว' });
  await upsertByCode(db, C.serviceTypes, { code: 'DAILY', name: 'เหมาวัน' });
  const mixer = (await db.collection(C.truckTypes).findOne({ code: 'MIXER' }))!._id as ObjectId;
  const plant = await upsertByCode(db, C.locations, {
    code: 'DEMO-PLANT', name: 'Demo batching plant', clientId, zoneId: zCen, isSite: true, address: null,
    geo: { type: 'Point', coordinates: [100.91, 14.53] }, geofenceRadiusM: 300,
  });
  await upsertByCode(db, C.locations, {
    code: 'DEMO-SITE-BKK', name: 'Demo construction site', clientId, zoneId: zBkk, isSite: false, address: 'Bangkok',
    geo: { type: 'Point', coordinates: [100.53, 13.74] }, geofenceRadiusM: 300,
  });
  const now = new Date();
  const group = await db.collection(C.jobGroups).findOneAndUpdate(
    { clientId, code: 'RMC-PLANT' },
    {
      $setOnInsert: {
        clientId, code: 'RMC-PLANT', name: 'Ready-mix from demo plant',
        criteria: { truckTypeIds: [mixer], serviceTypeIds: [], siteIds: [plant], materialIds: [readymix], originZoneIds: [], destZoneIds: [] },
        active: true, createdAt: now, updatedAt: now,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );
  await db.collection(C.podTemplates).updateOne(
    { clientId, jobGroupId: group!._id, status: 'published', version: 1 },
    {
      $setOnInsert: {
        name: 'Mixer POD', extraSteps: [],
        fields: [
          { key: 'ticketPhoto', label: 'รูปตั๋วส่งคอนกรีต', type: 'photo', required: true, min: 1, max: 3 },
          { key: 'slumpCm', label: 'ค่ายุบตัว (ซม.)', type: 'number', required: true, min: 0, max: 25, unit: 'cm' },
          { key: 'receiverName', label: 'ชื่อผู้รับ', type: 'text', required: true },
          { key: 'receiverSign', label: 'ลายเซ็นผู้รับ', type: 'signature', required: true },
        ],
        publishedAt: now, publishedBy: 'seed', createdAt: now, updatedAt: now, createdBy: 'seed',
      },
    },
    { upsert: true },
  );
}
```

`scripts/seed.ts`:
```ts
import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config.js';
import { ensureIndexes } from '../src/db/indexes.js';
import { seedAdmin, seedBase, seedDemo } from '../src/seed/seed.js';

const config = loadConfig();
const client = await MongoClient.connect(config.MONGO_URI);
try {
  const db = client.db(config.MONGO_DB);
  await ensureIndexes(db);
  await seedBase(db);
  console.log('base data: ok');
  const username = process.env.SEED_ADMIN_USERNAME;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (username && password) console.log(`admin "${username}": ${await seedAdmin(db, username, password)}`);
  if (process.argv.includes('--demo')) {
    await seedDemo(db);
    console.log('demo data: ok');
  }
} finally {
  await client.close();
}
```

- [ ] **Step 4: Write README**

`README.md`:
````markdown
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
````

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all tests PASS; typecheck and build exit 0; `dist/server.js` exists.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: idempotent seed (base, admin, demo) and README" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01U9JUaE2pxXmH3GFPZLKEr6"
```

---

## Self-review notes (plan author)

- **Spec coverage (Plan 1 scope):** §2 stack/layout → Tasks 1–2, 12; §3.3 master collections → Tasks 7–10 (plus `users`, `apiKeys` in Tasks 4–6); §3.3 `counters` → Task 3; §3.4 matching → Task 9; §6.1 configurable templates + versioning → Task 10; §8.1 conventions (errors, pagination, audit, OpenAPI) → Tasks 2, 4, 7; §8.2 auth/roles/API keys → Tasks 4–6; §8.3 master-data endpoints + imports → Tasks 7–11. Operations collections, lifecycle, ePOD submission, pallets, trip summary, GPS and migration are Plans 2–4 (see roadmap).
- **Deliberate deviations** are listed in the header for PO sign-off.
- **Known follow-ups for Plan 2:** DO creation calls `matchJobGroupForDo`; shipments use `nextNumber(db, 'SH')`; vehicle slot rules read `vehicles.part` and `truckTypes.category`.
