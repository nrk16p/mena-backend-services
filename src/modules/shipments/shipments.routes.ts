import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { IdParams, objectIdString } from '../../lib/ids.js';
import { IssueSchema } from '../../lib/issues.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import { DoItem } from '../orders/orders.schemas.js';
import { ShipmentInput, ShipmentItem, ValidateBody, ValidateResponse } from './shipment.schemas.js';
import { createShipment, doIdsOf, shipmentView } from './shipment.service.js';
import { SHIPMENT_STATUSES, type ShipmentDoc } from './shipment.types.js';
import { toDraft, validateShipment } from './shipment.validation.js';

export const ShipmentWithWarnings = ShipmentItem.extend({ warnings: z.array(IssueSchema) });

export const shipmentRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = app.requireRoles(...STAFF_ROLES);
  const write = app.requireRoles('admin', 'planner');
  const coll = () => app.db.collection<ShipmentDoc>(C.shipments);

  app.post('/shipments/validate', { schema: { tags: ['shipments'], body: ValidateBody, response: { 200: ValidateResponse } }, preHandler: write }, async (req) => {
    const { shipmentId, mode, ...input } = req.body;
    const draft = await toDraft(app.db, input);
    const result = await validateShipment(app.db, draft, { shipmentId: shipmentId ? new ObjectId(shipmentId) : undefined, mode });
    return {
      errors: result.errors,
      warnings: result.warnings,
      stops: draft.stops.map((s) => ({ ...s, plannedArrival: s.plannedArrival?.toISOString() ?? null })),
      legs: result.legs,
    };
  });

  app.post('/shipments', { schema: { tags: ['shipments'], body: ShipmentInput, response: { 201: ShipmentWithWarnings } }, preHandler: write }, async (req, reply) => {
    const { doc } = await createShipment(app, req.body, actorOf(req));
    return reply.status(201).send(shipmentView(doc));
  });

  app.get(
    '/shipments',
    {
      schema: {
        tags: ['shipments'],
        querystring: PageQuery.extend({
          status: z.enum(SHIPMENT_STATUSES).optional(),
          from: z.string().datetime({ offset: true }).optional(),
          to: z.string().datetime({ offset: true }).optional(),
          vehicleId: objectIdString.optional(),
          driverId: objectIdString.optional(),
          truckTypeId: objectIdString.optional(),
        }),
        response: { 200: pageResponse(ShipmentItem) },
      },
      preHandler: read,
    },
    async (req) => {
      const q = req.query;
      const and: Filter<ShipmentDoc>[] = [];
      if (q.status) and.push({ status: q.status });
      if (q.to) and.push({ plannedStart: { $lt: new Date(q.to) } });
      if (q.from) and.push({ plannedEnd: { $gt: new Date(q.from) } });
      if (q.vehicleId) {
        const v = new ObjectId(q.vehicleId);
        and.push({ $or: [{ 'head.vehicleId': v }, { 'tail.vehicleId': v }] });
      }
      if (q.driverId) {
        const d = new ObjectId(q.driverId);
        and.push({ $or: [{ 'head.driverId': d }, { 'tail.driverId': d }] });
      }
      if (q.truckTypeId) {
        const ids = await app.db.collection(C.vehicles).find({ truckTypeId: new ObjectId(q.truckTypeId) }, { projection: { _id: 1 } }).toArray();
        and.push({ 'head.vehicleId': { $in: ids.map((v) => v._id) } });
      }
      const page = await paginate(coll(), and.length > 0 ? { $and: and } : {}, q);
      return { items: page.items.map(shipmentView), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/shipments/:id',
    { schema: { tags: ['shipments'], params: IdParams, response: { 200: ShipmentItem.extend({ deliveryOrders: z.array(DoItem) }) } }, preHandler: read },
    async (req) => {
      const doc = await coll().findOne({ _id: new ObjectId(req.params.id) });
      if (!doc) throw notFound('Shipment');
      const dos = await app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).find({ _id: { $in: doIdsOf(doc.stops) } }).toArray();
      return { ...shipmentView(doc), deliveryOrders: dos.map(toApi) };
    },
  );
};
