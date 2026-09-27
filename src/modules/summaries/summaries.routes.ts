import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { IdParams } from '../../lib/ids.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import { ShipmentItem } from '../shipments/shipment.schemas.js';
import { shipmentView } from '../shipments/shipment.service.js';
import type { ShipmentDoc } from '../shipments/shipment.types.js';
import { type TripSummaryDoc, closeShipment } from './close.service.js';

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
        hash: z.string(),
        outcome: z.string(),
        reasonCode: z.string().nullable(),
        files: z.array(z.object({ fieldKey: z.string(), key: z.string(), sha256: z.string() })),
      }),
    ),
    eventCount: z.number(),
    flags: z.array(z.string()),
    distances: z.object({
      legs: z.array(z.object({ fromStopId: z.string(), toStopId: z.string(), loaded: z.boolean(), mapKm: z.number().nullable(), gpsKm: z.number().nullable() })),
      clientKmByDo: z.array(z.object({ doNo: z.string(), clientKm: z.number().nullable() })),
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
      schema: { tags: ['shipments'], params: IdParams, body: z.object({ version: z.number().int().positive() }), response: { 200: ShipmentItem } },
      preHandler: app.requireRoles('admin', 'planner'), // close: admin or planner (P3-R1)
    },
    async (req) => shipmentView((await closeShipment(app, await loadShipment(req.params.id), req.body.version, actorOf(req))).shipment),
  );

  app.get(
    '/shipments/:id/summary',
    { schema: { tags: ['shipments'], params: IdParams, response: { 200: TripSummaryItem } }, preHandler: app.requireRoles(...STAFF_ROLES) },
    async (req) => {
      const s = await app.db.collection<TripSummaryDoc>(C.tripSummaries).findOne({ shipmentId: new ObjectId(req.params.id) });
      if (!s) throw notFound('Trip summary');
      return toApi(s);
    },
  );
};
