import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { AppError, conflict, unprocessable } from '../../lib/errors.js';
import { gpsFlags } from '../../lib/geo.js';
import { GpsFields } from '../../lib/gps.js';
import { objectIdString } from '../../lib/ids.js';
import type { Issue } from '../../lib/issues.js';
import { POD_DONE_STATUSES, deriveDoStatus, deriveShipmentStatus, deriveStopStatus } from '../../lib/status.js';
import { withTransaction } from '../../lib/tx.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import { podFormsFor } from '../pods/pod-form.js';
import { loadDriverShipment } from '../shipments/driver-access.js';
import type { ShipmentDoc, ShipmentStatus } from '../shipments/shipment.types.js';
import {
  EVENT_CODES, EXTRA_EVENTS, GLOBAL_EVENTS, REASON_CODES, STOP_EVENTS,
  type ExtraEventCode, type StopEventCode, checkExtraEvent, checkStopEvent,
} from './event-rules.js';
import { type GeofenceTarget, doneStepsAt, geofenceTarget } from './stop-context.js';

export const EventInput = z
  .object({
    clientEventId: z.string().uuid(),
    shipmentId: objectIdString,
    stopId: objectIdString.nullable().default(null),
    code: z.enum(EVENT_CODES),
    reasonCode: z.enum(REASON_CODES).nullable().default(null),
    note: z.string().trim().max(500).nullable().default(null),
  })
  .and(GpsFields);
export type EventInputT = z.infer<typeof EventInput>;

export interface EventDoc {
  _id: ObjectId;
  clientEventId: string;
  shipmentId: ObjectId;
  stopId: ObjectId | null;
  doId: ObjectId | null;
  code: string;
  reasonCode: string | null;
  note: string | null;
  deviceTime: Date;
  receivedAt: Date;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  noGpsReason: string | null;
  geofenceDistanceM: number | null;
  source: 'app';
  by: string;
  flags: string[];
}

export interface EventResult {
  clientEventId: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  eventId: string | null;
  flags: string[];
  code?: string;
  message?: string;
}

/** Driver events are accepted from acceptance until close; COMPLETED allows the last DEPARTED (P3-R4, spec §5.3). */
export const EVENT_ACTIVE_STATUSES: ShipmentStatus[] = ['ACCEPTED', 'IN_TRANSIT', 'COMPLETED'];

/** A stored event under this clientEventId that doesn't match the request is a reuse, not a replay (P3-R13.1). */
function clientEventIdReused(existing: EventDoc, by: string, input: EventInputT): boolean {
  return existing.by !== by || existing.shipmentId.toHexString() !== input.shipmentId || existing.code !== input.code;
}

