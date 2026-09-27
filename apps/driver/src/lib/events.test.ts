import { describe, expect, it, vi } from 'vitest';
import { nextStep } from '@shared/steps';
import { createTapSender } from './events';

describe('nextStep', () => {
  it('walks drops before pickups and ends after departure', () => {
    const stop = { pickupDoIds: ['p'], dropDoIds: ['d'] };
    expect(nextStep(stop, new Set())).toBe('ARRIVED');
    expect(nextStep(stop, new Set(['ARRIVED']))).toBe('UNLOAD_START');
    expect(nextStep(stop, new Set(['ARRIVED', 'UNLOAD_START', 'UNLOAD_END']))).toBe('LOAD_START');
    expect(nextStep({ pickupDoIds: [], dropDoIds: ['d'] }, new Set(['ARRIVED', 'UNLOAD_START', 'UNLOAD_END', 'DEPARTED']))).toBeNull();
  });
});

describe('createTapSender', () => {
  const base = { shipmentId: 's', stopId: 'st', code: 'ARRIVED', lat: 1, lng: 2, accuracyM: 5, noGpsReason: null, deviceTime: '2026-10-05T08:00:00+07:00' };

  it('reuses the clientEventId after a network failure', async () => {
    const send = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce({ results: [{ clientEventId: 'x', status: 'accepted', eventId: 'e', flags: [] }] });
    const tap = createTapSender(send);
    await expect(tap(base)).rejects.toThrow('offline');
    await tap(base);
    const id1 = send.mock.calls[0]![0].events[0].clientEventId;
    const id2 = send.mock.calls[1]![0].events[0].clientEventId;
    expect(id1).toBe(id2);
  });

  it('uses a fresh id once the previous tap got an answer', async () => {
    const send = vi.fn().mockResolvedValue({ results: [{ clientEventId: 'x', status: 'rejected', eventId: null, flags: [], code: 'EVENT_OUT_OF_ORDER' }] });
    const tap = createTapSender(send);
    await tap(base);
    await tap(base);
    expect(send.mock.calls[0]![0].events[0].clientEventId).not.toBe(send.mock.calls[1]![0].events[0].clientEventId);
  });
});
