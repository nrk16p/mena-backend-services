import { afterEach, describe, expect, it, vi } from 'vitest';
import { gpsState } from './permissions';

describe('gpsState', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports unsupported when the browser has no geolocation', async () => {
    vi.stubGlobal('navigator', {});
    expect(await gpsState()).toBe('unsupported');
  });

  it('reads the permission state when the Permissions API exists', async () => {
    vi.stubGlobal('navigator', { geolocation: {}, permissions: { query: vi.fn().mockResolvedValue({ state: 'denied' }) } });
    expect(await gpsState()).toBe('denied');
  });

  it('falls back to prompt when the Permissions API is missing (older iOS Safari)', async () => {
    vi.stubGlobal('navigator', { geolocation: {} });
    expect(await gpsState()).toBe('prompt');
  });
});
