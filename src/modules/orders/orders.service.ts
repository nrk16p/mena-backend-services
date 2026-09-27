import { ObjectId, type Db } from 'mongodb';
import { C } from '../../db/collections.js';
import { type RefCheck, assertActiveRefs } from '../../lib/active-refs.js';
import { unprocessable } from '../../lib/errors.js';
import type { Issue } from '../../lib/issues.js';
import { matchJobGroupForDo } from '../master/job-groups.js';
import type { DeliveryOrderDoc, MatchStatus, TimeWindow } from './order.types.js';
import type { DoPatch } from './orders.schemas.js';

type JobGroupFields = Pick<DeliveryOrderDoc, 'jobGroupId' | 'jobGroupMatch'>;

const toWindow = (w: { from: string; to: string } | null): TimeWindow | null =>
  w ? { from: new Date(w.from), to: new Date(w.to) } : null;

export function jobGroupWarnings(doNo: string | null, status: MatchStatus): Issue[] {
  const label = doNo ?? 'this delivery order';
  if (status === 'none') return [{ code: 'JOB_GROUP_NONE', message: `No job group matches ${label}`, details: { doNo } }];
  if (status === 'ambiguous') {
    return [{ code: 'JOB_GROUP_AMBIGUOUS', message: `Several job groups match ${label}; choose one`, details: { doNo } }];
  }
  return [];
}

async function autoMatch(db: Db, d: DeliveryOrderDoc, truckTypeId: ObjectId | null): Promise<JobGroupFields> {
  const r = await matchJobGroupForDo(db, d.clientId, {
    truckTypeId,
    serviceTypeId: d.serviceTypeId,
    materialId: d.materialId,
    originLocationId: d.originLocationId,
    destLocationId: d.destLocationId,
  });
  return {
    jobGroupId: r.jobGroupId ? new ObjectId(r.jobGroupId) : null,
    jobGroupMatch: { status: r.status, candidates: r.candidates.map((c) => new ObjectId(c)) },
  };
}

/** Re-runs automatic matching (e.g. once a vehicle is known). Returns null for manual matches. */
export async function rematchJobGroup(db: Db, d: DeliveryOrderDoc, truckTypeId: ObjectId | null): Promise<JobGroupFields | null> {
  if (d.jobGroupMatch.status === 'manual') return null;
  return autoMatch(db, d, truckTypeId);
}

/**
 * Applies `set` only if the DO's status and shipmentId still match `existing` (the caller's
 * snapshot), so a concurrent shipment-assignment or cancel between load and write can't be
 * clobbered by a stale edit. Returns null when the stored document has moved on.
 */
export async function updateDoIfUnchanged(
  db: Db,
  existing: DeliveryOrderDoc,
  set: Partial<DeliveryOrderDoc>,
): Promise<DeliveryOrderDoc | null> {
  return db.collection<DeliveryOrderDoc>(C.deliveryOrders).findOneAndUpdate(
    { _id: existing._id, status: existing.status, shipmentId: existing.shipmentId },
    { $set: set },
    { returnDocument: 'after' },
  );
}

/**
 * Turns a create body (all fields) or a patch body (some fields) into the fields to $set.
 * `existing` is null on create. Throws 422 for rule violations; returns job-group warnings.
 */
export async function prepareDoFields(
  db: Db,
  input: DoPatch,
  existing: DeliveryOrderDoc | null,
): Promise<{ set: Partial<DeliveryOrderDoc>; warnings: Issue[] }> {
  const set: Partial<DeliveryOrderDoc> = {};
  const refChecks: RefCheck[] = [];
  const idField = (key: 'clientId' | 'serviceTypeId' | 'materialId' | 'originLocationId' | 'destLocationId', collection: string) => {
    const v = input[key];
    if (v === undefined) return;
    set[key] = new ObjectId(v);
    refChecks.push({ field: key, collection, ids: [set[key]] });
  };
  idField('clientId', C.clients);
  idField('serviceTypeId', C.serviceTypes);
  idField('materialId', C.materials);
  idField('originLocationId', C.locations);
  idField('destLocationId', C.locations);
  if (input.intendedTruckTypeId !== undefined) {
    set.intendedTruckTypeId = input.intendedTruckTypeId ? new ObjectId(input.intendedTruckTypeId) : null;
    refChecks.push({ field: 'intendedTruckTypeId', collection: C.truckTypes, ids: [set.intendedTruckTypeId] });
  }
  if (input.clientRef !== undefined) set.clientRef = input.clientRef;
  if (input.qty !== undefined) set.qty = input.qty;
  if (input.palletPlan !== undefined) set.palletPlan = input.palletPlan;
  if (input.note !== undefined) set.note = input.note;
  if (input.pickupWindow !== undefined) set.pickupWindow = toWindow(input.pickupWindow);
  if (input.dropWindow !== undefined) set.dropWindow = toWindow(input.dropWindow);
  if (input.clientKm !== undefined) set.distance = { clientKm: input.clientKm };

  const merged = { ...(existing ?? {}), ...set } as DeliveryOrderDoc;
  if (merged.originLocationId.equals(merged.destLocationId)) {
    throw unprocessable('SAME_ORIGIN_DEST', 'Origin and destination must be different locations');
  }
  if (existing?.shipmentId) {
    const locked = (['clientId', 'originLocationId', 'destLocationId'] as const).filter(
      (k) => set[k] !== undefined && !(set[k] as ObjectId).equals(existing[k]),
    );
    if (locked.length > 0) {
      throw unprocessable('DO_LOCKED_BY_SHIPMENT', 'Remove the delivery order from its shipment before changing client or route', { fields: locked });
    }
  }
  await assertActiveRefs(db, refChecks);

  if (input.unit !== undefined && input.unit !== null) {
    set.unit = input.unit;
  } else if (!existing || (set.materialId !== undefined && !set.materialId.equals(existing.materialId))) {
    // Creating, or the material changed without an explicit unit: pull the unit from the (new) material.
    const material = await db.collection(C.materials).findOne({ _id: merged.materialId });
    set.unit = String(material?.unit ?? '');
  }

  let jg: JobGroupFields;
  if (typeof input.jobGroupId === 'string') {
    const jobGroupId = new ObjectId(input.jobGroupId);
    const group = await db.collection(C.jobGroups).findOne({ _id: jobGroupId, clientId: merged.clientId, active: true });
    if (!group) throw unprocessable('INVALID_JOB_GROUP', 'jobGroupId must be an active job group of the same client');
    jg = { jobGroupId, jobGroupMatch: { status: 'manual', candidates: [jobGroupId] } };
  } else if (input.jobGroupId === undefined && existing?.jobGroupMatch.status === 'manual' && existing.clientId.equals(merged.clientId)) {
    jg = { jobGroupId: existing.jobGroupId, jobGroupMatch: existing.jobGroupMatch };
  } else {
    jg = await autoMatch(db, merged, merged.intendedTruckTypeId ?? null);
  }
  Object.assign(set, jg);
  return { set, warnings: jobGroupWarnings(existing?.doNo ?? null, jg.jobGroupMatch.status) };
}
