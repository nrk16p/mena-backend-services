import type { ObjectId } from 'mongodb';

export const DO_STATUSES = ['UNASSIGNED', 'PLANNED', 'PICKED_UP', 'DELIVERED', 'POD_VERIFIED', 'POD_REJECTED', 'FAILED', 'CANCELLED'] as const;
export type DoStatus = (typeof DO_STATUSES)[number];
export const MATCH_STATUSES = ['auto', 'manual', 'ambiguous', 'none'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export interface TimeWindow {
  from: Date;
  to: Date;
}

export interface DeliveryOrderDoc {
  _id: ObjectId;
  doNo: string;
  clientRef: string | null;
  clientId: ObjectId;
  jobGroupId: ObjectId | null;
  jobGroupMatch: { status: MatchStatus; candidates: ObjectId[] };
  serviceTypeId: ObjectId;
  materialId: ObjectId;
  intendedTruckTypeId: ObjectId | null;
  qty: number;
  unit: string;
  palletPlan: { type: string; qty: number } | null;
  originLocationId: ObjectId;
  destLocationId: ObjectId;
  pickupWindow: TimeWindow | null;
  dropWindow: TimeWindow | null;
  distance: { clientKm: number | null };
  shipmentId: ObjectId | null;
  pickupStopId: ObjectId | null;
  dropStopId: ObjectId | null;
  status: DoStatus;
  /** Failed delivery attempts (spec §3.3), pushed by a FAILED POD. */
  attempts?: { shipmentId: ObjectId; reasonCode: string; podId: ObjectId; at: Date }[];
  /** Set by the Plan 4 migration; legacy DOs are exempt from the job-group requirement at close (spec §3.4). */
  legacy?: boolean;
  note: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
}
