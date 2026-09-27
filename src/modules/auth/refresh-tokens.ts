import { createHash, randomBytes } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import { C } from '../../db/collections.js';

export interface RefreshTokenDoc {
  _id: ObjectId;
  userId: ObjectId;
  familyId: ObjectId;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  replacedAt: Date | null;
  revokedAt: Date | null;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function issueRefreshToken(
  db: Db,
  userId: ObjectId,
  ttlDays: number,
  familyId: ObjectId = new ObjectId(),
): Promise<string> {
  const _id = new ObjectId();
  const secret = randomBytes(32).toString('base64url');
  const now = new Date();
  await db.collection<RefreshTokenDoc>(C.refreshTokens).insertOne({
    _id,
    userId,
    familyId,
    tokenHash: sha256(secret),
    expiresAt: new Date(now.getTime() + ttlDays * 86_400_000),
    createdAt: now,
    replacedAt: null,
    revokedAt: null,
  });
  return `${_id.toHexString()}.${secret}`;
}
