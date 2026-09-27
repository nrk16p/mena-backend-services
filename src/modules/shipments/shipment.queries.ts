import type { ClientSession, Db, Filter, ObjectId } from 'mongodb';
import { C } from '../../db/collections.js';
import { RESERVING_STATUSES, type ShipmentDoc } from './shipment.types.js';

export type ShipmentRef = Pick<ShipmentDoc, '_id' | 'shipmentNo' | 'status' | 'plannedStart' | 'plannedEnd'>;

export async function findShipmentsUsing(
  db: Db,
  resourceType: 'vehicle' | 'driver',
  resourceId: ObjectId,
  from: Date,
  to: Date,
  excludeShipmentId?: ObjectId,
  session?: ClientSession,
): Promise<ShipmentRef[]> {
  const field = resourceType === 'vehicle' ? 'vehicleId' : 'driverId';
  const filter: Filter<ShipmentDoc> = {
    status: { $in: RESERVING_STATUSES },
    plannedStart: { $lt: to },
    plannedEnd: { $gt: from },
    $or: [{ [`head.${field}`]: resourceId }, { [`tail.${field}`]: resourceId }],
  };
  if (excludeShipmentId) filter._id = { $ne: excludeShipmentId };
  return db
    .collection<ShipmentDoc>(C.shipments)
    .find(filter, { projection: { shipmentNo: 1, status: 1, plannedStart: 1, plannedEnd: 1 }, session })
    .sort({ plannedStart: 1 })
    .toArray();
}
