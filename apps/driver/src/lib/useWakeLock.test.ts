import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWakeLock } from './useWakeLock';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('useWakeLock', () => {
  const originalWakeLock = (navigator as { wakeLock?: unknown }).wakeLock;

  afterEach(() => {
    Object.defineProperty(navigator, 'wakeLock', { value: originalWakeLock, configurable: true });
    vi.restoreAllMocks();
  });

  it('releases a lock that resolves after the effect has already been cleaned up', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const { promise, resolve } = deferred<{ release: () => Promise<void> }>();
    const request = vi.fn().mockReturnValue(promise);
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });

    const { unmount } = renderHook(() => useWakeLock(true));
    expect(request).toHaveBeenCalledWith('screen');

    // Unmount (runs the effect cleanup, setting the internal `cancelled` flag) BEFORE the
    // request's promise resolves — this is the race the fix targets.
    unmount();

    resolve({ release });
    await promise;
    // Let the microtask queue drain so the `.then` inside acquire() runs.
    await Promise.resolve();
    await Promise.resolve();

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps the lock (does not release it) when it resolves before cleanup', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const { promise, resolve } = deferred<{ release: () => Promise<void> }>();
    const request = vi.fn().mockReturnValue(promise);
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });

    const { unmount } = renderHook(() => useWakeLock(true));

    resolve({ release });
    await promise;
    await Promise.resolve();

    expect(release).not.toHaveBeenCalled();

    // Now unmount — the normal (non-race) cleanup path should release the held lock.
    unmount();
    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the Wake Lock API is unsupported', () => {
    Object.defineProperty(navigator, 'wakeLock', { value: undefined, configurable: true });
    expect(() => {
      const { unmount } = renderHook(() => useWakeLock(true));
      unmount();
    }).not.toThrow();
  });
});
