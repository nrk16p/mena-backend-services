import type { Db, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/lib/tx.js';
import { testDb } from '../helpers/db.js';

describe('withTransaction batch timeout budget (spec §13.2)', () => {
  let db: Db;
  let client: MongoClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, client, close } = await testDb());
  });
  afterAll(async () => close());

  it('still runs a plain transaction with no opts (client-level MONGO_TIMEOUT_MS applies)', async () => {
    const result = await withTransaction(client, async (session) => {
      await db.collection('probe_default').insertOne({ ok: 1 }, { session });
      return 'done';
    });
    expect(result).toBe('done');
    expect(await db.collection('probe_default').countDocuments()).toBe(1);
  });

  it('accepts an explicit timeoutMS and a ~100-document batch still succeeds within it', async () => {
    const docs = Array.from({ length: 100 }, (_, i) => ({ i }));
    const count = await withTransaction(
      client,
      async (session) => {
        for (const d of docs) await db.collection('probe_batch').insertOne(d, { session });
        return docs.length;
      },
      { timeoutMS: 30_000 },
    );
    expect(count).toBe(100);
    expect(await db.collection('probe_batch').countDocuments()).toBe(100);
  });

  it('really forwards opts.timeoutMS to the underlying session.withTransaction call, not just accepting it as an unused option', async () => {
    // Patch the real client's `startSession` to hand back a real session whose
    // `withTransaction` records the options it was called with, then delegates to the original
    // implementation. This proves the option reaches the driver call without depending on any
    // particular driver-internal validation behaviour for a given value.
    const originalStartSession = client.startSession.bind(client);
    let capturedOptions: unknown;
    client.startSession = ((...args: Parameters<typeof originalStartSession>) => {
      const session = originalStartSession(...args);
      const originalWithTransaction = session.withTransaction.bind(session);
      session.withTransaction = ((fn: Parameters<typeof originalWithTransaction>[0], txOpts?: Parameters<typeof originalWithTransaction>[1]) => {
        capturedOptions = txOpts;
        return originalWithTransaction(fn, txOpts);
      }) as typeof session.withTransaction;
      return session;
    }) as typeof client.startSession;

    try {
      const result = await withTransaction(
        client,
        async (session) => {
          await db.collection('probe_spy').insertOne({ x: 1 }, { session });
          return 'ok';
        },
        { timeoutMS: 12_345 },
      );
      expect(result).toBe('ok');
    } finally {
      client.startSession = originalStartSession;
    }

    expect(capturedOptions).toEqual({ timeoutMS: 12_345 });
  });
});
