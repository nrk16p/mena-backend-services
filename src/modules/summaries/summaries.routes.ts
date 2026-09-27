import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf } from '../../lib/audit.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { IdParams } from '../../lib/ids.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import { ShipmentItem } from '../shipments/shipment.schemas.js';
import { shipmentView } from '../shipments/shipment.service.js';
import type { ShipmentDoc } from '../shipments/shipment.types.js';
import { type TripSummaryDoc, closeShipment, generateSummaryPdf } from './close.service.js';

const TripSummaryItem = z.object({
  id: z.string(),
  shipmentId: z.string(),
  shipmentNo: z.string(),
  lockedAt: z.string(),
  lockedBy: z.string(),
  evidence: z.object({
    pods: z.array(
      z.object({
        doId: z.string(),
        doNo: z.string(),
        podId: z.string(),
        hash: z.string().describe('The POD\'s tamper-evidence hash as it was at close time; re-checked whenever the PDF is (re)generated to detect any later edit.'),
        outcome: z.string(),
        reasonCode: z.string().nullable(),
        files: z.array(z.object({ fieldKey: z.string(), key: z.string(), sha256: z.string() })).describe('The POD\'s files as they were at close time; re-verified against storage on each PDF (re)generation.'),
      }),
    ),
    eventCount: z.number().describe('Total driver events recorded on this shipment.'),
    flags: z.array(z.string()).describe('Every distinct GPS/timing quality flag seen across this shipment\'s events and PODs (NO_GPS, LOW_ACCURACY, OUTSIDE_GEOFENCE, LATE_SYNC).'),
    distances: z.object({
      legs: z.array(z.object({ fromStopId: z.string(), toStopId: z.string(), loaded: z.boolean(), mapKm: z.number().nullable().describe('Planned map distance for this leg, if known.'), gpsKm: z.number().nullable().describe('Actual GPS-tracked distance for this leg, if known.') })),
      clientKmByDo: z.array(z.object({ doNo: z.string(), clientKm: z.number().nullable().describe('Distance the client bills for this delivery order.') })),
    }),
  }),
  lines: z.array(z.unknown()),
  adjustments: z.array(z.unknown()),
  pdfKey: z.string().nullable(),
});

export const summaryRoutes: FastifyPluginAsyncZod = async (app) => {
  const loadShipment = async (id: string) => {
    const s = await app.db.collection<ShipmentDoc>(C.shipments).findOne({ _id: new ObjectId(id) });
    if (!s) throw notFound('Shipment');
    return s;
  };

  app.post(
    '/shipments/:id/close',
    {
      schema: {
        tags: ['shipments'],
        summary: 'Close a completed shipment and lock its trip summary (ใบสรุปเที่ยว)',
        description:
          'COMPLETED → CLOSED. Callable by admin or planner. Requires every delivery order\'s latest POD to be `verified` (422 `PODS_NOT_VERIFIED`) ' +
          'and every non-legacy DO to have a job group (422 `JOB_GROUP_REQUIRED`). Locks the trip\'s evidence (POD hashes, event count, distances) ' +
          'into a trip summary, releases any FAILED delivery orders back to the unassigned pool, and generates the summary PDF (best-effort — a PDF ' +
          'failure does not undo the close; regenerate with POST /shipments/:id/summary.pdf/regenerate). Send the `version` you last saw; ' +
          '409 `VERSION_CONFLICT` if it is stale. Closing is final: a closed shipment cannot be edited or reopened.',
        params: IdParams,
        body: z.object({ version: z.number().int().positive().describe('The version you last saw for this shipment; a stale value returns 409 VERSION_CONFLICT.') }),
        response: { 200: ShipmentItem },
      },
      preHandler: app.requireRoles('admin', 'planner'), // close: admin or planner (P3-R1)
    },
    async (req) => shipmentView((await closeShipment(app, await loadShipment(req.params.id), req.body.version, actorOf(req))).shipment),
  );

  app.get(
    '/shipments/:id/summary',
    {
      schema: {
        tags: ['shipments'],
        summary: 'Get a shipment\'s trip summary (ใบสรุปเที่ยว)',
        description:
          'Callable by admin, planner or viewer. Returns the evidence locked in at close (POD hashes/outcomes, event count, GPS/timing flags, ' +
          'planned-vs-GPS distances per leg, client-billed km per DO). Returns 404 both when the shipment does not exist and when it exists but ' +
          'has not been closed yet (no trip summary).',
        params: IdParams,
        response: { 200: TripSummaryItem },
      },
      preHandler: app.requireRoles(...STAFF_ROLES),
    },
    async (req) => {
      const s = await app.db.collection<TripSummaryDoc>(C.tripSummaries).findOne({ shipmentId: new ObjectId(req.params.id) });
      if (!s) throw notFound('Trip summary');
      return toApi(s);
    },
  );

  app.get(
    '/shipments/:id/summary.pdf',
    {
      schema: {
        tags: ['shipments'],
        summary: 'Download the trip summary PDF',
        description:
          'Callable by admin, planner or viewer. Streams the evidence PDF generated at close (`inline`, so browsers preview it). ' +
          '404 `Trip summary` if the shipment has not been closed; 422 `PDF_NOT_READY` if the PDF has not been generated yet or its file is ' +
          'missing from storage — regenerate with POST /shipments/:id/summary.pdf/regenerate.',
        params: IdParams,
      },
      preHandler: app.requireRoles(...STAFF_ROLES),
    },
    async (req, reply) => {
      const s = await app.db.collection<TripSummaryDoc>(C.tripSummaries).findOne({ shipmentId: new ObjectId(req.params.id) });
      if (!s) throw notFound('Trip summary');
      if (!s.pdfKey) throw unprocessable('PDF_NOT_READY', 'The PDF is not generated yet');
      // Buffers the whole PDF into memory before sending (accepted for now: evidence PDFs are small,
      // a handful of downscaled photos per DO); revisit with a streamed storage read if that changes.
      const obj = await app.storage.get(s.pdfKey);
      if (!obj) throw unprocessable('PDF_NOT_READY', 'The PDF file is missing; regenerate it');
      return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${s.shipmentNo}.pdf"`).send(obj.body);
    },
  );

  app.post(
    '/shipments/:id/summary.pdf/regenerate',
    {
      schema: {
        tags: ['shipments'],
        summary: 'Regenerate the trip summary PDF',
        description:
          'Callable by admin or planner. Rebuilds the evidence PDF from the trip summary\'s locked-in data, re-verifying each POD\'s hash and stored ' +
          'files against what was recorded at close (a mismatch is printed as a warning marker in the PDF, not an error here). 404 `Trip summary` ' +
          'if the shipment has not been closed.',
        params: IdParams,
        response: { 200: z.object({ pdfKey: z.string() }) },
      },
      preHandler: app.requireRoles('admin', 'planner'),
    },
    async (req) => {
      const s = await app.db.collection<TripSummaryDoc>(C.tripSummaries).findOne({ shipmentId: new ObjectId(req.params.id) });
      if (!s) throw notFound('Trip summary');
      return { pdfKey: await generateSummaryPdf(app, s._id, actorOf(req)) };
    },
  );
};
