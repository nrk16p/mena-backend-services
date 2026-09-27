import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { C } from '../../src/db/collections.js';
import { prepareDoc, type ResourceDef } from '../../src/modules/master/resource.js';
import { testDb } from '../helpers/db.js';

describe('prepareDoc', () => {
  let db: Db;
  let close: () => Promise<void>;
  let zoneId: ObjectId;

  beforeAll(async () => {
    ({ db, close } = await testDb());
    const res = await db.collection(C.zones).insertOne({ code: 'Z1', name: 'Zone 1', active: true });
    zoneId = res.insertedId;
  });
  afterAll(async () => close());

  // Test-only def with a nested many-ref, mirroring shapes like `criteria.zoneIds`.
  const nestedBody = z.object({ nested: z.object({ zoneIds: z.array(z.string()) }) });
  const nestedDef: ResourceDef = {
    name: 'testNested',
    path: '/test-nested',
    collection: 'testNested',
    body: nestedBody,
    item: nestedBody,
    refs: [{ path: 'nested.zoneIds', collection: C.zones, many: true }],
  };

  it('never mutates the input body at any depth and dedups many-refs preserving order', async () => {
    const zid = zoneId.toHexString();
    const body = { nested: { zoneIds: [zid, zid] } };
    const snapshot = structuredClone(body);

    const prepared = await prepareDoc(nestedDef, db, body, null);

    // The caller's body (including nested containers) must be untouched.
    expect(body).toEqual(snapshot);
    expect(body.nested.zoneIds).toEqual([zid, zid]);

    // The prepared doc stores a de-duplicated, first-occurrence-order ObjectId array.
    const preparedNested = prepared.nested as { zoneIds: ObjectId[] };
    expect(preparedNested.zoneIds).toHaveLength(1);
    expect(preparedNested.zoneIds[0]).toBeInstanceOf(ObjectId);
    expect(preparedNested.zoneIds[0]!.toHexString()).toBe(zid);
  });
});
