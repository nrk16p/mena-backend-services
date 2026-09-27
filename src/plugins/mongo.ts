import fp from 'fastify-plugin';
import { MongoClient } from 'mongodb';
import { ensureIndexes } from '../db/indexes.js';

export default fp(
  async (app) => {
    const client = new MongoClient(app.config.MONGO_URI, {
      timeoutMS: app.config.MONGO_TIMEOUT_MS,
      maxPoolSize: app.config.MONGO_MAX_POOL_SIZE,
    });
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
