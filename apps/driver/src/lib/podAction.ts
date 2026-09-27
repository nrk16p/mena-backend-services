/** Delivery-order statuses for which a POD (or failed-delivery) can still be recorded. */
const POD_ELIGIBLE_STATUSES = new Set(['PICKED_UP', 'POD_REJECTED', 'PLANNED']);

export type PodActionState = 'hidden' | 'waiting' | 'ready';

/**
 * Decides whether the POD button for a drop delivery-order should be hidden (not applicable or
 * not arrived yet), waiting (arrived, but unloading isn't finished — shown disabled, no link so
 * the page can't be opened early), or ready (unloading finished — shown as a link).
 */
export function podActionState(doneSteps: Set<string>, doStatus: string): PodActionState {
  if (!POD_ELIGIBLE_STATUSES.has(doStatus) || !doneSteps.has('ARRIVED')) return 'hidden';
  return doneSteps.has('UNLOAD_END') ? 'ready' : 'waiting';
}

export type PodPageGuard = { ok: true } | { ok: false; message: string };

/**
 * Guards PodPage against being opened directly by URL (bookmark, browser back, a typed link) —
 * a way in that skips the JobPage buttons which only ever appear once `podActionState`/ARRIVED
 * allow it. `doneSteps` must be the events already recorded at the DO's own drop stop.
 *
 * This is a UX guard only, not a security boundary: the server remains the final authority and
 * re-validates everything on submit regardless of what this function decides.
 */
export function podPageGuard(doneSteps: Set<string>, doStatus: string, failed: boolean): PodPageGuard {
  if (failed) {
    if (!doneSteps.has('ARRIVED')) return { ok: false, message: 'ต้องกด “ถึงจุดแล้ว” ก่อนแจ้งส่งไม่สำเร็จ' };
    return { ok: true };
  }
  if (podActionState(doneSteps, doStatus) !== 'ready') {
    return { ok: false, message: 'ยังส่ง POD ไม่ได้ — กด “ลงสินค้าเสร็จ” ที่จุดส่งก่อน' };
  }
  return { ok: true };
}
