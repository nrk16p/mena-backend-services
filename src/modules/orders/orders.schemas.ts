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
  clientRef: z.string().trim().max(60).nullable().default(null),
  serviceTypeId: objectIdString,
  materialId: objectIdString,
  intendedTruckTypeId: objectIdString.nullable().default(null),
  qty: z.number().positive(),
  unit: z.string().trim().min(1).max(20).nullable().default(null),
  palletPlan: z.object({ type: z.string().trim().min(1).max(40), qty: z.number().int().min(0) }).nullable().default(null),
  originLocationId: objectIdString,
  destLocationId: objectIdString,
  pickupWindow: WindowInput.nullable().default(null),
  dropWindow: WindowInput.nullable().default(null),
  clientKm: z.number().min(0).nullable().default(null),
  jobGroupId: objectIdString.nullable().optional(),
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
  jobGroupMatch: z.object({ status: z.enum(MATCH_STATUSES), candidates: z.array(z.string()) }),
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
  status: z.enum(DO_STATUSES),
  attempts: z.array(z.object({ shipmentId: z.string(), reasonCode: z.string(), podId: z.string(), at: z.string() })).default([]),
  note: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});

export const DoWithWarnings = DoItem.extend({ warnings: z.array(IssueSchema) });
