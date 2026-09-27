import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authRoutes } from './modules/auth/auth.routes.js';

export const apiRoutes: FastifyPluginAsyncZod = async (api) => {
  await api.register(authRoutes);
};
