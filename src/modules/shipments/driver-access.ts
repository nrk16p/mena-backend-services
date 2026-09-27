import { ObjectId, type Db, type Filter } from 'mongodb';
import { C } from '../../db/collections.js';
import { AppError, notFound } from '../../lib/errors.js';
import type { ShipmentDoc } from './shipment.types.js';

/** The caller's linked driver id; 403 NOT_A_DRIVER for users without one (and for API keys). */
export function driverIdOf(req: { principal: unknown }): ObjectId {
  const p = req.principal as { kind: string; driverId: string | null } | null;
  if (!p || p.kind !== 'user' || !p.driverId) throw new AppError(403, 'NOT_A_DRIVER', 'This user is not linked to a driver');
  return new ObjectId(p.driverId);
}

/** Shipments where the driver is the head or the tail driver. */
export function driverScope(driverId: ObjectId): Filter<ShipmentDoc> {
  return { $or: [{ 'head.driverId': driverId }, { 'tail.driverId': driverId }] };
}

/** Loads a shipment the driver works on; anyone else's shipment is reported as not found (spec §8.2). */
export async function loadDriverShipment(db: Db, id: ObjectId, driverId: ObjectId): Promise<ShipmentDoc> {
  const doc = await db.collection<ShipmentDoc>(C.shipments).findOne({ _id: id, ...driverScope(driverId) });
  if (!doc) throw notFound('Shipment');
  return doc;
}
