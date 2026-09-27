import { Collection, ObjectId } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { issueRefreshToken, revokeRefreshToken } from '../../src/modules/auth/refresh-tokens.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { TEST_PASSWORD, createUserAndLogin } from '../helpers/auth.js';
import { type PlanningFixtures, setupPlanning } from '../helpers/planning.js';

/** Makes every auditLog insert fail validation, so a mutation that shares a transaction with its audit must roll back. */
const breakAudit = (app: App) =>
  app.db.command({ collMod: C.auditLog, validator: { entity: { $in: [] } }, validationLevel: 'strict', validationAction: 'error' });
const fixAudit = (app: App) => app.db.command({ collMod: C.auditLog, validator: {} });

describe('mutation and audit commit together', () => {
  let app: App;
  let f: PlanningFixtures;
  beforeAll(async () => {
    app = await buildTestApp();
    f = await setupPlanning(app);
  });
  afterAll(async () => closeTestApp(app));

  it('rolls the mutation back when its audit entry cannot be written', async () => {
    const viewer = await createUserAndLogin(app, ['viewer']);
    const post = (url: string, payload: object, headers = f.admin) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers, payload });
    await breakAudit(app);
    try {
      expect((await post('/clients', { code: 'TXN', name: 'Txn' })).statusCode).toBe(500);
      expect((await post('/pod-templates', { clientId: f.ids.scg, name: 'Txn POD', extraSteps: [], fields: [{ key: 'x', label: 'x', type: 'text', required: true }] })).statusCode).toBe(500);
      expect((await post('/resource-blocks', { resourceType: 'vehicle', resourceId: f.ids.h2, statusCode: 'PM', from: '2026-11-01T00:00:00+07:00', to: '2026-11-02T00:00:00+07:00', note: 'txn' })).statusCode).toBe(500);
      expect((await post('/delivery-orders', { clientId: f.ids.scg, clientRef: 'TXN-1', serviceTypeId: f.ids.single, materialId: f.ids.bulk, qty: 1, originLocationId: f.ids.locA, destLocationId: f.ids.locB })).statusCode).toBe(500);
      expect((await post('/api-keys', { name: 'txn-key', scopes: ['gps:write'] })).statusCode).toBe(500);
      expect((await post('/users', { username: 'txn-user', password: 'Passw0rd!', roles: ['viewer'] })).statusCode).toBe(500);
      expect((await post('/me/password', { currentPassword: TEST_PASSWORD, newPassword: 'Brand-new-9' }, viewer.headers)).statusCode).toBe(500);
    } finally {
      await fixAudit(app);
    }
    expect(await app.db.collection(C.clients).countDocuments({ code: 'TXN' })).toBe(0);
    expect(await app.db.collection(C.podTemplates).countDocuments({ name: 'Txn POD' })).toBe(0);
    expect(await app.db.collection(C.resourceBlocks).countDocuments({ note: 'txn' })).toBe(0);
    expect(await app.db.collection(C.deliveryOrders).countDocuments({ clientRef: 'TXN-1' })).toBe(0);
    expect(await app.db.collection(C.apiKeys).countDocuments({ name: 'txn-key' })).toBe(0);
    expect(await app.db.collection(C.users).countDocuments({ username: 'txn-user' })).toBe(0);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: viewer.user.username, password: TEST_PASSWORD } });
    expect(login.statusCode).toBe(200); // the password change was rolled back with its audit
  });
});

