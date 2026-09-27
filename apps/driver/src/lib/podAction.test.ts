import { describe, expect, it } from 'vitest';
import { podActionState } from './podAction';

describe('podActionState', () => {
  it('hides the button when the delivery order status is not POD-eligible', () => {
    expect(podActionState(new Set(['ARRIVED', 'UNLOAD_END']), 'DELIVERED')).toBe('hidden');
  });

  it('hides the button before the stop has arrived', () => {
    expect(podActionState(new Set(), 'PLANNED')).toBe('hidden');
  });

  it('waits (disabled, no link) once arrived but before unloading ends', () => {
    expect(podActionState(new Set(['ARRIVED']), 'PLANNED')).toBe('waiting');
    expect(podActionState(new Set(['ARRIVED', 'UNLOAD_START']), 'PICKED_UP')).toBe('waiting');
  });

  it('is ready (a real link) once unloading has ended', () => {
    expect(podActionState(new Set(['ARRIVED', 'UNLOAD_START', 'UNLOAD_END']), 'PICKED_UP')).toBe('ready');
    expect(podActionState(new Set(['ARRIVED', 'UNLOAD_END']), 'POD_REJECTED')).toBe('ready');
  });
});
