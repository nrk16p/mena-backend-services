import type { FastifyInstance } from 'fastify';
import { ObjectId, type ClientSession, type Db } from 'mongodb';
import { C } from '../../db/collections.js';
import { writeAudit } from '../../lib/audit.js';
import { nextNumber } from '../../lib/counters.js';
import { conflict, unprocessable } from '../../lib/errors.js';
import type { Issue } from '../../lib/issues.js';
import { toApi } from '../../lib/serialize.js';
import { withTransaction } from '../../lib/tx.js';
import type { JobGroupLite, LocationLite } from '../master/job-groups.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import { jobGroupWarnings, rematchJobGroup, rematchJobGroupBatch } from '../orders/orders.service.js';
import { findShipmentsUsing } from './shipment.queries.js';
import type { ShipmentInputT } from './shipment.schemas.js';
import { EDITABLE_STATUSES } from './shipment.types.js';
import type { LegDoc, ShipmentDoc, ShipmentStatus, StopDoc } from './shipment.types.js';
import { type DraftStop, type ShipmentDraft, type VehicleLite, toDraft, validateShipment } from './shipment.validation.js';

const oid = (h: string) => new ObjectId(h);
const sameIds = (a: ObjectId[], b: string[]) => a.length === b.length && a.every((x, i) => x.toHexString() === b[i]);

export function buildStopDocs(stops: DraftStop[], keep: StopDoc[] = []): StopDoc[] {
  return stops.map((s, i) => {
    const old = keep[i];
    const unchanged =
      old && old.locationId.toHexString() === s.locationId && sameIds(old.pickupDoIds, s.pickupDoIds) && sameIds(old.dropDoIds, s.dropDoIds);
    return {
      stopId: unchanged ? old.stopId : new ObjectId(),
      seq: i + 1,
      locationId: oid(s.locationId),
      pickupDoIds: s.pickupDoIds.map(oid),
      dropDoIds: s.dropDoIds.map(oid),
      plannedArrival: s.plannedArrival,
      status: 'PENDING',
    };
  });
}

export function buildLegDocs(stops: StopDoc[]): LegDoc[] {
  const onboard = new Map<string, ObjectId>();
  const legs: LegDoc[] = [];
  stops.forEach((s, i) => {
    for (const id of s.dropDoIds) onboard.delete(id.toHexString());
    for (const id of s.pickupDoIds) onboard.set(id.toHexString(), id);
    const next = stops[i + 1];
    if (next) legs.push({ fromStopId: s.stopId, toStopId: next.stopId, loaded: onboard.size > 0, doIds: [...onboard.values()], mapKm: null, gpsKm: null });
  });
  return legs;
}

export function doIdsOf(stops: StopDoc[]): ObjectId[] {
  const m = new Map<string, ObjectId>();
  for (const s of stops) for (const id of [...s.pickupDoIds, ...s.dropDoIds]) m.set(id.toHexString(), id);
  return [...m.values()];
}

export async function linkDos(db: Db, shipment: ShipmentDoc, previousDoIds: ObjectId[], session: ClientSession): Promise<void> {
  const coll = db.collection<DeliveryOrderDoc>(C.deliveryOrders);
  const now = new Date();
  const stopsOf = new Map<string, { pickupStopId: ObjectId | null; dropStopId: ObjectId | null; id: ObjectId }>();
  for (const s of shipment.stops) {
    for (const id of s.pickupDoIds) stopsOf.set(id.toHexString(), { ...(stopsOf.get(id.toHexString()) ?? { dropStopId: null, id }), pickupStopId: s.stopId });
    for (const id of s.dropDoIds) stopsOf.set(id.toHexString(), { ...(stopsOf.get(id.toHexString()) ?? { pickupStopId: null, id }), dropStopId: s.stopId });
  }
  const removed = previousDoIds.filter((id) => !stopsOf.has(id.toHexString()));
  if (removed.length > 0) {
    // Once a DO leaves a shipment, its truck type can no longer come from that shipment's
    // vehicle (spec §3.4): re-match on `intendedTruckTypeId` alone so a stale vehicle-based
    // match doesn't survive the DO going back into the pool.
    const removedDos = await coll.find({ _id: { $in: removed }, shipmentId: shipment._id }, { session }).toArray();
    for (const d of removedDos) {
      const rematched = await rematchJobGroup(db, d, d.intendedTruckTypeId ?? null);
      await coll.updateOne(
        { _id: d._id, shipmentId: shipment._id },
        { $set: { status: 'UNASSIGNED', shipmentId: null, pickupStopId: null, dropStopId: null, updatedAt: now, ...(rematched ?? {}) } },
        { session },
      );
    }
  }
  for (const link of stopsOf.values()) {
    const res = await coll.updateOne(
      { _id: link.id, $or: [{ shipmentId: null, status: 'UNASSIGNED' }, { shipmentId: shipment._id }] },
      { $set: { status: 'PLANNED', shipmentId: shipment._id, pickupStopId: link.pickupStopId, dropStopId: link.dropStopId, updatedAt: now } },
      { session },
    );
    if (res.matchedCount === 0) throw conflict('DO_TAKEN', 'A delivery order was taken by another shipment; reload and try again', { doId: link.id.toHexString() });
  }
}

