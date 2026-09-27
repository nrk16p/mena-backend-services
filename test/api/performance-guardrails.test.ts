import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';

describe('performance guardrails', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => closeTestApp(app));

  it('passes the operation timeout and pool size to the Mongo client', () => {
    expect(app.mongo.options.timeoutMS).toBe(5000);
    expect(app.mongo.options.maxPoolSize).toBe(20);
  });

  it('has an index for window queries on shipments', async () => {
    const names = (await app.db.collection(C.shipments).indexes()).map((i) => JSON.stringify(i.key));
    expect(names).toContain(JSON.stringify({ plannedEnd: 1, plannedStart: 1 }));
  });

  it('answers the availability window query without a collection scan', async () => {
    const plan = await app.db
      .collection(C.shipments)
      .find({ status: { $in: ['PLANNED'] }, plannedStart: { $lt: new Date('2026-10-02') }, plannedEnd: { $gt: new Date('2026-10-01') } })
      .explain('queryPlanner');
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
  });
});
