import type { ClientSession, MongoClient } from 'mongodb';

/**
 * `opts.timeoutMS` bounds this transaction (including retries) instead of the client-level
 * `MONGO_TIMEOUT_MS`; batch callers (bulk create, imports) pass the larger `MONGO_BATCH_TIMEOUT_MS`
 * budget (spec §13.2) since the default per-request budget is too tight for a whole batch.
 */
export async function withTransaction<T>(
  mongo: MongoClient,
  fn: (session: ClientSession) => Promise<T>,
  opts?: { timeoutMS?: number },
): Promise<T> {
  const session = mongo.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await fn(session);
    }, opts?.timeoutMS !== undefined ? { timeoutMS: opts.timeoutMS } : undefined);
    return result as T;
  } finally {
    await session.endSession();
  }
}
