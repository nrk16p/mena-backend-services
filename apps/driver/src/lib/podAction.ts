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
