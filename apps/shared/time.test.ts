import { describe, expect, it } from 'vitest';
import { bkkInputValue, fmtBkk, fromBkkInput } from './time';

describe('Bangkok time helpers', () => {
  it('round-trips datetime-local values as Bangkok time, including around midnight', () => {
    expect(fromBkkInput('2026-10-05T22:30')).toBe('2026-10-05T22:30:00+07:00');
    expect(bkkInputValue('2026-10-05T15:30:00.000Z')).toBe('2026-10-05T22:30');
    expect(bkkInputValue('2026-10-05T17:30:00.000Z')).toBe('2026-10-06T00:30');
    expect(bkkInputValue(new Date(fromBkkInput('2026-10-06T01:15')).toISOString())).toBe('2026-10-06T01:15');
  });

  it('formats nulls as a dash', () => {
    expect(fmtBkk(null)).toBe('-');
    expect(fmtBkk('2026-10-05T01:00:00.000Z')).toContain('08:00');
  });
});
