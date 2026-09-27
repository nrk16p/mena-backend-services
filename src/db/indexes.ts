import type { Db, IndexDescription } from 'mongodb';

// Each task adds its collection's indexes here.
export const INDEXES: Record<string, IndexDescription[]> = {};

export async function ensureIndexes(db: Db): Promise<void> {
  for (const [name, specs] of Object.entries(INDEXES)) {
    if (specs.length > 0) await db.collection(name).createIndexes(specs);
  }
}
