import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { C } from '../../db/collections.js';
import { writeAudit } from '../../lib/audit.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { mapLimit } from '../../lib/pool.js';
import { withTransaction } from '../../lib/tx.js';
import type { EventDoc } from '../execution/events.service.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import type { PodField } from '../pod-templates/pod-templates.schemas.js';
import type { PodTemplateDoc } from '../pod-templates/pod-templates.service.js';
import { DEFAULT_POD_FIELDS } from '../pods/pod-validation.js';
import { type PodDoc, podHashOf } from '../pods/pods.service.js';
import { doIdsOf, releaseDos, transition } from '../shipments/shipment.service.js';
import type { ShipmentDoc } from '../shipments/shipment.types.js';
import { type SummaryPdfData, buildSummaryPdf } from './pdf.js';

/** A POD file as it was when the trip was locked; Task 9 re-hashes the stored object and flags a mismatch. */
export interface SummaryPodFile {
  fieldKey: string;
  key: string;
  sha256: string;
}

export interface TripSummaryDoc {
  _id: ObjectId;
  shipmentId: ObjectId;
  shipmentNo: string;
  lockedAt: Date;
  lockedBy: string;
  evidence: {
    pods: { doId: ObjectId; doNo: string; podId: ObjectId; hash: string; outcome: string; reasonCode: string | null; files: SummaryPodFile[] }[];
    eventCount: number;
    flags: string[];
    distances: {
      legs: { fromStopId: ObjectId; toStopId: ObjectId; loaded: boolean; mapKm: number | null; gpsKm: number | null }[];
      clientKmByDo: { doNo: string; clientKm: number | null }[];
    };
  };
  lines: never[];
  adjustments: never[];
  pdfKey: string | null;
}

/**
 * COMPLETED → CLOSED, locking the evidence into a trip summary (spec §5.1). The checks run on a
 * plain read: that is safe because a verified POD is final (review only moves `submitted` PODs)
 * and every new POD or driver event bumps the shipment version, which `transition` guards. The
 * one gap a shipment-version guard can't close — another write landing on a *DO* document between
 * that read and the commit (a manual job-group assignment, say) — is covered separately: `inTx`
 * re-touches every DO it depends on inside the transaction, so MongoDB's write-conflict detection
 * aborts (and retries) whichever side loses the race.
 */
