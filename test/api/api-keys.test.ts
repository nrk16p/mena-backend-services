import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { AppError } from '../../src/lib/errors.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';

async function runScopeGuard(app: App, scope: string, key?: string) {
  const req = { headers: key ? { 'x-api-key': key } : {}, principal: null } as unknown as FastifyRequest;
  await app.requireScope(scope).call(app, req, {} as FastifyReply);
  return req;
}

describe('API keys', () => {
  let app: App;
  let admin: { authorization: string };
  beforeAll(async () => {
    app = await buildTestApp();
    admin = (await createUserAndLogin(app, ['admin'])).headers;
  });
  afterAll(async () => closeTestApp(app));

  it('creates a key shown once, lists without secrets, and authenticates it', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: admin, payload: { name: 'hino-gps-sync', scopes: ['gps:write'] } });
    expect(res.statusCode).toBe(201);
    const { key, id } = res.json();
    expect(key).toMatch(/^mk_[a-f0-9]{24}_/);
    const list = await app.inject({ method: 'GET', url: '/api/v1/api-keys', headers: admin });
    expect(JSON.stringify(list.json())).not.toContain(key.split('_')[2]);
    expect(list.json().items[0]).not.toHaveProperty('keyHash');
    const req = await runScopeGuard(app, 'gps:write', key);
    expect(req.principal).toMatchObject({ kind: 'apiKey', keyId: id, name: 'hino-gps-sync' });
  });

  it('rejects missing, wrong, out-of-scope and revoked keys', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: admin, payload: { name: 'dtc', scopes: ['gps:write'] } })).json();
    await expect(runScopeGuard(app, 'gps:write')).rejects.toMatchObject({ statusCode: 401 });
    await expect(runScopeGuard(app, 'gps:write', `${created.key}x`)).rejects.toMatchObject({ statusCode: 401 });
    await expect(runScopeGuard(app, 'other:scope', created.key)).rejects.toMatchObject({ statusCode: 403 });
    await app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${created.id}`, headers: admin });
    await expect(runScopeGuard(app, 'gps:write', created.key)).rejects.toBeInstanceOf(AppError);
  });
});
