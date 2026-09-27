import { z } from 'zod';
import { objectIdString } from '../../lib/ids.js';
import { IssueSchema } from '../../lib/issues.js';
import { STOP_STATUSES } from '../../lib/status.js';
import { SHIPMENT_STATUSES } from './shipment.types.js';

const iso = z.string().datetime({ offset: true });

const SlotInput = z.object({
  vehicleId: objectIdString,
  driverId: objectIdString.nullable().default(null).describe('Required to dispatch/plan (mode "planned"); may be left null on a draft.'),
});
const StopInput = z.object({
  locationId: objectIdString,
  plannedArrival: iso.nullable().default(null),
  pickupDoIds: z.array(objectIdString).default([]).describe('Delivery orders picked up at this stop; each must have this location as its origin.'),
  dropDoIds: z.array(objectIdString).default([]).describe('Delivery orders dropped at this stop; each must have this location as its destination.'),
});

export const ShipmentInput = z.object({
  plannedStart: iso,
  plannedEnd: iso,
  head: SlotInput.nullable().default(null).describe('The head (or rigid) vehicle/driver slot; required to plan/dispatch.'),
  tail: SlotInput.nullable().default(null).describe('The tail vehicle/driver slot; required when the head is a tractor head, forbidden when it is a rigid truck.'),
  stops: z
    .array(StopInput)
    .max(50)
    .optional()
    .describe('Explicit stop-by-stop route. Mutually exclusive with `doIds` — send one or the other, not both.'),
  doIds: z
    .array(objectIdString)
    .max(50)
    .optional()
    .describe('Delivery orders to route automatically (one stop per distinct origin/destination, in DO order). Simpler alternative to `stops` for straightforward routes; use `stops` for milk runs.'),
  note: z.string().trim().max(500).nullable().default(null),
});
export type ShipmentInputT = z.infer<typeof ShipmentInput>;

export const ValidateBody = ShipmentInput.extend({
  shipmentId: objectIdString.optional().describe('Validate as an edit to this existing shipment, so its own DOs/resource bookings are not reported as conflicts with themselves.'),
  mode: z
    .enum(['draft', 'planned'])
    .default('planned')
    .describe('"draft": missing head/tail/driver/stops/DOs are warnings only. "planned": the same gaps are errors (what /plan and /dispatch require).'),
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
  status: z
    .enum(SHIPMENT_STATUSES)
    .describe('DRAFT → PLANNED → DISPATCHED → ACCEPTED → IN_TRANSIT (first driver event) → COMPLETED (every DO has a POD) → CLOSED; or CANCELLED at any point up to ACCEPTED.'),
  version: z.number().describe('Optimistic-concurrency counter; send back the value you last saw on PATCH/plan/dispatch/cancel — 409 VERSION_CONFLICT if it is stale.'),
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
      status: z.enum(STOP_STATUSES).describe('Derived from recorded driver events at this stop: PENDING → ARRIVED → WORKING (any unload/load step) → DONE (DEPARTED).'),
    }),
  ),
  legs: z.array(
    z.object({
      fromStopId: z.string(),
      toStopId: z.string(),
      loaded: z.boolean().describe('Whether the truck carries any delivery order between these two stops.'),
      doIds: z.array(z.string()),
      mapKm: z.number().nullable(),
      gpsKm: z.number().nullable(),
    }),
  ),
  warnings: z.array(IssueSchema),
  note: z.string().nullable(),
  dispatch: z.object({ at: z.string(), by: z.string(), version: z.number() }).nullable(),
  driverResponse: z
    .object({ status: z.enum(['ACCEPTED', 'DECLINED']), reason: z.string().nullable(), at: z.string(), by: z.string() })
    .nullable()
    .describe('The driver\'s response to the current dispatch; cleared back to null on every re-dispatch (a decline sends the shipment back to PLANNED).'),
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
