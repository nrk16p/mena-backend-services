import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { apiKeyRoutes } from './modules/api-keys/api-keys.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { masterRoutes } from './modules/master/master.routes.js';
import { userRoutes } from './modules/users/users.routes.js';

export const apiRoutes: FastifyPluginAsyncZod = async (api) => {
  await api.register(authRoutes);
  await api.register(userRoutes);
  await api.register(apiKeyRoutes);
  await api.register(masterRoutes);
};