const uniqueOids = (ids: (ObjectId | null | undefined)[]): ObjectId[] => {
  const m = new Map<string, ObjectId>();
  for (const id of ids) if (id) m.set(id.toHexString(), id);
  return [...m.values()];
};

/**
 * Serializes vehicle/driver booking so two concurrent `createShipment` transactions for an
 * overlapping window on the same vehicle or driver can't both commit. Plain reads before the
 * transaction (validateShipment) see a stale snapshot under snapshot isolation, so this writes
 * a no-op `$inc` to each resource's document first: MongoDB then conflicts the two transactions
 * on that document, aborting and retrying the loser (see withTransaction), which re-checks
 * overlap against the now-committed winner and throws `RESOURCE_TAKEN` instead of committing.
 */
export async function reserveResources(db: Db, shipment: ShipmentDoc, session: ClientSession): Promise<void> {
  const vehicleIds = uniqueOids([shipment.head?.vehicleId, shipment.tail?.vehicleId]);
  const driverIds = uniqueOids([shipment.head?.driverId, shipment.tail?.driverId]);
  for (const id of vehicleIds) await db.collection(C.vehicles).updateOne({ _id: id }, { $inc: { bookingLock: 1 } }, { session });
  for (const id of driverIds) await db.collection(C.drivers).updateOne({ _id: id }, { $inc: { bookingLock: 1 } }, { session });

  const conflictOn = async (resourceType: 'vehicle' | 'driver', id: ObjectId) => {
    const using = await findShipmentsUsing(db, resourceType, id, shipment.plannedStart, shipment.plannedEnd, shipment._id, session);
    if (using.length > 0) {
      throw conflict('RESOURCE_TAKEN', 'The vehicle or driver was booked by another shipment; reload and try again', {
        resourceType,
        resourceId: id.toHexString(),
        shipmentNos: using.map((s) => s.shipmentNo),
      });
    }
  };
  for (const id of vehicleIds) await conflictOn('vehicle', id);
  for (const id of driverIds) await conflictOn('driver', id);
}

export async function releaseDos(db: Db, shipmentId: ObjectId, session: ClientSession): Promise<void> {
  const coll = db.collection<DeliveryOrderDoc>(C.deliveryOrders);
  const dos = await coll.find({ shipmentId }, { session }).toArray();
  const now = new Date();
  for (const d of dos) {
    // Same rule as `linkDos`: once the shipment releases the DO (e.g. cancel), its truck type
    // can only come from `intendedTruckTypeId`, never the (now moot) shipment vehicle.
    const rematched = await rematchJobGroup(db, d, d.intendedTruckTypeId ?? null);
    await coll.updateOne(
      { _id: d._id, shipmentId },
      { $set: { status: 'UNASSIGNED', shipmentId: null, pickupStopId: null, dropStopId: null, updatedAt: now, ...(rematched ?? {}) } },
      { session },
    );
  }
}

/**
 * Re-matches every DO on the shipment (spec §3.4: truck type comes from the shipment's head
 * vehicle when known, else the DO's own `intendedTruckTypeId`). Fetches the locations and job
 * groups it needs once per call (one `$in` query each) instead of once per DO, since a shipment
 * can hold up to 50 stops worth of DOs (spec §13.2).
 */
export async function refreshJobGroups(db: Db, shipment: ShipmentDoc, headVehicle: VehicleLite | null, session: ClientSession): Promise<Issue[]> {
  const coll = db.collection<DeliveryOrderDoc>(C.deliveryOrders);
  const dos = await coll.find({ _id: { $in: doIdsOf(shipment.stops) } }, { session }).toArray();
  const warnings: Issue[] = [];
  if (dos.length === 0) return warnings;

  const locIds = [...new Set(dos.flatMap((d) => [d.originLocationId.toHexString(), d.destLocationId.toHexString()]))].map((h) => new ObjectId(h));
  const clientIds = [...new Set(dos.map((d) => d.clientId.toHexString()))].map((h) => new ObjectId(h));
  const [locs, groups] = await Promise.all([
    db.collection<LocationLite>(C.locations).find({ _id: { $in: locIds } }, { session }).toArray(),
    db.collection<JobGroupLite>(C.jobGroups).find({ clientId: { $in: clientIds }, active: true }, { session }).toArray(),
  ]);
  const locById = new Map(locs.map((l) => [l._id.toHexString(), l]));
  const groupsByClient = new Map<string, JobGroupLite[]>();
  for (const g of groups) {
    const key = g.clientId.toHexString();
    const arr = groupsByClient.get(key);
    if (arr) arr.push(g);
    else groupsByClient.set(key, [g]);
  }

  for (const d of dos) {
    const truckTypeId = headVehicle?.truckTypeId ?? d.intendedTruckTypeId ?? null;
    const next = rematchJobGroupBatch(d, truckTypeId, locById, groupsByClient);
    const status = next ? next.jobGroupMatch.status : d.jobGroupMatch.status;
    if (next) await coll.updateOne({ _id: d._id }, { $set: next }, { session });
    warnings.push(...jobGroupWarnings(d.doNo, status));
  }
  return warnings;
}