export async function closeShipment(
  app: FastifyInstance,
  shipment: ShipmentDoc,
  version: number,
  by: string,
): Promise<{ shipment: ShipmentDoc; summary: TripSummaryDoc }> {
  // Fail fast before assembling evidence; `transition` re-checks status and version atomically.
  if (shipment.status !== 'COMPLETED') throw unprocessable('SHIPMENT_NOT_COMPLETED', `Cannot close a ${shipment.status} shipment`);
  const dos = (await app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).find({ _id: { $in: doIdsOf(shipment.stops) } }).toArray()).sort((a, b) =>
    a.doNo < b.doNo ? -1 : a.doNo > b.doNo ? 1 : 0,
  );
  const latest = new Map<string, PodDoc>();
  for (const p of await app.db.collection<PodDoc>(C.pods).find({ shipmentId: shipment._id }).sort({ _id: 1 }).toArray()) latest.set(p.doId.toHexString(), p);
  const unverified = dos.filter((d) => latest.get(d._id.toHexString())?.status !== 'verified').map((d) => d.doNo);
  if (unverified.length > 0) throw unprocessable('PODS_NOT_VERIFIED', 'Verify every POD before closing', { doNos: unverified });
  const noGroup = dos.filter((d) => !d.jobGroupId && !d.legacy).map((d) => d.doNo);
  if (noGroup.length > 0) throw unprocessable('JOB_GROUP_REQUIRED', 'Assign a job group to every delivery order before closing', { doNos: noGroup });

  const events = await app.db.collection<EventDoc>(C.events).find({ shipmentId: shipment._id }, { projection: { flags: 1 } }).toArray();
  const flags = new Set<string>();
  for (const e of events) for (const fl of e.flags) flags.add(fl);
  for (const d of dos) for (const fl of latest.get(d._id.toHexString())!.flags) flags.add(fl);
  const now = new Date();
  const summary: TripSummaryDoc = {
    _id: new ObjectId(),
    shipmentId: shipment._id,
    shipmentNo: shipment.shipmentNo,
    lockedAt: now,
    lockedBy: by,
    evidence: {
      pods: dos.map((d) => {
        const p = latest.get(d._id.toHexString())!;
        return {
          doId: d._id,
          doNo: d.doNo,
          podId: p._id,
          hash: p.hash,
          outcome: p.outcome,
          reasonCode: p.reasonCode,
          files: p.files.map((x) => ({ fieldKey: x.fieldKey, key: x.key, sha256: x.sha256 })),
        };
      }),
      eventCount: events.length,
      flags: [...flags].sort(),
      distances: {
        legs: shipment.legs.map((l) => ({ fromStopId: l.fromStopId, toStopId: l.toStopId, loaded: l.loaded, mapKm: l.mapKm, gpsKm: l.gpsKm })),
        clientKmByDo: dos.map((d) => ({ doNo: d.doNo, clientKm: d.distance.clientKm })),
      },
    },
    lines: [],
    adjustments: [],
    pdfKey: null,
  };
  const updated = await transition(app, shipment, {
    version,
    from: ['COMPLETED'],
    set: { status: 'CLOSED', closedAt: now, closedBy: by, summaryId: summary._id },
    action: 'close',
    by,
    notAllowedCode: 'SHIPMENT_NOT_COMPLETED',
    inTx: async (session) => {
      // Re-touch every DO this close depends on (already known to be POD_VERIFIED or FAILED from
      // the plain read above) so a concurrent write to any of them — another verify/reject, a
      // manual job-group assignment, a release — conflicts with this transaction at commit time
      // instead of silently racing past the checks already done outside it.
      const doIds = dos.map((d) => d._id);
      const guard = await app.db
        .collection<DeliveryOrderDoc>(C.deliveryOrders)
        .updateMany({ _id: { $in: doIds }, status: { $in: ['POD_VERIFIED', 'FAILED'] } }, { $set: { updatedAt: now } }, { session });
      if (guard.matchedCount !== doIds.length) {
        throw unprocessable('PODS_NOT_VERIFIED', 'A delivery order changed while closing; reload and try again', { doNos: dos.map((d) => d.doNo) });
      }
      await app.db.collection<TripSummaryDoc>(C.tripSummaries).insertOne(summary, { session });
      const releasedDoNos = dos.filter((d) => d.status === 'FAILED').map((d) => d.doNo).sort();
      // Failed DOs go back to the pool through the same job-group re-match as any release (P3-R6); attempts[] is kept.
      await releaseDos(app.db, shipment._id, session, { status: 'FAILED' });
      return { releasedDoNos };
    },
  });
  // The PDF is built after the close commits: a PDF failure must never undo a close; it is logged
  // and can be rebuilt with POST /shipments/:id/summary.pdf/regenerate.
  try {
    summary.pdfKey = await generateSummaryPdf(app, summary._id, by);
  } catch (err) {
    app.log.error({ err, shipmentNo: shipment.shipmentNo }, 'summary PDF generation failed');
  }
  return { shipment: updated, summary };
}

const MAX_PHOTOS_PER_DO = 2;
/** Storage calls in flight at once while re-hashing a summary's POD files (P3 ruling). */
const FILE_IO_CONCURRENCY = 4;

/** Printable `label: value` lines for the non-file answers, in template order. */
function answerLines(fields: PodField[], answers: Record<string, unknown>): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = [];
  for (const f of fields) {
    const v = answers[f.key];
    if (v === undefined || v === null || v === '') continue;
    if (f.type === 'text' || f.type === 'select') lines.push({ label: f.label, value: String(v) });
    else if (f.type === 'number') lines.push({ label: f.label, value: f.unit ? `${String(v)} ${f.unit}` : String(v) });
    else if (f.type === 'checkbox') lines.push({ label: f.label, value: v === true ? 'ใช่' : 'ไม่ใช่' });
    else if (f.type === 'qtyLines' || f.type === 'palletLines') lines.push({ label: f.label, value: `${Array.isArray(v) ? v.length : 0} รายการ` });
  }
  return lines;
}

type FileFailureReason = 'missing' | 'mismatch' | 'too_large';
type FileCheck = { ok: true; buf: Buffer } | { ok: false; reason: FileFailureReason };

const FILE_MARKERS: Record<FileFailureReason, string> = {
  missing: 'ไฟล์หายไปจากระบบจัดเก็บ',
  mismatch: 'ไฟล์ไม่ตรงกับลายนิ้วมือที่บันทึกไว้ตอนปิดงาน (อาจถูกแก้ไขภายหลัง)',
  too_large: 'ไฟล์มีขนาดใหญ่ผิดปกติ ข้ามการตรวจสอบ',
};

/**
 * Re-hashes a POD file straight from storage against the fingerprint the trip summary locked in,
 * streamed and capped at `maxBytes`, never inside a Mongo transaction. A presigned upload window is
 * only 5 minutes, but the object behind a key can still be replaced after that — this catches it
 * instead of trusting the summary's stored hash blindly. Never throws: the caller turns a miss into
 * a printed marker line so one bad file never keeps the whole evidence PDF from being generated.
 */