describe('concurrency guards', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => closeTestApp(app));

  it('never leaves zero active admins when two admins are demoted at the same moment', async () => {
    let keeper = await createUserAndLogin(app, ['admin']);
    for (let i = 0; i < 5; i++) {
      const other = await createUserAndLogin(app, ['admin']);
      const demote = (id: ObjectId) =>
        app.inject({ method: 'PATCH', url: `/api/v1/users/${id.toHexString()}`, headers: keeper.headers, payload: { roles: ['viewer'] } });
      const [self, peer] = await Promise.all([demote(keeper.user._id), demote(other.user._id)]);
      expect([self, peer].filter((r) => r.statusCode === 200)).toHaveLength(1);
      // The loser sees LAST_ADMIN (422), or 403 when the winner demoted the caller before its request was authorised.
      for (const r of [self, peer].filter((x) => x.statusCode !== 200)) expect([403, 422]).toContain(r.statusCode);
      expect(await app.db.collection(C.users).countDocuments({ active: true, roles: 'admin' })).toBe(1);
      if (self.statusCode === 200) keeper = other;
    }
  });

  /**
   * Runs `during` right after the PATCH handler's pre-transaction read of `userId`, so the handler
   * works from a stale snapshot of that user (a deterministic stand-in for a concurrent request).
   */
  const afterStaleRead = (userId: ObjectId, during: () => Promise<unknown>) => {
    const original = Collection.prototype.findOne;
    let fired = false;
    vi.spyOn(Collection.prototype, 'findOne').mockImplementation(async function (this: Collection, ...args: unknown[]) {
      const result = await (original as (...a: unknown[]) => Promise<unknown>).apply(this, args);
      const filter = args[0] as { _id?: unknown } | undefined;
      if (!fired && this.collectionName === C.users && filter?._id instanceof ObjectId && filter._id.equals(userId) && Object.keys(filter).length === 1) {
        fired = true;
        await during();
      }
      return result;
    } as never);
  };
  afterEach(() => vi.restoreAllMocks());

  it('a PATCH that does not mention roles never writes back stale roles over a concurrent promotion', async () => {
    const keeper = await createUserAndLogin(app, ['admin']);
    const target = await createUserAndLogin(app, ['viewer']);
    afterStaleRead(target.user._id, () => app.db.collection(C.users).updateOne({ _id: target.user._id }, { $set: { roles: ['admin'] } }));
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/users/${target.user._id.toHexString()}`, headers: keeper.headers, payload: { password: 'Brand-new-77' } });
    expect(res.statusCode).toBe(200);
    expect((await app.db.collection(C.users).findOne({ _id: target.user._id }))?.roles).toEqual(['admin']);
  });

  it('counts admins inside the transaction on every PATCH, not only when a stale read says an admin is lost', async () => {
    const keeper = await createUserAndLogin(app, ['admin']);
    const target = await createUserAndLogin(app, ['admin']);
    await app.db.collection(C.users).updateMany({ _id: { $ne: keeper.user._id }, roles: 'admin' }, { $set: { roles: ['viewer'] } });
    await app.db.collection(C.users).updateOne({ _id: target.user._id }, { $set: { roles: ['admin'], active: false } });
    // The handler reads the target as an inactive admin (so deactivating it looks harmless); meanwhile
    // it is re-activated and the keeper steps down, leaving the target as the only active admin.
    afterStaleRead(target.user._id, async () => {
      await app.db.collection(C.users).updateOne({ _id: target.user._id }, { $set: { active: true } });
      await app.db.collection(C.users).updateOne({ _id: keeper.user._id }, { $set: { roles: ['viewer'] } });
    });
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/users/${target.user._id.toHexString()}`, headers: keeper.headers, payload: { active: false } });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('LAST_ADMIN');
    expect(await app.db.collection(C.users).countDocuments({ active: true, roles: 'admin' })).toBe(1);
  });

  it('never lets a refresh token issued during a family revoke survive it', async () => {
    for (let i = 0; i < 10; i++) {
      const { user, refreshToken } = await createUserAndLogin(app, ['viewer']);
      const familyId = (await app.db.collection(C.refreshTokens).findOne({ _id: new ObjectId(refreshToken.split('.')[0]) }))!.familyId as ObjectId;
      const [issued] = await Promise.all([issueRefreshToken(app.db, user._id, 1, familyId), revokeRefreshToken(app.db, refreshToken)]);
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: issued } });
      expect(res.statusCode).toBe(401);
      expect(await app.db.collection(C.refreshFamilies).findOne({ _id: familyId })).toMatchObject({ revokedAt: expect.any(Date) });
    }
  });
});