export const withoutJobGroupWarnings = (ws: Issue[]) => ws.filter((w) => !w.code.startsWith('JOB_GROUP_'));

export function invalid(errors: Issue[], warnings: Issue[]) {
  return unprocessable('SHIPMENT_INVALID', 'The shipment breaks planning rules', { errors, warnings });
}

export async function createShipment(
  app: FastifyInstance,
  input: ShipmentInputT,
  by: string,
  opts?: { timeoutMS?: number },
): Promise<{ doc: ShipmentDoc; warnings: Issue[] }> {
  const draft = await toDraft(app.db, input);
  const result = await validateShipment(app.db, draft, { mode: 'draft' });
  if (result.errors.length > 0) throw invalid(result.errors, result.warnings);
  const now = new Date();
  const stops = buildStopDocs(draft.stops);
  const doc: ShipmentDoc = {
    _id: new ObjectId(),
    shipmentNo: await nextNumber(app.db, 'SH'),
    status: 'DRAFT',
    version: 1,
    plannedStart: draft.plannedStart,
    plannedEnd: draft.plannedEnd,
    head: draft.head ? { vehicleId: oid(draft.head.vehicleId), driverId: draft.head.driverId ? oid(draft.head.driverId) : null } : null,
    tail: draft.tail ? { vehicleId: oid(draft.tail.vehicleId), driverId: draft.tail.driverId ? oid(draft.tail.driverId) : null } : null,
    stops,
    legs: buildLegDocs(stops),
    warnings: [],
    note: draft.note,
    dispatch: null,
    driverResponse: null,
    cancelledAt: null,
    cancelReason: null,
    createdBy: by,
    createdAt: now,
    updatedBy: by,
    updatedAt: now,
  };
  const warnings = await withTransaction(app.mongo, async (session) => {
    const coll = app.db.collection<ShipmentDoc>(C.shipments);
    await coll.insertOne(doc, { session });
    await reserveResources(app.db, doc, session);
    await linkDos(app.db, doc, [], session);
    const fresh = [...withoutJobGroupWarnings(result.warnings), ...(await refreshJobGroups(app.db, doc, result.headVehicle, session))];
    await coll.updateOne({ _id: doc._id }, { $set: { warnings: fresh } }, { session });
    // Safe to mutate the outer `doc` here even though withTransaction may retry this callback:
    // each attempt recomputes `fresh` from scratch and reassigns it, so a retried attempt
    // simply overwrites this with its own freshly-computed value before the transaction commits.
    doc.warnings = fresh;
    await writeAudit(app.db, { entity: 'shipment', entityId: doc._id.toHexString(), action: 'create', by, after: toApi(doc) }, { session });
    return fresh;
  }, opts);
  return { doc, warnings };
}

export function shipmentView(doc: ShipmentDoc) {
  return toApi(doc);
}

export function draftFromDoc(doc: ShipmentDoc): ShipmentDraft {
  const slot = (s: ShipmentDoc['head']) => (s ? { vehicleId: s.vehicleId.toHexString(), driverId: s.driverId?.toHexString() ?? null } : null);
  return {
    plannedStart: doc.plannedStart,
    plannedEnd: doc.plannedEnd,
    head: slot(doc.head),
    tail: slot(doc.tail),
    stops: doc.stops.map((s) => ({
      locationId: s.locationId.toHexString(),
      plannedArrival: s.plannedArrival,
      pickupDoIds: s.pickupDoIds.map((i) => i.toHexString()),
      dropDoIds: s.dropDoIds.map((i) => i.toHexString()),
    })),
    note: doc.note,
  };
}

const versionConflict = () => conflict('VERSION_CONFLICT', 'The shipment was changed by someone else; reload and try again');

