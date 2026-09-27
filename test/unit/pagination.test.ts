import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import { paginate } from '../../src/lib/pagination.js';
import { testDb } from '../helpers/db.js';

describe('paginate', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await testDb());
    await db.collection('items').insertMany(Array.from({ length: 5 }, (_, i) => ({ n: i, even: i % 2 === 0 })));
  });
  afterAll(async () => close());

  it('pages through results by cursor', async () => {
    const coll = db.collection('items');
    const p1 = await paginate(coll, {}, { limit: 2 });
    expect(p1.items.map((d) => d.n)).toEqual([0, 1]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await paginate(coll, {}, { limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((d) => d.n)).toEqual([2, 3]);
    const p3 = await paginate(coll, {}, { limit: 2, cursor: p2.nextCursor! });
    expect(p3.items.map((d) => d.n)).toEqual([4]);
    expect(p3.nextCursor).toBeNull();
  });

  it('combines cursor with a filter', async () => {
    const coll = db.collection('items');
    const p1 = await paginate(coll, { even: true }, { limit: 1 });
    const p2 = await paginate(coll, { even: true }, { limit: 5, cursor: p1.nextCursor! });
    expect(p2.items.map((d) => d.n)).toEqual([2, 4]);
  });
});
