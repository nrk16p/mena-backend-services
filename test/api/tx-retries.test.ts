import { Collection, MongoServerError, ObjectId } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import * as passwords from '../../src/lib/passwords.js';
import { issueRefreshToken } from '../../src/modules/auth/refresh-tokens.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';

vi.mock('../../src/lib/passwords.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/lib/passwords.js')>();
  return { ...orig, hashPassword: vi.fn(orig.hashPassword) };
});

/** Makes the first matching call on `collectionName` fail with `error` (once). */
function failOnce(method: 'insertOne' | 'findOneAndUpdate', collectionName: string, error: () => Error) {
  const original = Collection.prototype[method] as (...a: unknown[]) => Promise<unknown>;
  let fired = false;
  return vi.spyOn(Collection.prototype, method).mockImplementation(function (this: Collection, ...args: unknown[]) {
    if (!fired && this.collectionName === collectionName) {
      fired = true;
      return Promise.reject(error());
    }
    return original.apply(this, args);
  } as never);
}

const transient = () => {
  const e = new MongoServerError({ message: 'simulated write conflict', code: 112, codeName: 'WriteConflict' });
  e.addErrorLabel('TransientTransactionError');
  return e;
};

describe('transaction retries', () => {
  let app: App;
  let admin: { authorization: string };
  beforeAll(async () => {
    app = await buildTestApp();
    admin = (await createUserAndLogin(app, ['admin'])).headers;
  });
  afterAll(async () => closeTestApp(app));
  afterEach(() => vi.restoreAllMocks());

  it('hashes a new user password once, before the transaction, even when the transaction is retried', async () => {
    const hash = vi.mocked(passwords.hashPassword);
    hash.mockClear();
    const insert = failOnce('insertOne', C.users, transient);
    const res = await app.inject({ method: 'POST', url: '/api/v1/users', headers: admin, payload: { username: 'retry-user', password: 'Passw0rd!', roles: ['viewer'] } });
    expect(res.statusCode).toBe(201);
    expect(insert.mock.calls.filter((_, i) => (insert.mock.contexts[i] as Collection).collectionName === C.users)).toHaveLength(2); // really retried
    expect(hash).toHaveBeenCalledTimes(1);
  });

  it('hashes a reset password once, before the transaction, even when the transaction is retried', async () => {
    const target = await createUserAndLogin(app, ['viewer']);
    const hash = vi.mocked(passwords.hashPassword);
    hash.mockClear();
    const fam = failOnce('findOneAndUpdate', C.users, transient);
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/users/${target.user._id.toHexString()}`, headers: admin, payload: { password: 'Brand-new-88' } });
    expect(res.statusCode).toBe(200);
    expect(fam.mock.contexts.filter((c) => (c as Collection).collectionName === C.users).length).toBeGreaterThanOrEqual(2);
    expect(hash).toHaveBeenCalledTimes(1);
  });

  it('retries a refresh-family upsert that lost the insert race with a duplicate key', async () => {
    const { user } = await createUserAndLogin(app, ['viewer']);
    const familyId = new ObjectId();
    failOnce('findOneAndUpdate', C.refreshFamilies, () => new MongoServerError({ message: 'E11000 duplicate key error', code: 11000, keyPattern: { _id: 1 } }));
    const token = await issueRefreshToken(app.db, user._id, 1, familyId);
    expect(await app.db.collection(C.refreshTokens).countDocuments({ familyId })).toBe(1);
    expect(await app.db.collection(C.refreshFamilies).countDocuments({ _id: familyId })).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: token } })).statusCode).toBe(200);
  });
});
