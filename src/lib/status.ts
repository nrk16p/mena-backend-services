import type { DoStatus } from '../modules/orders/order.types.js';
import type { ShipmentStatus } from '../modules/shipments/shipment.types.js';

// Spec §5.6: statuses are derived from the event log (and the latest POD per DO) by these pure
// functions and stored denormalised for queries. Routes never compute a driver-driven status inline.

export const STOP_STATUSES = ['PENDING', 'ARRIVED', 'WORKING', 'DONE'] as const;
export type StopStatus = (typeof STOP_STATUSES)[number];

/** Statuses in which a shipment shows up in the driver app (job list, own timeline, P3-R13.5); anything else is "not found" to a driver. */
export const DRIVER_VISIBLE_STATUSES: readonly ShipmentStatus[] = ['DISPATCHED', 'ACCEPTED', 'IN_TRANSIT', 'COMPLETED'];

/**
 * Statuses in which the driver may write to a shipment (events, uploads, pallet movements): from
 * acceptance until close. COMPLETED still takes the last DEPARTED and a POD resubmission (P3-R4, spec §5.3).
 */
export const DRIVER_WRITE_STATUSES: readonly ShipmentStatus[] = ['ACCEPTED', 'IN_TRANSIT', 'COMPLETED'];

/** A POD is taken once the trip has started; COMPLETED still takes a resubmission after a rejection. */
export const POD_ACTIVE_STATUSES: readonly ShipmentStatus[] = ['IN_TRANSIT', 'COMPLETED'];

/** DO statuses that count as "has a POD": they allow departing a drop stop and complete a shipment. */
export const POD_DONE_STATUSES: readonly DoStatus[] = ['DELIVERED', 'FAILED', 'POD_VERIFIED', 'POD_REJECTED'];

export interface LatestPodFact {
  outcome: 'DELIVERED' | 'FAILED';
  status: 'submitted' | 'verified' | 'rejected';
}

export function deriveStopStatus(done: ReadonlySet<string>): StopStatus {
  if (done.has('DEPARTED')) return 'DONE';
  if (['UNLOAD_START', 'UNLOAD_END', 'LOAD_START', 'LOAD_END'].some((c) => done.has(c))) return 'WORKING';
  if (done.has('ARRIVED')) return 'ARRIVED';
  return 'PENDING';
}

/** `loaded` = LOAD_END recorded at the DO's pickup stop; `latestPod` = the DO's newest POD, if any. */
export function deriveDoStatus(current: DoStatus, facts: { loaded: boolean; latestPod: LatestPodFact | null }): DoStatus {
  const pod = facts.latestPod;
  if (pod) {
    if (pod.status === 'rejected') return 'POD_REJECTED';
    if (pod.outcome === 'FAILED') return 'FAILED';
    return pod.status === 'verified' ? 'POD_VERIFIED' : 'DELIVERED';
  }
  if (facts.loaded && current === 'PLANNED') return 'PICKED_UP';
  return current;
}

/**
 * The system transitions of spec §5.1: the first driver event starts the trip, and the trip is
 * complete once every DO has a POD. Planner/driver/admin transitions are not derived here.
 */
export function deriveShipmentStatus(current: ShipmentStatus, facts: { driverEvents: number; doStatuses: readonly DoStatus[] }): ShipmentStatus {
  let status = current;
  if (status === 'ACCEPTED' && facts.driverEvents > 0) status = 'IN_TRANSIT';
  if (status === 'IN_TRANSIT' && facts.doStatuses.length > 0 && facts.doStatuses.every((s) => POD_DONE_STATUSES.includes(s))) status = 'COMPLETED';
  return status;
}
