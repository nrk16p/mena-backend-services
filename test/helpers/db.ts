import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { inject } from 'vitest';

export async function testDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = await MongoClient.connect(inject('mongoUri'));
  const db = client.db(`t_${randomUUID().replaceAll('-', '')}`);
  return {
    db,
    close: async () => {
      await db.dropDatabase();
      await client.close();
    },
  };
}
