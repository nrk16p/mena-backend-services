import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import { AppError } from './lib/errors.js';
import errorsPlugin from './plugins/errors.js';
import authPlugin from './plugins/auth.js';
import mongoPlugin from './plugins/mongo.js';
import openapiPlugin from './plugins/openapi.js';
import { apiRoutes } from './routes.js';

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

  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) => new AppError(429, 'RATE_LIMITED', `Too many requests, retry in ${ctx.after}`),
  });
  await app.register(authPlugin);
  await app.register(apiRoutes, { prefix: '/api/v1' });

  app.get('/health', { schema: { tags: ['system'] } }, async () => {
    await app.db.command({ ping: 1 });
    return { status: 'ok' };
  });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
