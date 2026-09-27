import { z } from 'zod';
import { objectIdString } from '../../lib/ids.js';
import { IssueSchema } from '../../lib/issues.js';
import { DO_STATUSES, MATCH_STATUSES } from './order.types.js';

const iso = z.string().datetime({ offset: true });

export const WindowInput = z
  .object({ from: iso, to: iso })
  .refine((w) => Date.parse(w.from) < Date.parse(w.to), { message: 'from must be before to' });

export const DoFields = z.object({
  clientId: objectIdString,
  clientRef: z.string().trim().max(60).nullable().default(null).describe('The client\'s own reference for this order, shown alongside the internal doNo.'),
  serviceTypeId: objectIdString,
  materialId: objectIdString.describe('Determines the default `unit` when none is sent explicitly.'),
  intendedTruckTypeId: objectIdString.nullable().default(null).describe('Truck type to match a job group against before the DO is on a shipment; once assigned, the shipment head vehicle\'s truck type takes over instead.'),
  qty: z.number().positive(),
  unit: z.string().trim().min(1).max(20).nullable().default(null).describe('Leave unset to inherit the unit from `materialId`.'),
  palletPlan: z.object({ type: z.string().trim().min(1).max(40), qty: z.number().int().min(0) }).nullable().default(null),
  originLocationId: objectIdString,
  destLocationId: objectIdString.describe('Must differ from originLocationId; 422 SAME_ORIGIN_DEST otherwise.'),
  pickupWindow: WindowInput.nullable().default(null),
  dropWindow: WindowInput.nullable().default(null),
  clientKm: z.number().min(0).nullable().default(null).describe('Distance the client bills for this DO, independent of the GPS-measured trip distance.'),
  jobGroupId: objectIdString.nullable().optional().describe('Set to assign a job group manually (locks matching to `manual`); omit to let the server auto-match one and report JOB_GROUP_NONE/JOB_GROUP_AMBIGUOUS warnings when it can\'t.'),
  note: z.string().trim().max(500).nullable().default(null),
});
export type DoInput = z.infer<typeof DoFields>;

export const PatchDoBody = DoFields.partial();
export type DoPatch = z.infer<typeof PatchDoBody>;

const WindowOut = z.object({ from: z.string(), to: z.string() }).nullable();

export const DoItem = z.object({
  id: z.string(),
  doNo: z.string(),
  clientRef: z.string().nullable(),
  clientId: z.string(),
  jobGroupId: z.string().nullable(),
  jobGroupMatch: z
    .object({ status: z.enum(MATCH_STATUSES), candidates: z.array(z.string()) })
    .describe('How jobGroupId was decided: "auto" (one match), "manual" (set via PATCH or /job-group), "ambiguous" (several candidates, none chosen), or "none" (no match).'),
  serviceTypeId: z.string(),
  materialId: z.string(),
  intendedTruckTypeId: z.string().nullable(),
  qty: z.number(),
  unit: z.string(),
  palletPlan: z.object({ type: z.string(), qty: z.number() }).nullable(),
  originLocationId: z.string(),
  destLocationId: z.string(),
  pickupWindow: WindowOut,
  dropWindow: WindowOut,
  distance: z.object({ clientKm: z.number().nullable() }),
  shipmentId: z.string().nullable(),
  pickupStopId: z.string().nullable(),
  dropStopId: z.string().nullable(),
  status: z.enum(DO_STATUSES).describe(
    'UNASSIGNED → PLANNED (on a shipment) → PICKED_UP (LOAD_END recorded) → DELIVERED/POD_VERIFIED/POD_REJECTED/FAILED (from its latest proof of delivery, POD) → CANCELLED. Derived from events and PODs, not set directly.',
  ),
  attempts: z
    .array(z.object({ shipmentId: z.string(), reasonCode: z.string(), podId: z.string(), at: z.string() }))
    .default([])
    .describe('Failed delivery attempts: one entry per FAILED POD, so a DO redelivered on a later shipment keeps its history.'),
  note: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});

export const DoWithWarnings = DoItem.extend({ warnings: z.array(IssueSchema) });
