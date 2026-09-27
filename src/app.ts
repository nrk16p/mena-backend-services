import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import { AppError } from './lib/errors.js';
import errorsPlugin from './plugins/errors.js';
import authPlugin from './plugins/auth.js';
import mongoPlugin from './plugins/mongo.js';
import openapiPlugin from './plugins/openapi.js';
import storagePlugin from './plugins/storage.js';
import { apiRoutes } from './routes.js';

// Fastify's own `trustProxy: number` support fails closed (trusts nothing) as of the
// installed version, so a hop count is compiled here into an explicit trust function
// instead — the classic "trust exactly the first N proxies" rule.
function trustProxyOption(v: string): boolean | ((address: string, hop: number) => boolean) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  const hops = Number(v);
  return (_address, hop) => hop < hops;
}

export async function buildApp(config: Config) {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: config.LOG_LEVEL },
    trustProxy: trustProxyOption(config.TRUST_PROXY),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('config', config);

  await app.register(errorsPlugin);
  await app.register(openapiPlugin);
  await app.register(mongoPlugin);
  await app.register(storagePlugin);

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
