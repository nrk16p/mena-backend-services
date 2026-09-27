import { describe, expect, it } from 'vitest';
import { checkExtraEvent, checkStopEvent, stopSequence } from '../../src/modules/execution/event-rules.js';

const state = (o: Partial<{ hasDrops: boolean; hasPickups: boolean; done: string[]; allDropsHavePod: boolean }>) => ({
  hasDrops: o.hasDrops ?? false, hasPickups: o.hasPickups ?? false, done: new Set(o.done ?? []), allDropsHavePod: o.allDropsHavePod ?? false,
});

describe('step rules', () => {
  it('orders drops before pickups', () => {
    expect(stopSequence(true, true)).toEqual(['ARRIVED', 'UNLOAD_START', 'UNLOAD_END', 'LOAD_START', 'LOAD_END', 'DEPARTED']);
    expect(stopSequence(false, true)).toEqual(['ARRIVED', 'LOAD_START', 'LOAD_END', 'DEPARTED']);
  });

  it('accepts the next step and rejects skipped, repeated or irrelevant steps', () => {
    const pickup = state({ hasPickups: true, done: ['ARRIVED'] });
    expect(checkStopEvent(pickup, 'LOAD_START', true)).toBeNull();
    expect(checkStopEvent(pickup, 'LOAD_END', true)?.code).toBe('EVENT_OUT_OF_ORDER');
    expect(checkStopEvent(pickup, 'ARRIVED', true)?.code).toBe('EVENT_ALREADY_RECORDED');
    expect(checkStopEvent(pickup, 'UNLOAD_START', true)?.code).toBe('EVENT_NOT_APPLICABLE');
  });

  it('requires the previous stop to be departed before arriving', () => {
    expect(checkStopEvent(state({ hasDrops: true }), 'ARRIVED', false)?.code).toBe('PREVIOUS_STOP_OPEN');
  });

  it('requires PODs before departing a drop stop', () => {
    const drop = state({ hasDrops: true, done: ['ARRIVED', 'UNLOAD_START', 'UNLOAD_END'] });
    expect(checkStopEvent(drop, 'DEPARTED', true)?.code).toBe('POD_REQUIRED');
    expect(checkStopEvent({ ...drop, allDropsHavePod: true }, 'DEPARTED', true)).toBeNull();
  });

  it('allows configured extra steps only while at the stop', () => {
    expect(checkExtraEvent(state({ hasDrops: true }), 'DOCS_SUBMITTED', ['DOCS_SUBMITTED'])?.code).toBe('NOT_AT_STOP');
    expect(checkExtraEvent(state({ hasDrops: true, done: ['ARRIVED'] }), 'DOCS_SUBMITTED', ['DOCS_SUBMITTED'])).toBeNull();
    expect(checkExtraEvent(state({ hasDrops: true, done: ['ARRIVED'] }), 'TEMP_CHECKED', ['DOCS_SUBMITTED'])?.code).toBe('EVENT_NOT_APPLICABLE');
    expect(checkExtraEvent(state({ hasDrops: true, done: ['ARRIVED', 'DEPARTED'] }), 'DOCS_SUBMITTED', ['DOCS_SUBMITTED'])?.code).toBe('NOT_AT_STOP');
  });
});
