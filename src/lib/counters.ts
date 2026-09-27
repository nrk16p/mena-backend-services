import type { Db } from 'mongodb';
import { C } from '../db/collections.js';

const bkk = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', year: '2-digit', month: '2-digit' });

export function bangkokYYMM(d: Date): string {
  const parts = bkk.formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  if (!year || !month) throw new Error('Failed to format Bangkok date');
  return `${year}${month}`;
}

export type CounterPrefix = 'SH' | 'DO';

// Past 99 999 numbers in one prefix-month the sequence simply widens to six digits
// (e.g. SH-2610-100000). Numbers stay unique; sort them numerically, not as strings.
export async function nextNumber(db: Db, prefix: CounterPrefix, now: Date = new Date()): Promise<string> {
  const key = `${prefix}-${bangkokYYMM(now)}`;
  const doc = await db
    .collection<{ _id: string; seq: number }>(C.counters)
    .findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  if (!doc) throw new Error(`Counter ${key} was not returned`);
  return `${key}-${String(doc.seq).padStart(5, '0')}`;
}
