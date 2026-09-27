import { useEffect } from 'react';

export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        const l = await navigator.wakeLock.request('screen');
        // The effect's cleanup can run (and set `cancelled`) while this request is still in
        // flight — e.g. the component unmounts, or `active` flips false, before the browser
        // grants the lock. If that happened, release it immediately: the cleanup below already
        // ran and can't release a lock that didn't exist yet at that time, so without this check
        // the screen would stay awake indefinitely.
        if (cancelled) {
          void l.release().catch(() => undefined);
          return;
        }
        lock = l;
      } catch {
        /* battery saver or unsupported: ignore */
      }
    };
    const onVisible = () => {
      if (!cancelled && document.visibilityState === 'visible') void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, [active]);
}
