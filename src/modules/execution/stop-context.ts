import type { Db, ObjectId } from 'mongodb';
import { C } from '../../db/collections.js';

/** Event codes already recorded at a stop (served by the events { shipmentId, deviceTime } index). */
export async function doneStepsAt(db: Db, shipmentId: ObjectId, stopId: ObjectId): Promise<Set<string>> {
  const rows = await db.collection<{ code: string }>(C.events).find({ shipmentId, stopId }, { projection: { code: 1 } }).toArray();
  return new Set(rows.map((e) => e.code));
}

export interface GeofenceTarget {
  lat: number;
  lng: number;
  radiusM: number;
}

/** The stop location's geofence, used for the OUTSIDE_GEOFENCE flag (spec §5.4); undefined when the location has no position. */
export async function geofenceTarget(db: Db, locationId: ObjectId): Promise<GeofenceTarget | undefined> {
  const loc = await db
    .collection<{ geo?: { coordinates: [number, number] } | null; geofenceRadiusM?: number }>(C.locations)
    .findOne({ _id: locationId }, { projection: { geo: 1, geofenceRadiusM: 1 } });
  if (!loc?.geo || typeof loc.geofenceRadiusM !== 'number') return undefined;
  return { lat: loc.geo.coordinates[1], lng: loc.geo.coordinates[0], radiusM: loc.geofenceRadiusM };
}