async function verifyStoredFile(app: FastifyInstance, file: SummaryPodFile, maxBytes: number): Promise<FileCheck> {
  const stream = await app.storage.getStream(file.key);
  if (!stream) return { ok: false, reason: 'missing' };
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buf: Buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
      bytes += buf.length;
      if (bytes > maxBytes) return { ok: false, reason: 'too_large' };
      hash.update(buf);
      chunks.push(buf);
    }
  } finally {
    if (!stream.destroyed) stream.destroy();
  }
  if (hash.digest('hex') !== file.sha256) return { ok: false, reason: 'mismatch' };
  return { ok: true, buf: Buffer.concat(chunks) };
}

const POD_MARKER_LABEL = 'คำเตือน';
const POD_MARKERS = {
  missing: 'ไม่พบข้อมูล POD ที่บันทึกไว้ตอนปิดงาน',
  hash: 'ข้อมูล POD ถูกแก้ไขหลังปิดงาน (hash ไม่ตรง)',
  files: 'รายการไฟล์ POD ถูกแก้ไขหลังปิดงาน (ไม่ตรงกับที่บันทึกไว้ตอนปิดงาน)',
} as const;

const fileFingerprint = (files: readonly SummaryPodFile[]): string =>
  JSON.stringify(files.map((x) => [x.key, x.sha256, x.fieldKey]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)));

/**
 * Re-verifies a stored POD against what the trip summary locked in: `podHashOf` recomputed over
 * the POD as it is now vs the snapshot hash, and its file list (key, sha256, fieldKey) vs the
 * snapshot's. Never throws: a mismatch becomes a printed marker so the PDF is still produced.
 */
function podIntegrityMarkers(ep: TripSummaryDoc['evidence']['pods'][number], p: PodDoc | undefined): { label: string; value: string }[] {
  if (!p) return [{ label: POD_MARKER_LABEL, value: POD_MARKERS.missing }];
  const markers: { label: string; value: string }[] = [];
  let hash: string | null = null;
  try {
    hash = podHashOf(p);
  } catch {
    // A POD document edited into a shape the hash can't even be computed over is itself a mismatch.
  }
  if (hash !== ep.hash) markers.push({ label: POD_MARKER_LABEL, value: POD_MARKERS.hash });
  if (fileFingerprint(p.files ?? []) !== fileFingerprint(ep.files)) markers.push({ label: POD_MARKER_LABEL, value: POD_MARKERS.files });
  return markers;
}

export async function generateSummaryPdf(app: FastifyInstance, summaryId: ObjectId, by: string): Promise<string> {
  const data = await summaryPdfData(app, summaryId);
  const pdf = await buildSummaryPdf(data);
  const key = `summaries/${data.shipmentNo}.pdf`;
  await app.storage.put(key, pdf, 'application/pdf');
  // The pdfKey write and its audit entry are one staff mutation: either both land or neither does,
  // so a crash between them can never leave a pdfKey with no audit trail (or vice versa).
  await withTransaction(app.mongo, async (session) => {
    await app.db.collection<TripSummaryDoc>(C.tripSummaries).updateOne({ _id: summaryId }, { $set: { pdfKey: key } }, { session });
    await writeAudit(app.db, { entity: 'tripSummary', entityId: summaryId.toHexString(), action: 'pdf', by, after: { pdfKey: key } }, { session });
  });
  return key;
}

/**
 * Everything the evidence PDF prints for a trip summary, read and re-verified (POD hashes and
 * file lists, stored file bytes) but not rendered. Exported so tests can assert on the content.
 */
