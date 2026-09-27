import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ObjectId, type ClientSession, type Db } from 'mongodb';
import { C } from '../../db/collections.js';
import { AppError } from '../../lib/errors.js';
import { withTransaction } from '../../lib/tx.js';

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

/** One document per rotation family; issue and revoke both write it, so MongoDB serialises them. */
export interface RefreshFamilyDoc {
  _id: ObjectId;
  userId: ObjectId;
  revokedAt: Date | null;
  expiresAt: Date;
  /** Bumped by every issue and revoke so each one really writes the document (a no-op update takes no write lock). */
  version: number;
  /** Server clock ($$NOW) at the family's first issue; compared with the user's `tokensValidAfter` on refresh. */
  createdAt?: Date;
}

const isDuplicateId = (e: unknown) =>
  (e as { code?: unknown }).code === 11000 && !!(e as { keyPattern?: Record<string, unknown> }).keyPattern?._id;

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
  const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000);
  const run = () =>
    withTransaction(db.client, async (session) => {
      // Compare-and-set on the family document: a concurrent revoke either commits first (and this
      // token is born revoked) or conflicts with this write and is retried after it (and revokes it).
      // The version bump guarantees a real write: `$max` alone is a no-op when the family already
      // outlives this token, and a no-op update does not conflict with the revoke. `createdAt` is the
      // server clock, set only when this upsert inserts the family, so it compares with the server-clock
      // `tokensValidAfter` that revokeAllForUser writes regardless of app-instance clock skew.
      const family = await db.collection<RefreshFamilyDoc>(C.refreshFamilies).findOneAndUpdate(
        { _id: familyId },
        [
          {
            $set: {
              createdAt: { $cond: [{ $eq: [{ $type: '$userId' }, 'missing'] }, '$$NOW', '$createdAt'] },
              userId: { $ifNull: ['$userId', userId] },
              revokedAt: { $ifNull: ['$revokedAt', null] },
              expiresAt: { $max: ['$expiresAt', expiresAt] },
              version: { $add: [{ $ifNull: ['$version', 0] }, 1] },
            },
          },
        ],
        { upsert: true, returnDocument: 'after', session },
      );
      await db.collection<RefreshTokenDoc>(C.refreshTokens).insertOne(
        { _id, userId, familyId, tokenHash: sha256(secret), expiresAt, createdAt: now, replacedAt: null, revokedAt: family?.revokedAt ? now : null },
        { session },
      );
    });
  try {
    await run();
  } catch (e) {
    // Two first issues of one family can race on the upsert's insert; the loser sees the winner's
    // document on a second try.
    if (!isDuplicateId(e)) throw e;
    await run();
  }
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

async function revokeFamily(db: Db, token: Pick<RefreshTokenDoc, 'familyId' | 'userId' | 'expiresAt'>): Promise<void> {
  await withTransaction(db.client, async (session) => {
    const now = new Date();
    await db.collection<RefreshFamilyDoc>(C.refreshFamilies).updateOne(
      { _id: token.familyId },
      { $set: { revokedAt: now }, $setOnInsert: { userId: token.userId }, $max: { expiresAt: token.expiresAt }, $inc: { version: 1 } },
      { upsert: true, session },
    );
    await db
      .collection<RefreshTokenDoc>(C.refreshTokens)
      .updateMany({ familyId: token.familyId, revokedAt: null }, { $set: { revokedAt: now } }, { session });
  });
}

// Shared decision for a token that has already been replaced or revoked, used both
// by the sequential path (doc read as already-used) and the race path (this call
// lost the atomic claim to a concurrent rotation). Keeping this in one place means
// the two paths can't silently drift apart.
// - revoked                          -> revoke the family, reject as reused
// - replaced within the grace window -> a quick retry; return the same result
// - replaced outside the grace window -> revoke the family, reject as reused
//
// graceSec === 0 means zero tolerance: this must NEVER depend on millisecond-level
// timing (two callers can legitimately observe the same `replacedAt` timestamp when
// they lose a race within the same tick), so a lost race is unconditionally reuse
// when there is no grace window at all.
async function resolveReplayState(
  db: Db,
  doc: RefreshTokenDoc,
  now: Date,
  graceSec: number,
): Promise<{ userId: ObjectId; familyId: ObjectId }> {
  if (
    graceSec > 0 &&
    !doc.revokedAt &&
    doc.replacedAt &&
    now.getTime() - doc.replacedAt.getTime() <= graceSec * 1000
  ) {
    return { userId: doc.userId, familyId: doc.familyId };
  }
  await revokeFamily(db, doc);
  throw reused();
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
  if (doc.revokedAt) return resolveReplayState(db, doc, now, graceSec);
  if (doc.expiresAt <= now) throw invalid();
  if (doc.replacedAt) return resolveReplayState(db, doc, now, graceSec);

  const updated = await coll.findOneAndUpdate(
    { _id: doc._id, replacedAt: null, revokedAt: null },
    { $set: { replacedAt: now } },
  );
  if (updated) return { userId: doc.userId, familyId: doc.familyId };

  // Lost the race: another concurrent call claimed this token first. Re-read its
  // current state and apply the same replay rules instead of assuming success.
  const fresh = await coll.findOne({ _id: doc._id });
  if (!fresh) throw invalid();
  return resolveReplayState(db, fresh, new Date(), graceSec);
}

export async function revokeRefreshToken(db: Db, token: string): Promise<void> {
  const parsed = parseToken(token);
  if (!parsed) return;
  const doc = await db.collection<RefreshTokenDoc>(C.refreshTokens).findOne({ _id: parsed.id });
  if (doc && hashMatches(doc.tokenHash, parsed.secret)) await revokeFamily(db, doc);
}

/**
 * Rejects a refresh whose family was created at or before the user's last revoke-all (password
 * change, deactivation). A login racing the revoke can insert a family the revoke's snapshot never
 * saw ("phantom family"); this check closes that gap without locking. The family is revoked too.
 */
export async function assertFamilyCurrent(db: Db, userId: ObjectId, familyId: ObjectId, tokensValidAfter: Date | undefined): Promise<void> {
  if (!tokensValidAfter) return;
  const family = await db.collection<RefreshFamilyDoc>(C.refreshFamilies).findOne({ _id: familyId });
  if (family?.createdAt && family.createdAt > tokensValidAfter) return;
  await revokeFamily(db, { familyId, userId, expiresAt: family?.expiresAt ?? new Date() });
  throw invalid();
}

/** Revokes every session of a user (password change, deactivation); pass the caller's session to commit with it. */
export async function revokeAllForUser(db: Db, userId: ObjectId, session?: ClientSession): Promise<void> {
  // Server clock, written first: families created at or before it are refused on refresh (assertFamilyCurrent).
  await db.collection(C.users).updateOne({ _id: userId }, [{ $set: { tokensValidAfter: '$$NOW' } }], { session });
  const now = new Date();
  await db
    .collection<RefreshFamilyDoc>(C.refreshFamilies)
    .updateMany({ userId, revokedAt: null }, { $set: { revokedAt: now }, $inc: { version: 1 } }, { session });
  await db.collection<RefreshTokenDoc>(C.refreshTokens).updateMany({ userId, revokedAt: null }, { $set: { revokedAt: now } }, { session });
}
