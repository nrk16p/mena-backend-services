import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import { C } from '../../db/collections.js';
import type { ApiKeyPrincipal } from '../../lib/principal.js';

export const API_KEY_SCOPES = ['gps:write'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface ApiKeyDoc {
  _id: ObjectId;
  name: string;
  keyHash: string;
  scopes: ApiKeyScope[];
  active: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
  createdBy: string;
}

const hmac = (pepper: string, secret: string) => createHmac('sha256', pepper).update(secret).digest('hex');

export async function createApiKey(
  db: Db,
  pepper: string,
  input: { name: string; scopes: ApiKeyScope[]; createdBy: string },
): Promise<{ doc: ApiKeyDoc; key: string }> {
  const _id = new ObjectId();
  const secret = randomBytes(24).toString('base64url');
  const doc: ApiKeyDoc = {
    _id,
    name: input.name,
    keyHash: hmac(pepper, secret),
    scopes: input.scopes,
    active: true,
    lastUsedAt: null,
    createdAt: new Date(),
    createdBy: input.createdBy,
  };
  await db.collection<ApiKeyDoc>(C.apiKeys).insertOne(doc);
  return { doc, key: `mk_${_id.toHexString()}_${secret}` };
}

export async function authenticateApiKey(db: Db, pepper: string, raw: string): Promise<ApiKeyPrincipal | null> {
  const m = /^mk_([a-f0-9]{24})_([A-Za-z0-9_-]+)$/.exec(raw);
  if (!m) return null;
  const coll = db.collection<ApiKeyDoc>(C.apiKeys);
  const doc = await coll.findOne({ _id: new ObjectId(m[1]), active: true });
  if (!doc) return null;
  const a = Buffer.from(doc.keyHash, 'hex');
  const b = Buffer.from(hmac(pepper, m[2]!), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  await coll.updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } });
  return { kind: 'apiKey', keyId: doc._id.toHexString(), name: doc.name, scopes: [...doc.scopes] };
}