export async function summaryPdfData(app: FastifyInstance, summaryId: ObjectId): Promise<SummaryPdfData> {
  const summary = await app.db.collection<TripSummaryDoc>(C.tripSummaries).findOne({ _id: summaryId });
  if (!summary) throw notFound('Trip summary');
  const shipment = (await app.db.collection<ShipmentDoc>(C.shipments).findOne({ _id: summary.shipmentId }))!;
  const vehicleIds = [shipment.head?.vehicleId, shipment.tail?.vehicleId].filter((v): v is ObjectId => !!v);
  const driverIds = [shipment.head?.driverId, shipment.tail?.driverId].filter((v): v is ObjectId => !!v);
  const [vehicles, drivers, locations, events, dos, pods] = await Promise.all([
    app.db.collection(C.vehicles).find({ _id: { $in: vehicleIds } }).toArray(),
    app.db.collection(C.drivers).find({ _id: { $in: driverIds } }).toArray(),
    app.db.collection(C.locations).find({ _id: { $in: shipment.stops.map((s) => s.locationId) } }).toArray(),
    app.db.collection<EventDoc>(C.events).find({ shipmentId: shipment._id }).sort({ deviceTime: 1, receivedAt: 1, _id: 1 }).toArray(),
    app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).find({ _id: { $in: summary.evidence.pods.map((p) => p.doId) } }).toArray(),
    app.db.collection<PodDoc>(C.pods).find({ _id: { $in: summary.evidence.pods.map((p) => p.podId) } }).toArray(),
  ]);
  const [clients, materials, templates] = await Promise.all([
    app.db.collection(C.clients).find({ _id: { $in: dos.map((d) => d.clientId) } }).toArray(),
    app.db.collection(C.materials).find({ _id: { $in: dos.map((d) => d.materialId) } }).toArray(),
    app.db.collection<PodTemplateDoc>(C.podTemplates).find({ _id: { $in: pods.map((p) => p.templateId).filter((id): id is ObjectId => !!id) } }).toArray(),
  ]);
  const name = <T extends { _id: ObjectId }>(list: T[], id: ObjectId, field: keyof T) => String(list.find((x) => x._id.equals(id))?.[field] ?? '');
  const fieldsOf = (p: PodDoc | undefined): PodField[] =>
    (p?.templateId ? templates.find((t) => t._id.equals(p.templateId!))?.fields : undefined) ?? DEFAULT_POD_FIELDS;
  const stopName = (stopId: ObjectId): string => {
    const stop = shipment.stops.find((s) => s.stopId.equals(stopId));
    return stop ? name(locations, stop.locationId, 'name') : '';
  };
  const clientKmByDo = new Map(summary.evidence.distances.clientKmByDo.map((c) => [c.doNo, c.clientKm]));

  // Every photo/signature file this PDF might embed, across every DO, re-hashed at
  // FILE_IO_CONCURRENCY total (not per DO) so a shipment with many DOs never fans out storage
  // reads beyond that cap — all of this after `closeShipment`'s transaction has already committed.
  const perDo = summary.evidence.pods.map((ep) => {
    const p = pods.find((x) => x._id.equals(ep.podId));
    const fields = fieldsOf(p);
    const typeOf = new Map(fields.map((f) => [f.key, f.type]));
    const photos = ep.files.filter((file) => typeOf.get(file.fieldKey) === 'photo').slice(0, MAX_PHOTOS_PER_DO);
    const signatures = ep.files.filter((file) => typeOf.get(file.fieldKey) === 'signature');
    return { ep, p, fields, files: [...photos, ...signatures] };
  });
  const allFiles = perDo.flatMap((x) => x.files);
  const checks = await mapLimit(allFiles, FILE_IO_CONCURRENCY, (file) => verifyStoredFile(app, file, app.config.UPLOAD_MAX_BYTES));
  const checkByKey = new Map(allFiles.map((file, i) => [file.key, checks[i]!]));

  return {
    shipmentNo: shipment.shipmentNo,
    plannedStart: shipment.plannedStart,
    closedAt: summary.lockedAt,
    closedBy: summary.lockedBy,
    vehicles: vehicleIds.map((id) => name(vehicles, id, 'plate')),
    drivers: driverIds.map((id) => name(drivers, id, 'name')),
    stops: shipment.stops.map((s) => ({
      seq: s.seq,
      location: name(locations, s.locationId, 'name'),
      events: events.filter((e) => e.stopId?.equals(s.stopId)).map((e) => ({ code: e.code, at: e.deviceTime })),
    })),
    distances: summary.evidence.distances.legs.map((l) => ({
      fromStop: stopName(l.fromStopId),
      toStop: stopName(l.toStopId),
      loaded: l.loaded,
      mapKm: l.mapKm,
      gpsKm: l.gpsKm,
    })),
    dos: perDo.map(({ ep, p, fields, files }) => {
      const d = dos.find((x) => x._id.equals(ep.doId))!;
      const images: Buffer[] = [];
      const markers: { label: string; value: string }[] = [];
      for (const file of files) {
        const check = checkByKey.get(file.key)!;
        if (check.ok) images.push(check.buf);
        else markers.push({ label: `ไฟล์ (${file.fieldKey})`, value: FILE_MARKERS[check.reason] });
      }
      return {
        doNo: ep.doNo, client: name(clients, d.clientId, 'name'), material: name(materials, d.materialId, 'name'), qty: d.qty, unit: d.unit,
        outcome: ep.outcome, reasonCode: ep.reasonCode,
        answers: [...podIntegrityMarkers(ep, p), ...(p ? answerLines(fields, p.answers) : []), ...markers],
        hash: ep.hash, images,
        clientKm: clientKmByDo.get(ep.doNo) ?? null,
      };
    }),
    flags: summary.evidence.flags,
  };
}
