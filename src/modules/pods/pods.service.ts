import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { canonicalJson, sha256Hex } from '../../lib/canonical.js';
import { AppError, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { gpsFlags } from '../../lib/geo.js';
import { GpsFields } from '../../lib/gps.js';
import { objectIdString } from '../../lib/ids.js';
import { deriveDoStatus, deriveShipmentStatus } from '../../lib/status.js';
import { withTransaction } from '../../lib/tx.js';
import { REASON_CODES } from '../execution/event-rules.js';
import { doneStepsAt, geofenceTarget } from '../execution/stop-context.js';
import type { DeliveryOrderDoc, DoStatus } from '../orders/order.types.js';
import { loadDriverShipment } from '../shipments/driver-access.js';
import { doIdsOf } from '../shipments/shipment.service.js';
import type { ShipmentDoc, ShipmentStatus } from '../shipments/shipment.types.js';
import { UPLOAD_TYPES, type UploadType } from '../storage/storage.js';
import { podFormFor } from './pod-form.js';
import { type PodFileRef, validatePodAnswers } from './pod-validation.js';

export const PodInput = z
  .object({
    clientPodId: z.string().uuid(),
    doId: objectIdString,
    outcome: z.enum(['DELIVERED', 'FAILED']),
    reasonCode: z.enum(REASON_CODES).nullable().default(null),
    note: z.string().trim().max(500).nullable().default(null),
    answers: z.record(z.unknown()).default({}),
    files: z
      .array(z.object({ fieldKey: z.string(), key: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/), mime: z.string(), bytes: z.number().int().min(0) }))
      .max(30)
      .default([]),
    device: z.string().max(100).nullable().default(null),
    appVersion: z.string().max(30).nullable().default(null),
    offline: z.boolean().default(false),
  })
  .and(GpsFields);
export type PodInputT = z.infer<typeof PodInput>;

export interface PodDoc {
  _id: ObjectId;
  clientPodId: string;
  doId: ObjectId;
  shipmentId: ObjectId;
  stopId: ObjectId;
  templateId: ObjectId | null;
  templateVersion: number;
  outcome: 'DELIVERED' | 'FAILED';
  reasonCode: string | null;
  note: string | null;
  answers: Record<string, unknown>;
  files: PodFileRef[];
  evidence: {
    deviceTime: Date;
    receivedAt: Date;
    lat: number | null;
    lng: number | null;
    accuracyM: number | null;
    noGpsReason: string | null;
    geofenceDistanceM: number | null;
    device: string | null;
    appVersion: string | null;
    offline: boolean;
  };
  hash: string;
  flags: string[];
  status: 'submitted' | 'verified' | 'rejected';
  review: { by: string; at: Date; reason: string | null } | null;
  supersedesPodId: ObjectId | null;
  by: string;
}

/** A POD is taken once the trip has started; COMPLETED still takes a resubmission after a rejection. */
export const POD_ACTIVE_STATUSES: ShipmentStatus[] = ['IN_TRANSIT', 'COMPLETED'];

const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** The file name part of a presigned key: `{uuid}.{ext}` (uploads.routes.ts), nothing else — no sub-paths or `..`. */
const UPLOAD_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.([a-z]+)$/;

/**
 * Tamper-evidence hash, spec §6.3 (P3-R7): SHA-256 of the canonical JSON of
 * `{ doId, templateId, templateVersion, answers, files: [sha256 in key order], evidence }`, with ids
 * as lowercase hex and dates as ISO strings. `outcome`/`reasonCode` are not part of the hash.
 */
export function podHashOf(p: Pick<PodDoc, 'doId' | 'templateId' | 'templateVersion' | 'answers' | 'files' | 'evidence'>): string {
  return sha256Hex(
    canonicalJson({
      doId: p.doId.toHexString(),
      templateId: p.templateId?.toHexString() ?? null,
      templateVersion: p.templateVersion,
      answers: p.answers,
      files: [...p.files].sort(byKey).map((f) => f.sha256),
      evidence: { ...p.evidence, deviceTime: p.evidence.deviceTime.toISOString(), receivedAt: p.evidence.receivedAt.toISOString() },
    }),
  );
}

