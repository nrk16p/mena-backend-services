import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { C } from '../../db/collections.js';
import { unprocessable } from '../../lib/errors.js';
import type { EventDoc } from '../execution/events.service.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import type { PodDoc } from '../pods/pods.service.js';
import { doIdsOf, releaseDos, transition } from '../shipments/shipment.service.js';
import type { ShipmentDoc } from '../shipments/shipment.types.js';

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
  return { shipment: updated, summary };
}
