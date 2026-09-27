import type { Db, IndexDescription } from 'mongodb';
import { C } from './collections.js';

// Each task adds its collection's indexes here.
export const INDEXES: Record<string, IndexDescription[]> = {
  [C.users]: [
    { key: { username: 1 }, unique: true },
    { key: { driverId: 1 }, unique: true, partialFilterExpression: { driverId: { $type: 'objectId' } } },
  ],
  [C.refreshTokens]: [{ key: { familyId: 1 } }, { key: { userId: 1 } }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  [C.apiKeys]: [{ key: { active: 1 } }],
  [C.auditLog]: [{ key: { entity: 1, entityId: 1, at: -1 } }],
  [C.clients]: [{ key: { code: 1 }, unique: true }],
  [C.zones]: [{ key: { code: 1 }, unique: true }],
  [C.materials]: [{ key: { code: 1 }, unique: true }],
  [C.serviceTypes]: [{ key: { code: 1 }, unique: true }],
  [C.truckTypes]: [{ key: { code: 1 }, unique: true }],
  [C.palletMovementTypes]: [{ key: { code: 1 }, unique: true }],
};

export async function ensureIndexes(db: Db): Promise<void> {
  for (const [name, specs] of Object.entries(INDEXES)) {
    if (specs.length > 0) await db.collection(name).createIndexes(specs);
  }
}
