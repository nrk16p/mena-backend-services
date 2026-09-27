import type { ObjectId } from 'mongodb';
import type { Issue } from '../../lib/issues.js';

export const SHIPMENT_STATUSES = ['DRAFT', 'PLANNED', 'DISPATCHED', 'ACCEPTED', 'IN_TRANSIT', 'COMPLETED', 'CLOSED', 'CANCELLED'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];
/** Shipments that hold their vehicles and drivers (spec §4: every non-cancelled, non-closed shipment). */
export const RESERVING_STATUSES: ShipmentStatus[] = ['DRAFT', 'PLANNED', 'DISPATCHED', 'ACCEPTED', 'IN_TRANSIT', 'COMPLETED'];
export const EDITABLE_STATUSES: ShipmentStatus[] = ['DRAFT', 'PLANNED', 'DISPATCHED', 'ACCEPTED'];

export interface Slot {
  vehicleId: ObjectId;
  driverId: ObjectId | null;
}

export interface StopDoc {
  stopId: ObjectId;
  seq: number;
  locationId: ObjectId;
  pickupDoIds: ObjectId[];
  dropDoIds: ObjectId[];
  plannedArrival: Date | null;
  status: 'PENDING';
}

export interface LegDoc {
  fromStopId: ObjectId;
  toStopId: ObjectId;
  loaded: boolean;
  doIds: ObjectId[];
  mapKm: number | null;
  gpsKm: number | null;
}

export interface ShipmentDoc {
  _id: ObjectId;
  shipmentNo: string;
  status: ShipmentStatus;
  version: number;
  plannedStart: Date;
  plannedEnd: Date;
  head: Slot | null;
  tail: Slot | null;
  stops: StopDoc[];
  legs: LegDoc[];
  warnings: Issue[];
  note: string | null;
  dispatch: { at: Date; by: string; version: number } | null;
  driverResponse: { status: 'ACCEPTED' | 'DECLINED'; reason: string | null; at: Date; by: string } | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
}