export async function recordDriverEvent(app: FastifyInstance, by: string, driverId: ObjectId, input: EventInputT): Promise<EventResult> {
  const base = { clientEventId: input.clientEventId, flags: [] as string[] };
  const events = app.db.collection<EventDoc>(C.events);
  const orders = app.db.collection<DeliveryOrderDoc>(C.deliveryOrders);
  const existing = await events.findOne({ clientEventId: input.clientEventId });
  if (existing) {
    if (clientEventIdReused(existing, by, input)) {
      return { ...base, status: 'rejected', eventId: null, code: 'CLIENT_EVENT_ID_REUSED', message: 'This clientEventId was already used for a different event' };
    }
    return { ...base, status: 'duplicate', eventId: existing._id.toHexString(), flags: existing.flags };
  }
  try {
    const shipment = await loadDriverShipment(app.db, new ObjectId(input.shipmentId), driverId);
    if (!EVENT_ACTIVE_STATUSES.includes(shipment.status)) {
      throw unprocessable('SHIPMENT_NOT_ACTIVE', `Cannot record events on a ${shipment.status} shipment`);
    }
    if (input.code === 'EXCEPTION' && !input.reasonCode) throw unprocessable('REASON_REQUIRED', 'Choose a reason for the exception');
    if (input.reasonCode === 'OTHER' && !input.note) throw unprocessable('NOTE_REQUIRED', 'Describe the reason');

    const isGlobal = (GLOBAL_EVENTS as readonly string[]).includes(input.code);
    const stopIndex = input.stopId ? shipment.stops.findIndex((s) => s.stopId.toHexString() === input.stopId) : -1;
    if (input.stopId && stopIndex === -1) throw unprocessable('STOP_NOT_FOUND', 'This stop is not on the shipment');
    if (!isGlobal && stopIndex === -1) throw unprocessable('STOP_REQUIRED', 'Choose the stop for this step');
    const stop = stopIndex >= 0 ? shipment.stops[stopIndex]! : null;

    let target: GeofenceTarget | undefined;
    let doneAfter: Set<string> | null = null;
    if (stop) {
      target = await geofenceTarget(app.db, stop.locationId);
      const done = await doneStepsAt(app.db, shipment._id, stop.stopId);
      const related = await orders.find({ _id: { $in: [...stop.dropDoIds, ...stop.pickupDoIds] } }).toArray();
      const drops = related.filter((d) => stop.dropDoIds.some((id) => id.equals(d._id)));
      const state = {
        hasDrops: stop.dropDoIds.length > 0,
        hasPickups: stop.pickupDoIds.length > 0,
        done,
        allDropsHavePod: drops.every((d) => POD_DONE_STATUSES.includes(d.status)),
      };
      let problem: Issue | null = null;
      if ((STOP_EVENTS as readonly string[]).includes(input.code)) {
        const prev = stopIndex > 0 ? shipment.stops[stopIndex - 1]! : null;
        const prevDeparted = prev ? (await doneStepsAt(app.db, shipment._id, prev.stopId)).has('DEPARTED') : true;
        problem = checkStopEvent(state, input.code as StopEventCode, prevDeparted);
      } else if ((EXTRA_EVENTS as readonly string[]).includes(input.code)) {
        const allowed = new Set<string>();
        for (const form of (await podFormsFor(app.db, related)).values()) for (const s of form.extraSteps) allowed.add(s);
        problem = checkExtraEvent(state, input.code as ExtraEventCode, [...allowed]);
      }
      if (problem) throw unprocessable(problem.code, problem.message, problem.details);
      doneAfter = new Set([...done, input.code]);
    }

    const receivedAt = new Date();
    const deviceTime = new Date(input.deviceTime);
    const { flags, distanceM } = gpsFlags({ lat: input.lat, lng: input.lng, accuracyM: input.accuracyM, deviceTime, receivedAt, target });
    const doc: EventDoc = {
      _id: new ObjectId(),
      clientEventId: input.clientEventId,
      shipmentId: shipment._id,
      stopId: stop?.stopId ?? null,
      doId: null,
      code: input.code,
      reasonCode: input.reasonCode,
      note: input.note,
      deviceTime,
      receivedAt,
      lat: input.lat,
      lng: input.lng,
      accuracyM: input.accuracyM,
      noGpsReason: input.noGpsReason,
      geofenceDistanceM: distanceM,
      source: 'app',
      by,
      flags,
    };
    await withTransaction(app.mongo, async (session) => {
      await events.insertOne(doc, { session });
      // An event never finishes a DO, so the only system transition it can cause is ACCEPTED → IN_TRANSIT.
      const set: Record<string, unknown> = {
        status: deriveShipmentStatus(shipment.status, { driverEvents: 1, doStatuses: [] }),
        updatedAt: receivedAt,
        updatedBy: by,
      };
      if (stop && doneAfter) set[`stops.${stopIndex}.status`] = deriveStopStatus(doneAfter);
      // The step checks above read outside the transaction; the version guard makes a concurrent
      // tap (head + tail driver, or a retry under a new UUID) lose instead of storing a second step.
      const res = await app.db
        .collection<ShipmentDoc>(C.shipments)
        .updateOne({ _id: shipment._id, version: shipment.version }, { $set: set, $inc: { version: 1 } }, { session });
      if (res.matchedCount === 0) throw conflict('SHIPMENT_CHANGED', 'The shipment changed while this step was being recorded; send it again');
      if (stop && input.code === 'LOAD_END') {
        for (const d of await orders.find({ _id: { $in: stop.pickupDoIds } }, { session }).toArray()) {
          const next = deriveDoStatus(d.status, { loaded: true, latestPod: null });
          if (next !== d.status) {
            await orders.updateOne({ _id: d._id, status: d.status }, { $set: { status: next, updatedAt: receivedAt, updatedBy: by } }, { session });
          }
        }
      }
    });
    return { ...base, status: 'accepted', eventId: doc._id.toHexString(), flags };
  } catch (e) {
    const isDupKey = (e as { code?: unknown }).code === 11000;
    if (!isDupKey && !(e instanceof AppError)) throw e;
    // A concurrent copy of this event (same clientEventId) may have committed after the lookup above:
    // then this attempt fails the unique index, the step check (EVENT_ALREADY_RECORDED) or the version
    // guard (SHIPMENT_CHANGED). Either way the event is stored, so the replay is a duplicate, not a rejection.
    const dup = await events.findOne({ clientEventId: input.clientEventId });
    if (dup) {
      if (clientEventIdReused(dup, by, input)) {
        return { ...base, status: 'rejected', eventId: null, code: 'CLIENT_EVENT_ID_REUSED', message: 'This clientEventId was already used for a different event' };
      }
      return { ...base, status: 'duplicate', eventId: dup._id.toHexString(), flags: dup.flags };
    }
    if (e instanceof AppError) return { ...base, status: 'rejected', eventId: null, code: e.code, message: e.message };
    throw e;
  }
}
