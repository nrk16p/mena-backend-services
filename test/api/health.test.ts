import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';

describe('GET /health', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await closeTestApp(app);
  });

  it('returns ok when Mongo is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
