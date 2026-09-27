import type { ClientSession, MongoClient } from 'mongodb';

export async function withTransaction<T>(mongo: MongoClient, fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = mongo.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result as T;
  } finally {
    await session.endSession();
  }
}
