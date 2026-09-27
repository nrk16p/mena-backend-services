import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { buildApp, type App } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  JWT_SECRET: 'test-secret-test-secret-test-secret-0000',
  API_KEY_PEPPER: 'test-pepper-000000',
  LOGIN_RATE_LIMIT_PER_MIN: '1000',
};

export async function buildTestApp(env: Record<string, string> = {}): Promise<App> {
  const config = loadConfig({
    ...TEST_ENV,
    MONGO_URI: inject('mongoUri'),
    MONGO_DB: `t_${randomUUID().replaceAll('-', '')}`,
    ...env,
  });
  const app = await buildApp(config);
  await app.ready();
  return app;
}

export async function closeTestApp(app: App): Promise<void> {
  await app.db.dropDatabase();
  await app.close();
}
