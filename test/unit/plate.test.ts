import { describe, expect, it } from 'vitest';
import { normalizePlate } from '../../src/modules/master/fleet.js';

describe('normalizePlate', () => {
  it('trims, collapses whitespace and upper-cases', () => {
    expect(normalizePlate('  70-1234 ')).toBe('70-1234');
    expect(normalizePlate('ab   1234')).toBe('AB 1234');
    expect(normalizePlate('สบ  1234')).toBe('สบ 1234');
  });
});
