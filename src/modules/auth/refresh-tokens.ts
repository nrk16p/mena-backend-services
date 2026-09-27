import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import { C } from '../../db/collections.js';
import { AppError } from '../../lib/errors.js';

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

function parseToken(token: string): { id: ObjectId; secret: string } | null {
  const dot = token.indexOf('.');
  if (dot !== 24) return null;
  const id = token.slice(0, 24);
  const secret = token.slice(25);
  if (!/^[a-f0-9]{24}$/.test(id) || secret.length === 0) return null;
  return { id: new ObjectId(id), secret };
}

function hashMatches(stored: string, secret: string): boolean {
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(sha256(secret), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const invalid = () => new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token');
const reused = () => new AppError(401, 'REFRESH_TOKEN_REUSED', 'Refresh token was already used; please log in again');

async function revokeFamily(db: Db, familyId: ObjectId): Promise<void> {
  await db
    .collection<RefreshTokenDoc>(C.refreshTokens)
    .updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export async function rotateRefreshToken(
  db: Db,
  token: string,
  graceSec: number,
): Promise<{ userId: ObjectId; familyId: ObjectId }> {
  const coll = db.collection<RefreshTokenDoc>(C.refreshTokens);
  const parsed = parseToken(token);
  if (!parsed) throw invalid();
  const doc = await coll.findOne({ _id: parsed.id });
  if (!doc || !hashMatches(doc.tokenHash, parsed.secret)) throw invalid();
  const now = new Date();
  if (doc.revokedAt) {
    await revokeFamily(db, doc.familyId);
    throw reused();
  }
  if (doc.expiresAt <= now) throw invalid();
  if (doc.replacedAt) {
    // A quick retry (lost response on a mobile network) is allowed; anything later is treated as theft.
    if (now.getTime() - doc.replacedAt.getTime() <= graceSec * 1000) {
      return { userId: doc.userId, familyId: doc.familyId };
    }
    await revokeFamily(db, doc.familyId);
    throw reused();
  }
  const updated = await coll.findOneAndUpdate(
    { _id: doc._id, replacedAt: null, revokedAt: null },
    { $set: { replacedAt: now } },
  );
  if (!updated && graceSec === 0) {
    await revokeFamily(db, doc.familyId);
    throw reused();
  }
  return { userId: doc.userId, familyId: doc.familyId };
}

export async function revokeRefreshToken(db: Db, token: string): Promise<void> {
  const parsed = parseToken(token);
  if (!parsed) return;
  const doc = await db.collection<RefreshTokenDoc>(C.refreshTokens).findOne({ _id: parsed.id });
  if (doc && hashMatches(doc.tokenHash, parsed.secret)) await revokeFamily(db, doc.familyId);
}

export async function revokeAllForUser(db: Db, userId: ObjectId): Promise<void> {
  await db
    .collection<RefreshTokenDoc>(C.refreshTokens)
    .updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}
