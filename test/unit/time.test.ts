import { describe, expect, it } from 'vitest';
import { bangkokDate, bangkokDatesBetween, bangkokWeekday, overlaps } from '../../src/lib/time.js';

describe('Bangkok time helpers', () => {
  it('formats Bangkok calendar dates', () => {
    expect(bangkokDate(new Date('2026-10-04T16:59:59Z'))).toBe('2026-10-04');
    expect(bangkokDate(new Date('2026-10-04T17:00:00Z'))).toBe('2026-10-05');
  });

  it('lists every date a range touches (half-open)', () => {
    // 22:00 Sat 3 Oct → 02:00 Sun 4 Oct Bangkok
    expect(bangkokDatesBetween(new Date('2026-10-03T15:00:00Z'), new Date('2026-10-03T19:00:00Z'))).toEqual(['2026-10-03', '2026-10-04']);
    // ends exactly at midnight Bangkok → does not touch the next date
    expect(bangkokDatesBetween(new Date('2026-10-03T01:00:00Z'), new Date('2026-10-03T17:00:00Z'))).toEqual(['2026-10-03']);
  });

  it('computes weekdays of Bangkok dates', () => {
    expect(bangkokWeekday('2026-10-04')).toBe(0); // Sunday
    expect(bangkokWeekday('2026-10-05')).toBe(1);
  });

  it('checks half-open overlap', () => {
    const d = (h: number) => new Date(Date.UTC(2026, 9, 5, h));
    expect(overlaps(d(1), d(3), d(2), d(4))).toBe(true);
    expect(overlaps(d(1), d(2), d(2), d(3))).toBe(false);
  });
});
