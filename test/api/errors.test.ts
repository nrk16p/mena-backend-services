import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../src/lib/errors.js';
import errorsPlugin from '../../src/plugins/errors.js';

describe('errors plugin', () => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();

  beforeAll(async () => {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(errorsPlugin);
    app.get('/app-error', async () => {
      throw new AppError(422, 'SOMETHING_WRONG', 'Bad thing', { a: 1 });
    });
    app.post('/validated', { schema: { body: z.object({ n: z.number() }) } }, async () => ({ ok: true }));
    app.get('/dup', async () => {
      throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000, keyValue: { code: 'X' } });
    });
    app.get('/boom', async () => {
      throw new Error('secret internals');
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('maps AppError', async () => {
    const res = await app.inject({ method: 'GET', url: '/app-error' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ code: 'SOMETHING_WRONG', message: 'Bad thing', details: { a: 1 } });
  });

  it('maps schema validation to 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({ method: 'POST', url: '/validated', payload: { n: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('maps duplicate key to 409', async () => {
    const res = await app.inject({ method: 'GET', url: '/dup' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'DUPLICATE_KEY', details: { code: 'X' } });
  });

  it('hides internals on 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  it('returns ROUTE_NOT_FOUND for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('ROUTE_NOT_FOUND');
  });
});
