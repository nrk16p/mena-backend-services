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
