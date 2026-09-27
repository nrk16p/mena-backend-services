/**
 * One-command local demo backend — no Docker needed.
 *
 * Starts a single-node MongoDB replica set from mongodb-memory-server (the same binary the tests
 * use), keeps its data in ./.demo-data so the demo survives restarts, seeds the demo data, and
 * starts the API on :3000. Secrets for this local demo (JWT, API-key pepper, demo password) are
 * generated once and kept in ./.demo-data/secrets.json (git-ignored).
 *
 *   npm run demo:api            # start (seeds on first run; re-seeding is idempotent)
 *   rm -rf .demo-data           # start over with fresh demo data
 *
 * Phones reach the API through the driver app's dev server (https://<this-computer-ip>:5174),
 * so PUBLIC_BASE_URL points there for signed photo upload links.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const DATA_DIR = join(process.cwd(), '.demo-data');
const DB_PATH = join(DATA_DIR, 'db');
const SECRETS = join(DATA_DIR, 'secrets.json');
const MONGO_PORT = Number(process.env.DEMO_MONGO_PORT ?? 27027);

function lanIp(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return 'localhost';
}

function secrets(): { jwtSecret: string; pepper: string; demoPassword: string } {
  if (existsSync(SECRETS)) return JSON.parse(readFileSync(SECRETS, 'utf8'));
  const s = {
    jwtSecret: randomBytes(32).toString('hex'),
    pepper: randomBytes(16).toString('hex'),
    // Easy to type on a phone, still random per install.
    demoPassword: `demo-${randomBytes(3).toString('hex')}`,
  };
  writeFileSync(SECRETS, JSON.stringify(s, null, 2), { mode: 0o600 });
  return s;
}

mkdirSync(DB_PATH, { recursive: true });
const s = secrets();
const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, name: 'demo', storageEngine: 'wiredTiger' },
  instanceOpts: [{ port: MONGO_PORT, dbPath: DB_PATH, storageEngine: 'wiredTiger' }],
});
const ip = lanIp();

Object.assign(process.env, {
  NODE_ENV: 'development',
  MONGO_URI: replSet.getUri(),
  MONGO_DB: 'mena_demo',
  JWT_SECRET: s.jwtSecret,
  API_KEY_PEPPER: s.pepper,
  DEMO_PASSWORD: s.demoPassword,
  STORAGE_DRIVER: process.env.STORAGE_DRIVER ?? 'memory',
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? `https://${ip}:5174`,
  // Loopback only: phones reach the API through the driver app's Vite https proxy, never directly,
  // so the demo API (with its well-known demo accounts) isn't exposed on the LAN.
  HOST: process.env.HOST ?? '127.0.0.1',
});

// Seed (idempotent — never resets data a demo user is in the middle of).
const { loadConfig } = await import('../src/config.js');
const { ensureIndexes } = await import('../src/db/indexes.js');
const { seedBase, seedDemo } = await import('../src/seed/seed.js');
const config = loadConfig();
const client = await MongoClient.connect(config.MONGO_URI);
try {
  const db = client.db(config.MONGO_DB);
  await ensureIndexes(db);
  await seedBase(db);
  await seedDemo(db, { password: s.demoPassword });
} finally {
  await client.close();
}

const { buildApp } = await import('../src/app.js');
const app = await buildApp(config);
const shutdown = async () => {
  await app.close();
  await replSet.stop({ doCleanup: false });
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
await app.listen({ host: config.HOST, port: config.PORT });

console.log(`
  Demo API ready on http://localhost:${config.PORT}  (docs: /docs)
  Admin panel:  http://localhost:5173        (npm --prefix apps/admin run dev)
  Driver app:   https://${ip}:5174     (npm --prefix apps/driver run dev)
  Users:        demo-admin, demo-planner, demo-driver1, demo-driver2
  Password:     ${s.demoPassword}   (local demo only; stored in .demo-data/secrets.json)
  Photos:       ${config.STORAGE_DRIVER === 'memory' ? 'kept in memory (lost on restart)' : 'DigitalOcean Spaces'}
`);