export async function submitPod(app: FastifyInstance, by: string, driverId: ObjectId, input: PodInputT): Promise<{ pod: PodDoc; duplicate: boolean }> {
  const pods = app.db.collection<PodDoc>(C.pods);
  const orders = app.db.collection<DeliveryOrderDoc>(C.deliveryOrders);
  const shipments = app.db.collection<ShipmentDoc>(C.shipments);

  /** A replay returns the stored POD, but only to a driver of its shipment (anyone else gets 404). */
  const findDuplicate = async (): Promise<PodDoc | null> => {
    const dup = await pods.findOne({ clientPodId: input.clientPodId });
    if (dup) await loadDriverShipment(app.db, dup.shipmentId, driverId);
    return dup;
  };
  const dup = await findDuplicate();
  if (dup) return { pod: dup, duplicate: true };

  try {
    const d = await orders.findOne({ _id: new ObjectId(input.doId) });
    if (!d || !d.shipmentId) throw notFound('Delivery order');
    const shipment = await loadDriverShipment(app.db, d.shipmentId, driverId);
    const stop = shipment.stops.find((s) => s.dropDoIds.some((id) => id.equals(d._id)));
    if (!stop) throw notFound('Delivery order');
    if (!POD_ACTIVE_STATUSES.includes(shipment.status)) throw unprocessable('SHIPMENT_NOT_ACTIVE', `Cannot submit a POD on a ${shipment.status} shipment`);

    const allowed: DoStatus[] = input.outcome === 'DELIVERED' ? ['PICKED_UP', 'POD_REJECTED'] : ['PLANNED', 'PICKED_UP', 'POD_REJECTED'];
    if (!allowed.includes(d.status)) throw unprocessable('DO_NOT_READY', `A ${d.status} delivery order cannot take a ${input.outcome} POD`);
    const done = await doneStepsAt(app.db, shipment._id, stop.stopId);
    const needed = input.outcome === 'DELIVERED' ? 'UNLOAD_END' : 'ARRIVED';
    if (!done.has(needed)) throw unprocessable('STEP_REQUIRED', `Record ${needed} at the drop stop first`);
    if (input.outcome === 'FAILED' && !input.reasonCode) throw unprocessable('REASON_REQUIRED', 'Choose why the delivery failed');
    if (input.reasonCode === 'OTHER' && !input.note) throw unprocessable('NOTE_REQUIRED', 'Describe the reason');

    // Cheap reference checks first, so a foreign key or a non-image type is reported as such rather
    // than hidden behind a form problem; storage reads (existence, size, hash) come after the form check.
    const prefix = `pods/${shipment._id.toHexString()}/${d._id.toHexString()}/`;
    const seen = new Set<string>();
    for (const file of input.files) {
      if (!file.key.startsWith(prefix) || !UPLOAD_NAME.test(file.key.slice(prefix.length))) {
        throw unprocessable('FILE_KEY_INVALID', `${file.key} does not belong to this delivery order`);
      }
      if (seen.has(file.key)) throw unprocessable('FILE_KEY_INVALID', `${file.key} is listed more than once`);
      seen.add(file.key);
    }
    for (const file of input.files) {
      const ext = UPLOAD_NAME.exec(file.key.slice(prefix.length))![1];
      if (!(file.mime in UPLOAD_TYPES) || UPLOAD_TYPES[file.mime as UploadType] !== ext) {
        throw unprocessable('FILE_TYPE_INVALID', `${file.mime} is not an allowed image type for ${file.key}`);
      }
    }

    const form = await podFormFor(app.db, d);
    const formIssues = validatePodAnswers(form.fields, input.answers, input.files, input.outcome);
    if (formIssues.length > 0) throw unprocessable('POD_INVALID', 'The POD form is incomplete or invalid', { issues: formIssues });

    // Storage reads happen here, before the transaction, so network I/O never eats into its time budget.
    // A presigned PUT cannot enforce a size limit, so the size is checked on the stored bytes (P3-R3).
    for (const file of input.files) {
      const stored = await app.storage.get(file.key);
      if (!stored) throw unprocessable('FILE_MISSING', `${file.key} was not uploaded`);
      if (stored.body.length > app.config.UPLOAD_MAX_BYTES) {
        throw unprocessable('FILE_TOO_LARGE', `${file.key} is larger than ${app.config.UPLOAD_MAX_BYTES} bytes`);
      }
      if (stored.body.length !== file.bytes || sha256Hex(stored.body) !== file.sha256) {
        throw unprocessable('FILE_HASH_MISMATCH', `${file.key} does not match its fingerprint`);
      }
    }

    const receivedAt = new Date();
    const deviceTime = new Date(input.deviceTime);
    const { flags, distanceM } = gpsFlags({
      lat: input.lat, lng: input.lng, accuracyM: input.accuracyM, deviceTime, receivedAt,
      target: await geofenceTarget(app.db, stop.locationId),
    });
    const evidence: PodDoc['evidence'] = {
      deviceTime, receivedAt, lat: input.lat, lng: input.lng, accuracyM: input.accuracyM, noGpsReason: input.noGpsReason,
      geofenceDistanceM: distanceM, device: input.device, appVersion: input.appVersion, offline: input.offline,
    };
    const previous = await pods.find({ doId: d._id }).sort({ _id: -1 }).limit(1).next();
    const files = input.files.map((x) => ({ fieldKey: x.fieldKey, key: x.key, sha256: x.sha256, mime: x.mime, bytes: x.bytes })).sort(byKey);
    const hashed = { doId: d._id, templateId: form.templateId, templateVersion: form.version, answers: input.answers, files, evidence };
    const pod: PodDoc = {
      _id: new ObjectId(),
      clientPodId: input.clientPodId,
      doId: d._id,
      shipmentId: shipment._id,
      stopId: stop.stopId,
      templateId: form.templateId,
      templateVersion: form.version,
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      note: input.note,
      answers: input.answers,
      files,
      evidence,
      hash: podHashOf(hashed),
      flags,
      status: 'submitted',
      review: null,
      supersedesPodId: previous?.status === 'rejected' ? previous._id : null,
      by,
    };

    await withTransaction(app.mongo, async (session) => {
      await pods.insertOne(pod, { session });
      const nextStatus = deriveDoStatus(d.status, { loaded: d.status !== 'PLANNED', latestPod: { outcome: input.outcome, status: 'submitted' } });
      const update: Record<string, unknown> = { $set: { status: nextStatus, updatedAt: receivedAt, updatedBy: by } };
      if (input.outcome === 'FAILED') {
        update.$push = { attempts: { shipmentId: shipment._id, reasonCode: input.reasonCode!, podId: pod._id, at: receivedAt } };
      }
      // The DO status was read outside the transaction: a concurrent POD for the same DO loses here.
      const res = await orders.updateOne({ _id: d._id, status: d.status }, update, { session });
      if (res.matchedCount === 0) throw unprocessable('DO_NOT_READY', 'The delivery order changed; reload');
      // Re-read the shipment and its DOs inside the transaction and always bump the shipment version:
      // two PODs finishing the last DOs together then conflict on the shipment document, MongoDB
      // retries the loser, and the retry sees both DOs done (no missed completion by write skew).
      const current = await shipments.findOne({ _id: shipment._id }, { session });
      if (!current) throw notFound('Shipment');
      const all = await orders.find({ _id: { $in: doIdsOf(current.stops) } }, { session, projection: { status: 1 } }).toArray();
      const status = deriveShipmentStatus(current.status, { driverEvents: 1, doStatuses: all.map((x) => x.status) });
      const upd = await shipments.updateOne(
        { _id: current._id, version: current.version },
        { $set: { status, updatedAt: receivedAt, updatedBy: by }, $inc: { version: 1 } },
        { session },
      );
      if (upd.matchedCount === 0) throw conflict('SHIPMENT_CHANGED', 'The shipment changed while this POD was being recorded; send it again');
    });
    return { pod, duplicate: false };
  } catch (e) {
    // A concurrent copy of this POD (same clientPodId) may have committed after the lookup above: this
    // attempt then fails the unique index or the DO status guard, but the POD is stored — a replay.
    if ((e as { code?: unknown }).code === 11000 || e instanceof AppError) {
      const again = await findDuplicate();
      if (again) return { pod: again, duplicate: true };
    }
    throw e;
  }
}
