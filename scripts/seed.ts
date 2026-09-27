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
  const force = process.argv.includes('--force-admin');
  if (username && password) console.log(`admin "${username}": ${await seedAdmin(db, username, password, { force })}`);
  if (process.argv.includes('--demo')) {
    if (config.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');
    // Demo data creates login-capable accounts (DEMO_PASSWORD), so also guard against pointing
    // this at a real (non-dev/demo) database by accident: only run when MONGO_DB's name looks
    // like a dev/demo/test database, or --force was passed explicitly.
    if (!/dev|demo|test|local/i.test(config.MONGO_DB) && !process.argv.includes('--force')) {
      throw new Error(
        `Refusing to seed demo data into database "${config.MONGO_DB}" — its name doesn't look like a dev/demo database. Pass --force to override if this is intentional.`,
      );
    }
    const demoPassword = process.env.DEMO_PASSWORD;
    if (!demoPassword || demoPassword.length < 8) throw new Error('Set DEMO_PASSWORD (at least 8 characters) to seed demo users');
    await seedDemo(db, { password: demoPassword });
    console.log('demo data: ok (users demo-admin, demo-planner, demo-driver1, demo-driver2)');
  }
} finally {
  await client.close();
}
