import fp from 'fastify-plugin';
import { createStorage } from '../modules/storage/storage.js';

export default fp(
  async (app) => {
    app.decorate('storage', createStorage(app.config));
  },
  { name: 'storage' },
);
