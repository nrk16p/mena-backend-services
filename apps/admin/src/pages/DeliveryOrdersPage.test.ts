import { describe, expect, it } from 'vitest';
import { toggleSelected } from './DeliveryOrdersPage';

describe('toggleSelected', () => {
  it('adds an id that is not selected', () => {
    expect(toggleSelected(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('removes an id that is already selected', () => {
    expect(toggleSelected(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('does not mutate the input array', () => {
    const input = ['a'];
    toggleSelected(input, 'b');
    expect(input).toEqual(['a']);
  });
});
