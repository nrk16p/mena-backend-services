import { describe, expect, it } from 'vitest';
import { normalizePlate, plateKey } from '../../src/modules/master/fleet.js';

describe('normalizePlate', () => {
  it('trims, collapses whitespace and upper-cases', () => {
    expect(normalizePlate('  70-1234 ')).toBe('70-1234');
    expect(normalizePlate('ab   1234')).toBe('AB 1234');
    expect(normalizePlate('สบ  1234')).toBe('สบ 1234');
  });
});

describe('plateKey', () => {
  it('strips all whitespace, dashes and dots on top of normalizePlate', () => {
    expect(plateKey('1กข1234')).toBe('1กข1234');
    expect(plateKey('1กข 1234')).toBe('1กข1234');
    expect(plateKey('1กข-1234')).toBe('1กข1234');
    expect(plateKey('70.1234')).toBe('701234');
    expect(plateKey(' 70 - 12.34 ')).toBe('701234');
  });
});
