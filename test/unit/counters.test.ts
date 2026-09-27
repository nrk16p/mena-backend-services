import type { Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bangkokYYMM, nextNumber } from '../../src/lib/counters.js';
import { testDb } from '../helpers/db.js';

describe('bangkokYYMM', () => {
  it('uses Asia/Bangkok month, not UTC', () => {
    expect(bangkokYYMM(new Date('2026-09-30T16:59:59Z'))).toBe('2609'); // 23:59:59 BKK
    expect(bangkokYYMM(new Date('2026-09-30T17:30:00Z'))).toBe('2610'); // 00:30 BKK next day
    expect(bangkokYYMM(new Date('2026-12-31T17:00:00Z'))).toBe('2701');
  });
});

describe('nextNumber', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await testDb());
  });
  afterAll(async () => close());

  const sep = new Date('2026-09-15T03:00:00Z');

  it('increments per prefix and month with 5-digit padding', async () => {
    expect(await nextNumber(db, 'SH', sep)).toBe('SH-2609-00001');
    expect(await nextNumber(db, 'SH', sep)).toBe('SH-2609-00002');
    expect(await nextNumber(db, 'DO', sep)).toBe('DO-2609-00001');
    expect(await nextNumber(db, 'SH', new Date('2026-09-30T17:30:00Z'))).toBe('SH-2610-00001');
  });

  it('never hands out the same number under concurrency', async () => {
    const at = new Date('2026-11-05T03:00:00Z');
    const numbers = await Promise.all(Array.from({ length: 50 }, () => nextNumber(db, 'DO', at)));
    expect(new Set(numbers).size).toBe(50);
    expect(numbers.every((n) => /^DO-2611-\d{5}$/.test(n))).toBe(true);
  });
});
