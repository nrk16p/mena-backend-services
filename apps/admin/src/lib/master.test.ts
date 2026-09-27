import { describe, expect, it } from 'vitest';
import { buildNameMap } from './master';

describe('buildNameMap', () => {
  it('maps id to the requested field', () => {
    const map = buildNameMap([{ id: '1', name: 'ลูกค้า A' }, { id: '2', name: 'ลูกค้า B' }], 'name');
    expect(map.get('1')).toBe('ลูกค้า A');
    expect(map.get('2')).toBe('ลูกค้า B');
  });

  it('falls back to the id when the field is missing', () => {
    const map = buildNameMap([{ id: '3' }], 'name');
    expect(map.get('3')).toBe('3');
  });

  it('reads an alternate field such as plate', () => {
    const map = buildNameMap([{ id: 'v1', plate: '80-1234' }], 'plate');
    expect(map.get('v1')).toBe('80-1234');
  });

  it('skips items without a string id', () => {
    const map = buildNameMap([{ id: 42, name: 'bad' } as unknown as Record<string, unknown>], 'name');
    expect(map.size).toBe(0);
  });
});
