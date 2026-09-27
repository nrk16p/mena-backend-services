import { z } from 'zod';
import { objectIdString } from '../../lib/ids.js';
import { IssueSchema } from '../../lib/issues.js';
import { STOP_STATUSES } from '../../lib/status.js';
import { SHIPMENT_STATUSES } from './shipment.types.js';

const iso = z.string().datetime({ offset: true });

const SlotInput = z.object({ vehicleId: objectIdString, driverId: objectIdString.nullable().default(null) });
const StopInput = z.object({
  locationId: objectIdString,
  plannedArrival: iso.nullable().default(null),
  pickupDoIds: z.array(objectIdString).default([]),
  dropDoIds: z.array(objectIdString).default([]),
});

export const ShipmentInput = z.object({
  plannedStart: iso,
  plannedEnd: iso,
  head: SlotInput.nullable().default(null),
  tail: SlotInput.nullable().default(null),
  stops: z.array(StopInput).max(50).optional(),
  doIds: z.array(objectIdString).max(50).optional(),
  note: z.string().trim().max(500).nullable().default(null),
});
export type ShipmentInputT = z.infer<typeof ShipmentInput>;

export const ValidateBody = ShipmentInput.extend({
  shipmentId: objectIdString.optional(),
  mode: z.enum(['draft', 'planned']).default('planned'),
});

export const StopPlanOut = z.object({
  locationId: z.string(),
  plannedArrival: z.string().nullable(),
  pickupDoIds: z.array(z.string()),
  dropDoIds: z.array(z.string()),
});
export const LegPlanOut = z.object({ fromIndex: z.number(), toIndex: z.number(), doIds: z.array(z.string()), loaded: z.boolean() });

export const ValidateResponse = z.object({
  errors: z.array(IssueSchema),
  warnings: z.array(IssueSchema),
  stops: z.array(StopPlanOut),
  legs: z.array(LegPlanOut),
});

const SlotOut = z.object({ vehicleId: z.string(), driverId: z.string().nullable() }).nullable();

export const ShipmentItem = z.object({
  id: z.string(),
  shipmentNo: z.string(),
  status: z.enum(SHIPMENT_STATUSES),
  version: z.number(),
  plannedStart: z.string(),
  plannedEnd: z.string(),
  head: SlotOut,
  tail: SlotOut,
  stops: z.array(
    z.object({
      stopId: z.string(),
      seq: z.number(),
      locationId: z.string(),
      pickupDoIds: z.array(z.string()),
      dropDoIds: z.array(z.string()),
      plannedArrival: z.string().nullable(),
      status: z.enum(STOP_STATUSES),
    }),
  ),
  legs: z.array(
    z.object({
      fromStopId: z.string(),
      toStopId: z.string(),
      loaded: z.boolean(),
      doIds: z.array(z.string()),
      mapKm: z.number().nullable(),
      gpsKm: z.number().nullable(),
    }),
  ),
  warnings: z.array(IssueSchema),
  note: z.string().nullable(),
  dispatch: z.object({ at: z.string(), by: z.string(), version: z.number() }).nullable(),
  driverResponse: z.object({ status: z.enum(['ACCEPTED', 'DECLINED']), reason: z.string().nullable(), at: z.string(), by: z.string() }).nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  closedAt: z.string().nullable().default(null),
  closedBy: z.string().nullable().default(null),
  summaryId: z.string().nullable().default(null),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
