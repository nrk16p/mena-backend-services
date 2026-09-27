import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import mongoPlugin from './plugins/mongo.js';

export async function buildApp(config: Config) {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: config.LOG_LEVEL },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('config', config);

  await app.register(mongoPlugin);

  app.get('/health', async () => {
    await app.db.command({ ping: 1 });
    return { status: 'ok' };
  });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