export async function updateShipment(
  app: FastifyInstance,
  existing: ShipmentDoc,
  patch: Partial<ShipmentInputT> & { version: number },
  by: string,
): Promise<ShipmentDoc> {
  if (!EDITABLE_STATUSES.includes(existing.status)) {
    throw unprocessable('SHIPMENT_NOT_EDITABLE', `A ${existing.status} shipment cannot be edited`);
  }
  if (patch.version !== existing.version) throw versionConflict();
  const base = draftFromDoc(existing);
  const draft: ShipmentDraft = {
    plannedStart: patch.plannedStart ? new Date(patch.plannedStart) : base.plannedStart,
    plannedEnd: patch.plannedEnd ? new Date(patch.plannedEnd) : base.plannedEnd,
    head: patch.head !== undefined ? patch.head : base.head,
    tail: patch.tail !== undefined ? patch.tail : base.tail,
    stops: base.stops,
    note: patch.note !== undefined ? patch.note : base.note,
  };
  if (patch.stops || patch.doIds) {
    const rebuilt = await toDraft(app.db, {
      plannedStart: draft.plannedStart.toISOString(),
      plannedEnd: draft.plannedEnd.toISOString(),
      head: draft.head,
      tail: draft.tail,
      stops: patch.stops,
      doIds: patch.doIds,
      note: draft.note,
    });
    draft.stops = rebuilt.stops;
  }
  const mode = existing.status === 'DRAFT' ? 'draft' : 'planned';
  const result = await validateShipment(app.db, draft, { shipmentId: existing._id, mode });
  if (result.errors.length > 0) throw invalid(result.errors, result.warnings);

  const stops = buildStopDocs(draft.stops, existing.stops);
  const status: ShipmentStatus = existing.status === 'DRAFT' ? 'DRAFT' : 'PLANNED';
  const next: ShipmentDoc = {
    ...existing,
    plannedStart: draft.plannedStart,
    plannedEnd: draft.plannedEnd,
    head: draft.head ? { vehicleId: oid(draft.head.vehicleId), driverId: draft.head.driverId ? oid(draft.head.driverId) : null } : null,
    tail: draft.tail ? { vehicleId: oid(draft.tail.vehicleId), driverId: draft.tail.driverId ? oid(draft.tail.driverId) : null } : null,
    stops,
    legs: buildLegDocs(stops),
    note: draft.note,
    status,
    dispatch: status === 'PLANNED' ? null : existing.dispatch,
    driverResponse: status === 'PLANNED' ? null : existing.driverResponse,
    version: existing.version + 1,
    updatedBy: by,
    updatedAt: new Date(),
  };
  return withTransaction(app.mongo, async (session) => {
    const coll = app.db.collection<ShipmentDoc>(C.shipments);
    const { _id, ...rest } = next;
    const res = await coll.updateOne({ _id, version: existing.version }, { $set: rest }, { session });
    if (res.matchedCount === 0) throw versionConflict();
    await reserveResources(app.db, next, session);
    await linkDos(app.db, next, doIdsOf(existing.stops), session);
    next.warnings = [...withoutJobGroupWarnings(result.warnings), ...(await refreshJobGroups(app.db, next, result.headVehicle, session))];
    await coll.updateOne({ _id }, { $set: { warnings: next.warnings } }, { session });
    await writeAudit(app.db, { entity: 'shipment', entityId: _id.toHexString(), action: 'update', by, before: toApi(existing), after: toApi(next) }, { session });
    return next;
  });
}

export async function transition(
  app: FastifyInstance,
  existing: ShipmentDoc,
  opts: { version: number; from: ShipmentStatus[]; set: Partial<ShipmentDoc>; action: string; by: string; notAllowedCode: string; releaseDos?: boolean },
): Promise<ShipmentDoc> {
  if (!opts.from.includes(existing.status)) {
    throw unprocessable(opts.notAllowedCode, `Cannot ${opts.action} a ${existing.status} shipment`);
  }
  if (opts.version !== existing.version) throw versionConflict();
  return withTransaction(app.mongo, async (session) => {
    const coll = app.db.collection<ShipmentDoc>(C.shipments);
    const updated = await coll.findOneAndUpdate(
      { _id: existing._id, version: existing.version, status: existing.status },
      { $set: { ...opts.set, updatedBy: opts.by, updatedAt: new Date() }, $inc: { version: 1 } },
      { returnDocument: 'after', session },
    );
    if (!updated) throw versionConflict();
    if (opts.releaseDos) await releaseDos(app.db, existing._id, session);
    // `after` includes every field the caller actually set (e.g. `driverResponse` with a decline
    // reason, or `dispatch`), not just `status`, so the audit trail shows what changed.
    const changed = Object.fromEntries(Object.keys(opts.set).map((k) => [k, (updated as unknown as Record<string, unknown>)[k]]));
    await writeAudit(
      app.db,
      { entity: 'shipment', entityId: existing._id.toHexString(), action: opts.action, by: opts.by, before: { status: existing.status }, after: toApi(changed) },
      { session },
    );
    return updated;
  });
}
