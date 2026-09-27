/**
 * Generates docs/api/openapi.json from the live route schemas — the same document served at
 * `/api/v1/openapi.json`, `/docs` and `/reference` — so the committed file can be diffed in a PR
 * and consumed by `openapi-typescript` without starting the server.
 *
 *   npm run openapi
 *
 * `test/api/openapi-drift.test.ts` regenerates the same JSON and fails the test suite if it
 * doesn't match this file, so this script must be re-run (and its output committed) whenever a
 * route's schema changes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { sortKeysDeep } from './lib/sort-keys.js';

const OUT_FILE = fileURLToPath(new URL('../docs/api/openapi.json', import.meta.url));

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
try {
  // Dummy secrets: this app instance never receives real requests, only builds route schemas.
  const config = loadConfig({
    NODE_ENV: 'test',
    MONGO_URI: replSet.getUri(),
    MONGO_DB: 'openapi_export',
    JWT_SECRET: 'openapi-export-dummy-secret-00000000000',
    API_KEY_PEPPER: 'openapi-export-dummy-pepper0',
  });
  const app = await buildApp(config);
  await app.ready();
  const document = sortKeysDeep(app.swagger());
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify(document, null, 2)}\n`);
  await app.close();
  console.log(`wrote ${OUT_FILE}`);
} finally {
  await replSet.stop();
}
