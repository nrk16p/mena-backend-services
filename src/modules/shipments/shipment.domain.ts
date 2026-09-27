import type { Issue } from '../../lib/issues.js';

export interface DoRoute {
  id: string;
  originLocationId: string;
  destLocationId: string;
}

export interface StopPlan {
  locationId: string;
  pickupDoIds: string[];
  dropDoIds: string[];
}

export interface LegPlan {
  fromIndex: number;
  toIndex: number;
  doIds: string[];
  loaded: boolean;
}

/**
 * Builds stops in DO order: a pickup joins the earliest existing stop at its origin; the drop
 * joins the first stop at its destination after that pickup; otherwise a stop is appended.
 * Gives the natural route for chains (A→B, B→C) and co-loading (A→B, A→C). Milk runs
 * (several pickups before one drop) should be sent as explicit stops.
 */
export function buildStopsFromDos(dos: DoRoute[]): StopPlan[] {
  const stops: StopPlan[] = [];
  for (const d of dos) {
    let p = stops.findIndex((s) => s.locationId === d.originLocationId);
    if (p === -1) {
      stops.push({ locationId: d.originLocationId, pickupDoIds: [], dropDoIds: [] });
      p = stops.length - 1;
    }
    stops[p]!.pickupDoIds.push(d.id);
    let q = stops.findIndex((s, i) => i > p && s.locationId === d.destLocationId);
    if (q === -1) {
      stops.push({ locationId: d.destLocationId, pickupDoIds: [], dropDoIds: [] });
      q = stops.length - 1;
    }
    stops[q]!.dropDoIds.push(d.id);
  }
  return stops;
}

/** Legs between consecutive stops; at each stop drops happen before pickups. */
export function deriveLegs(stops: StopPlan[]): LegPlan[] {
  const onboard = new Set<string>();
  const legs: LegPlan[] = [];
  stops.forEach((s, i) => {
    for (const id of s.dropDoIds) onboard.delete(id);
    for (const id of s.pickupDoIds) onboard.add(id);
    if (i < stops.length - 1) legs.push({ fromIndex: i, toIndex: i + 1, doIds: [...onboard], loaded: onboard.size > 0 });
  });
  return legs;
}

function indexMap(stops: StopPlan[], key: 'pickupDoIds' | 'dropDoIds'): Map<string, number[]> {
  const m = new Map<string, number[]>();
  stops.forEach((s, i) => {
    for (const id of s[key]) m.set(id, [...(m.get(id) ?? []), i]);
  });
  return m;
}

export function structuralIssues(stops: StopPlan[], dos: DoRoute[]): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const picks = indexMap(stops, 'pickupDoIds');
  const drops = indexMap(stops, 'dropDoIds');
  for (const d of dos) {
    const p = picks.get(d.id) ?? [];
    const q = drops.get(d.id) ?? [];
    const details = { doId: d.id };
    if (p.length === 0) errors.push({ code: 'DO_PICKUP_MISSING', message: 'Delivery order has no pickup stop', details });
    if (q.length === 0) errors.push({ code: 'DO_DROP_MISSING', message: 'Delivery order has no drop stop', details });
    if (p.length > 1 || q.length > 1) errors.push({ code: 'DO_DUPLICATED', message: 'Delivery order is picked up or dropped more than once', details });
    if (p.length === 1 && q.length === 1) {
      const [pi] = p as [number];
      const [qi] = q as [number];
      if (qi <= pi) errors.push({ code: 'DROP_BEFORE_PICKUP', message: 'Delivery order is dropped before it is picked up', details: { ...details, pickupStop: pi, dropStop: qi } });
      if (stops[pi]!.locationId !== d.originLocationId) {
        errors.push({ code: 'PICKUP_LOCATION_MISMATCH', message: 'Pickup stop is not at the delivery order origin', details: { ...details, stop: pi } });
      }
      if (stops[qi]!.locationId !== d.destLocationId) {
        errors.push({ code: 'DROP_LOCATION_MISMATCH', message: 'Drop stop is not at the delivery order destination', details: { ...details, stop: qi } });
      }
    }
  }
  stops.forEach((s, i) => {
    if (i > 0 && stops[i - 1]!.locationId === s.locationId) {
      warnings.push({ code: 'ADJACENT_SAME_LOCATION', message: 'Two consecutive stops are at the same location', details: { stop: i } });
    }
  });
  return { errors, warnings };
}
