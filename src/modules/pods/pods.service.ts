import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { canonicalJson, sha256Hex } from '../../lib/canonical.js';
import { AppError, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { gpsFlags } from '../../lib/geo.js';
import { GpsFields } from '../../lib/gps.js';
import { objectIdString } from '../../lib/ids.js';
import { mapLimit } from '../../lib/pool.js';
import { POD_ACTIVE_STATUSES, deriveDoStatus, deriveShipmentStatus } from '../../lib/status.js';
import { withTransaction } from '../../lib/tx.js';
import { REASON_CODES } from '../execution/event-rules.js';
import { doneStepsAt, geofenceTarget } from '../execution/stop-context.js';
import type { DeliveryOrderDoc, DoStatus } from '../orders/order.types.js';
import { loadDriverShipment } from '../shipments/driver-access.js';
import { doIdsOf } from '../shipments/shipment.service.js';
import type { ShipmentDoc } from '../shipments/shipment.types.js';
import { UPLOAD_TYPES, type UploadType, sha256OfStream } from '../storage/storage.js';
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

/** Storage calls in flight at once while checking a POD's files. */
const FILE_IO_CONCURRENCY = 4;

const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** The file name part of a presigned key: `{uuid}.{ext}` (uploads.routes.ts), nothing else — no sub-paths or `..`. */
const UPLOAD_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.([a-z]+)$/;

export type PodHashInput = Pick<PodDoc, 'doId' | 'templateId' | 'templateVersion' | 'outcome' | 'reasonCode' | 'note' | 'answers' | 'files' | 'evidence'>;

/**
 * Tamper-evidence hash, spec §6.3 as amended by P3-R16: SHA-256 of the canonical JSON of
 * `{ doId, templateId, templateVersion, outcome, reasonCode, note, answers,
 *    files: [{ key, sha256, fieldKey }] in key order,
 *    evidence: { deviceTime, receivedAt, lat, lng, accuracyM, noGpsReason, geofenceDistanceM, device, appVersion, offline } }`,
 * ids as lowercase hex, dates as ISO-8601 UTC strings, absent optional values as null. Every hashed
 * field is named here (no spreads), so a field added to the stored document later never changes
 * the hash, and `podHashOf(storedDoc)` re-verifies a stored POD.
 */
export function podHashOf(p: PodHashInput): string {
  const e = p.evidence;
  return sha256Hex(
    canonicalJson({
      doId: p.doId.toHexString(),
      templateId: p.templateId?.toHexString() ?? null,
      templateVersion: p.templateVersion,
      outcome: p.outcome,
      reasonCode: p.reasonCode ?? null,
      note: p.note ?? null,
      answers: p.answers,
      files: [...p.files].sort(byKey).map((f) => ({ key: f.key, sha256: f.sha256, fieldKey: f.fieldKey })),
      evidence: {
        deviceTime: e.deviceTime.toISOString(),
        receivedAt: e.receivedAt.toISOString(),
        lat: e.lat ?? null,
        lng: e.lng ?? null,
        accuracyM: e.accuracyM ?? null,
        noGpsReason: e.noGpsReason ?? null,
        geofenceDistanceM: e.geofenceDistanceM ?? null,
        device: e.device ?? null,
        appVersion: e.appVersion ?? null,
        offline: e.offline,
      },
    }),
  );
}

type FileInput = PodInputT['files'][number];
const fileError = (code: string, file: FileInput, message: string) => unprocessable(code, message, { key: file.key, fieldKey: file.fieldKey });

/**
 * Storage checks for a POD's files (P3-R3, P3-R15), all before the transaction so network I/O never
 * eats into its time budget, at most FILE_IO_CONCURRENCY calls at a time. First a HEAD of every file
 * (FILE_MISSING, FILE_TOO_LARGE — a presigned PUT cannot enforce a size limit), so nothing is
 * downloaded while any file is missing or oversized; then each file is streamed through SHA-256,
 * capped at `maxBytes` in case it was replaced after its HEAD (FILE_HASH_MISMATCH when the bytes or
 * the declared size differ). Errors are reported for the first failing file in request order.
 */
async function verifyStoredFiles(app: FastifyInstance, files: FileInput[], maxBytes: number): Promise<void> {
  const heads = await mapLimit(files, FILE_IO_CONCURRENCY, (file) => app.storage.head(file.key));
  files.forEach((file, i) => {
    const head = heads[i];
    if (!head) throw fileError('FILE_MISSING', file, `${file.key} was not uploaded`);
    if (head.bytes > maxBytes) throw fileError('FILE_TOO_LARGE', file, `${file.key} is larger than ${maxBytes} bytes`);
  });
  const digests = await mapLimit(files, FILE_IO_CONCURRENCY, async (file) => {
    const stream = await app.storage.getStream(file.key);
    return stream ? { found: true as const, digest: await sha256OfStream(stream, maxBytes) } : { found: false as const, digest: null };
  });
  files.forEach((file, i) => {
    const { found, digest } = digests[i]!;
    if (!found) throw fileError('FILE_MISSING', file, `${file.key} was not uploaded`);
    if (!digest) throw fileError('FILE_TOO_LARGE', file, `${file.key} is larger than ${maxBytes} bytes`);
    if (digest.bytes !== file.bytes || digest.sha256 !== file.sha256) {
      throw fileError('FILE_HASH_MISMATCH', file, `${file.key} does not match its fingerprint`);
    }
  });
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
        throw fileError('FILE_KEY_INVALID', file, `${file.key} does not belong to this delivery order`);
      }
      if (seen.has(file.key)) throw fileError('FILE_KEY_INVALID', file, `${file.key} is listed more than once`);
      seen.add(file.key);
    }
    for (const file of input.files) {
      const ext = UPLOAD_NAME.exec(file.key.slice(prefix.length))![1];
      if (!(file.mime in UPLOAD_TYPES) || UPLOAD_TYPES[file.mime as UploadType] !== ext) {
        throw fileError('FILE_TYPE_INVALID', file, `${file.mime} is not an allowed image type for ${file.key}`);
      }
    }

    const form = await podFormFor(app.db, d);
    const formIssues = validatePodAnswers(form.fields, input.answers, input.files, input.outcome);
    if (formIssues.length > 0) throw unprocessable('POD_INVALID', 'The POD form is incomplete or invalid', { issues: formIssues });

    await verifyStoredFiles(app, input.files, app.config.UPLOAD_MAX_BYTES);

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
      hash: '', // set below from the finished document
      flags,
      status: 'submitted',
      review: null,
      supersedesPodId: previous?.status === 'rejected' ? previous._id : null,
      by,
    };
    pod.hash = podHashOf(pod);

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
      // The status was checked before the file reads; the shipment may have been closed or cancelled since.
      if (!POD_ACTIVE_STATUSES.includes(current.status)) throw unprocessable('SHIPMENT_NOT_ACTIVE', `Cannot submit a POD on a ${current.status} shipment`);
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
