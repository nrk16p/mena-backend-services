import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf, writeAudit } from '../../lib/audit.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { IdParams, objectIdString } from '../../lib/ids.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import { deriveDoStatus } from '../../lib/status.js';
import { withTransaction } from '../../lib/tx.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import { driverIdOf } from '../shipments/driver-access.js';
import type { ShipmentDoc } from '../shipments/shipment.types.js';
import { type PodDoc, PodInput, submitPod } from './pods.service.js';

/** API shape of `PodDoc` (ids as hex, dates as ISO strings). */
export const PodItem = z.object({
  id: z.string(),
  clientPodId: z.string(),
  doId: z.string(),
  shipmentId: z.string(),
  stopId: z.string(),
  templateId: z.string().nullable(),
  templateVersion: z.number(),
  outcome: z.enum(['DELIVERED', 'FAILED']),
  reasonCode: z.string().nullable(),
  note: z.string().nullable(),
  answers: z.record(z.unknown()),
  files: z
    .array(z.object({ fieldKey: z.string(), key: z.string(), sha256: z.string().describe('SHA-256 hex digest of the uploaded file, re-verified server-side against the stored object bytes.'), mime: z.string(), bytes: z.number() }))
    .describe('Photos/signatures already uploaded via POST /uploads/presign + PUT; every key must have been verified to exist with a matching sha256 before this POD can be submitted.'),
  evidence: z.object({
    deviceTime: z.string(),
    receivedAt: z.string(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    accuracyM: z.number().nullable(),
    noGpsReason: z.string().nullable(),
    geofenceDistanceM: z.number().nullable(),
    device: z.string().nullable(),
    appVersion: z.string().nullable(),
    offline: z.boolean().describe('Whether this POD was captured while the phone was offline and submitted later.'),
  }),
  hash: z.string().describe('SHA-256 tamper-evidence hash over the POD\'s contents and evidence, computed at submission and re-checked whenever the trip summary or its PDF is (re)built.'),
  flags: z.array(z.string()).describe('GPS/timing quality flags (NO_GPS, LOW_ACCURACY, OUTSIDE_GEOFENCE, LATE_SYNC) — informational, never block submission.'),
  status: z.enum(['submitted', 'verified', 'rejected']).describe('submitted (awaiting review) → verified or rejected by an admin/planner via /pods/:id/verify or /reject. A rejected POD can be resubmitted by the driver.'),
  review: z.object({ by: z.string(), at: z.string(), reason: z.string().nullable() }).nullable().describe('Who reviewed this POD and when; reason is set on rejection, null on verification.'),
  supersedesPodId: z.string().nullable().describe('The rejected POD this one replaces, when the driver resubmitted after a rejection; null otherwise.'),
  by: z.string(),
  // Batched-lookup extras (P3-R12): present on /pods list & detail, absent from the driver submit response.
  doNo: z.string().optional(),
  shipmentNo: z.string().optional(),
  driverName: z.string().optional(),
});

export const podRoutes: FastifyPluginAsyncZod = async (app) => {
  const staff = app.requireRoles(...STAFF_ROLES);
  const reviewer = app.requireRoles('admin', 'planner'); // POD review: admin or planner (P3-R1)
  const pods = () => app.db.collection<PodDoc>(C.pods);
  const load = async (id: string) => {
    const p = await pods().findOne({ _id: new ObjectId(id) });
    if (!p) throw notFound('POD');
    return p;
  };

  // 201 for a new POD; 200 with the stored POD when this clientPodId was already used (offline replay).
  app.post(
    '/driver/pods',
    {
      schema: {
        tags: ['driver'],
        summary: 'Submit a proof of delivery (POD)',
        description:
          'Driver-only. Last step of the POD flow: presign an upload (POST /uploads/presign) → PUT the file with the returned headers → compute its ' +
          'sha256 → submit it here referencing that file key. Requires `UNLOAD_END` already recorded at the drop stop for `outcome: "DELIVERED"`, or ' +
          '`ARRIVED` for `outcome: "FAILED"` (422 `STEP_REQUIRED` otherwise); `outcome: "FAILED"` needs a `reasonCode` (422 `REASON_REQUIRED`), and ' +
          '`reasonCode: "OTHER"` needs a `note` (422 `NOTE_REQUIRED`). Answers are checked against the client/job-group\'s POD form (422 `POD_INVALID`), ' +
          'and every file is verified to exist in storage with a matching sha256 (`FILE_MISSING`/`FILE_TOO_LARGE`/`FILE_HASH_MISMATCH`). ' +
          '`clientPodId` is a UUID generated on the phone: replaying it returns 200 with the original POD instead of creating a duplicate (a fresh ' +
          'submission is 201). Submitting after a rejection is allowed and supersedes the rejected POD.',
        body: PodInput,
        response: { 200: PodItem, 201: PodItem },
      },
      preHandler: app.requireRoles('driver'),
    },
    async (req, reply) => {
      const { pod, duplicate } = await submitPod(app, actorOf(req), driverIdOf(req), req.body);
      return reply.status(duplicate ? 200 : 201).send(toApi(pod));
    },
  );

  /**
   * P3-R12: one batched lookup ($in on DOs, shipments, drivers — no N+1) resolving doNo, shipmentNo
   * and driverName for a page (or single-item detail) of PODs. Returned as optional PodItem fields.
   */
  // Returns `any` (like `toApi`) so the route's zod response schema is the real contract, not this helper's inferred type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function enrich(docs: PodDoc[]): Promise<(p: PodDoc) => any> {
    const doIds = [...new Set(docs.map((p) => p.doId.toHexString()))].map((s) => new ObjectId(s));
    const shipmentIds = [...new Set(docs.map((p) => p.shipmentId.toHexString()))].map((s) => new ObjectId(s));
    const [dos, shipments] = await Promise.all([
      app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).find({ _id: { $in: doIds } }, { projection: { doNo: 1 } }).toArray(),
      app.db.collection<ShipmentDoc>(C.shipments).find({ _id: { $in: shipmentIds } }, { projection: { shipmentNo: 1, head: 1, tail: 1 } }).toArray(),
    ]);
    const doNoById = new Map(dos.map((d) => [d._id.toHexString(), d.doNo]));
    const shipmentById = new Map(shipments.map((s) => [s._id.toHexString(), s]));
    const driverIds = [...new Set(shipments.map((s) => (s.head?.driverId ?? s.tail?.driverId)?.toHexString()).filter((x): x is string => !!x))].map(
      (s) => new ObjectId(s),
    );
    const drivers = driverIds.length
      ? await app.db.collection(C.drivers).find({ _id: { $in: driverIds } }, { projection: { name: 1 } }).toArray()
      : [];
    const driverNameById = new Map(drivers.map((d) => [d._id.toHexString(), d.name as string]));
    return (p: PodDoc) => {
      const sh = shipmentById.get(p.shipmentId.toHexString());
      const driverId = sh?.head?.driverId ?? sh?.tail?.driverId ?? null;
      return {
        ...toApi(p),
        doNo: doNoById.get(p.doId.toHexString()),
        shipmentNo: sh?.shipmentNo,
        driverName: driverId ? driverNameById.get(driverId.toHexString()) : undefined,
      };
    };
  }

  app.get(
    '/pods',
    {
      schema: {
        tags: ['pods'],
        summary: 'List submitted PODs',
        description:
          'Lists proofs of delivery (POD), cursor-paginated, with `doNo`/`shipmentNo`/`driverName` resolved for display. Callable by admin, ' +
          'planner or viewer. Filter by `status`, `shipmentId`, `doId`, or `flagged=true` for PODs with a GPS/timing quality flag needing a closer look.',
        querystring: PageQuery.extend({
          status: z.enum(['submitted', 'verified', 'rejected']).optional(),
          shipmentId: objectIdString.optional(),
          doId: objectIdString.optional(),
          flagged: z.enum(['true', 'false']).optional().describe('"true" restricts to PODs that have at least one GPS/timing quality flag.'),
        }),
        response: { 200: pageResponse(PodItem) },
      },
      preHandler: staff,
    },
    async (req) => {
      const q = req.query;
      const filter: Filter<PodDoc> = {};
      if (q.status) filter.status = q.status;
      if (q.shipmentId) filter.shipmentId = new ObjectId(q.shipmentId);
      if (q.doId) filter.doId = new ObjectId(q.doId);
      if (q.flagged === 'true') filter['flags.0'] = { $exists: true };
      const page = await paginate(pods(), filter, q);
      const toItem = await enrich(page.items);
      return { items: page.items.map(toItem), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/pods/:id',
    {
      schema: {
        tags: ['pods'],
        summary: 'Get a POD by id, with viewable file links',
        description: 'Callable by admin, planner or viewer. `fileUrls` are short-lived (5 minute) presigned GET links for each uploaded file. 404 if the id does not exist.',
        params: IdParams,
        response: { 200: PodItem.extend({ fileUrls: z.array(z.object({ key: z.string(), url: z.string() })) }) },
      },
      preHandler: staff,
    },
    async (req) => {
      const p = await load(req.params.id);
      const fileUrls = [];
      for (const file of p.files) fileUrls.push({ key: file.key, url: await app.storage.presignGet(file.key, 300) });
      const toItem = await enrich([p]);
      return { ...toItem(p), fileUrls };
    },
  );

  async function review(id: string, by: string, decision: 'verified' | 'rejected', reason: string | null) {
    const p = await load(id);
    if (p.status !== 'submitted') throw unprocessable('POD_ALREADY_REVIEWED', `This POD is already ${p.status}`);
    // Defensive: Task 5 supersedes only rejected PODs, so a submitted POD is always its DO's latest today.
    const latest = await pods().find({ doId: p.doId }).sort({ _id: -1 }).limit(1).next();
    if (!latest?._id.equals(p._id)) throw unprocessable('POD_SUPERSEDED', 'A newer POD exists for this delivery order');
    return withTransaction(app.mongo, async (session) => {
      const updated = await pods().findOneAndUpdate(
        { _id: p._id, status: 'submitted' },
        { $set: { status: decision, review: { by, at: new Date(), reason } } },
        { returnDocument: 'after', session },
      );
      if (!updated) throw unprocessable('POD_ALREADY_REVIEWED', 'This POD was reviewed meanwhile');
      const orders = app.db.collection<DeliveryOrderDoc>(C.deliveryOrders);
      const d = (await orders.findOne({ _id: p.doId }, { session }))!;
      const next = deriveDoStatus(d.status, { loaded: true, latestPod: { outcome: p.outcome, status: decision } });
      if (next !== d.status) {
        // No matchedCount check needed (P3-R17): `d.status` was read inside this same session/transaction,
        // so it is part of this transaction's snapshot. If some other write had changed the DO's status
        // between that read and this update, MongoDB detects the write conflict at commit time and aborts
        // (and the driver retries) this whole transaction — the retry re-reads `d` and recomputes `next`
        // against the current status. So whenever this update actually commits, its filter is guaranteed
        // to still match; a mismatch can't silently no-op here the way it could outside a transaction.
        await orders.updateOne({ _id: d._id, status: d.status }, { $set: { status: next, updatedAt: new Date(), updatedBy: by } }, { session });
      }
      await writeAudit(app.db, { entity: 'pod', entityId: id, action: decision === 'verified' ? 'verify' : 'reject', by, after: { reason } }, { session });
      return updated;
    });
  }

  app.post(
    '/pods/:id/verify',
    {
      schema: {
        tags: ['pods'],
        summary: 'Verify a submitted POD',
        description:
          'submitted → verified. Callable by admin or planner. 422 `POD_ALREADY_REVIEWED` if the POD is not currently `submitted`, ' +
          '422 `POD_SUPERSEDED` if a newer POD exists for the same delivery order. A verified POD counts toward the shipment being ' +
          '`COMPLETED` and is required before the shipment can be closed.',
        params: IdParams,
        response: { 200: PodItem },
      },
      preHandler: reviewer,
    },
    async (req) => toApi(await review(req.params.id, actorOf(req), 'verified', null)),
  );

  app.post(
    '/pods/:id/reject',
    {
      schema: {
        tags: ['pods'],
        summary: 'Reject a submitted POD',
        description:
          'submitted → rejected. Callable by admin or planner. The delivery order moves to `POD_REJECTED`, letting the driver resubmit a POD for it. ' +
          '422 `POD_ALREADY_REVIEWED` if the POD is not currently `submitted`, 422 `POD_SUPERSEDED` if a newer POD exists for the same delivery order.',
        params: IdParams,
        body: z.object({ reason: z.string().trim().min(3).max(500).describe('Why this POD is being rejected; shown to the driver.') }),
        response: { 200: PodItem },
      },
      preHandler: reviewer,
    },
    async (req) => toApi(await review(req.params.id, actorOf(req), 'rejected', req.body.reason)),
  );
};
