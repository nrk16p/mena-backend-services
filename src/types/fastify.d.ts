import type { Db, MongoClient } from 'mongodb';
import type { Config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    mongo: MongoClient;
    db: Db;
  }
}
