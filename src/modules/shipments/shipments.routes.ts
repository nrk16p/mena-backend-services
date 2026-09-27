import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf } from '../../lib/audit.js';
import { AppError, notFound, unprocessable } from '../../lib/errors.js';
import { IdParams, objectIdString } from '../../lib/ids.js';
import { IssueSchema, type Issue } from '../../lib/issues.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import { DoItem } from '../orders/orders.schemas.js';
import { ShipmentInput, ShipmentItem, ValidateBody, ValidateResponse } from './shipment.schemas.js';
import { createShipment, doIdsOf, draftFromDoc, invalid, shipmentView, transition, updateShipment } from './shipment.service.js';
import { SHIPMENT_STATUSES, type ShipmentDoc } from './shipment.types.js';
import { toDraft, validateShipment } from './shipment.validation.js';

export const ShipmentWithWarnings = ShipmentItem.extend({ warnings: z.array(IssueSchema) });

export const shipmentRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = app.requireRoles(...STAFF_ROLES);
  const write = app.requireRoles('admin', 'planner');
  const coll = () => app.db.collection<ShipmentDoc>(C.shipments);
  const load = async (id: string) => {
    const doc = await coll().findOne({ _id: new ObjectId(id) });
    if (!doc) throw notFound('Shipment');
    return doc;
  };
  const Version = z.object({ version: z.number().int().positive() });

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

  const BulkShipmentResult = z.object({
    index: z.number(),
    ok: z.boolean(),
    id: z.string().nullable(),
    shipmentNo: z.string().nullable(),
    errors: z.array(IssueSchema),
    warnings: z.array(IssueSchema),
  });

  app.post(
    '/shipments/bulk',
    { schema: { tags: ['shipments'], body: z.object({ items: z.array(ShipmentInput).min(1).max(100) }), response: { 200: z.object({ results: z.array(BulkShipmentResult) }) } }, preHandler: write },
    async (req) => {
      const by = actorOf(req);
      const results: z.infer<typeof BulkShipmentResult>[] = [];
      for (const [index, input] of req.body.items.entries()) {
        try {
          // The whole bulk request (up to 100 shipments, each its own transaction) is a batch
          // job, so each one gets the larger MONGO_BATCH_TIMEOUT_MS budget (spec §13.2), not the
          // tighter per-request MONGO_TIMEOUT_MS.
          const { doc, warnings } = await createShipment(app, input, by, { timeoutMS: app.config.MONGO_BATCH_TIMEOUT_MS });
          results.push({ index, ok: true, id: doc._id.toHexString(), shipmentNo: doc.shipmentNo, errors: [], warnings });
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          const details = e.details as { errors?: Issue[]; warnings?: Issue[] } | undefined;
          results.push({
            index, ok: false, id: null, shipmentNo: null,
            errors: details?.errors ?? [{ code: e.code, message: e.message }],
            warnings: details?.warnings ?? [],
          });
        }
      }
      return { results };
    },
  );

  app.get(
    '/shipments/:id',
    { schema: { tags: ['shipments'], params: IdParams, response: { 200: ShipmentItem.extend({ deliveryOrders: z.array(DoItem) }) } }, preHandler: read },
    async (req) => {
      const doc = await load(req.params.id);
      const dos = await app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).find({ _id: { $in: doIdsOf(doc.stops) } }).toArray();
      return { ...shipmentView(doc), deliveryOrders: dos.map(toApi) };
    },
  );

  app.patch(
    '/shipments/:id',
    { schema: { tags: ['shipments'], params: IdParams, body: ShipmentInput.partial().extend({ version: z.number().int().positive() }), response: { 200: ShipmentItem } }, preHandler: write },
    async (req) => shipmentView(await updateShipment(app, await load(req.params.id), req.body, actorOf(req))),
  );

  app.post('/shipments/:id/plan', { schema: { tags: ['shipments'], params: IdParams, body: Version, response: { 200: ShipmentItem } }, preHandler: write }, async (req) => {
    const existing = await load(req.params.id);
    const set: Partial<ShipmentDoc> = { status: 'PLANNED' };
    if (existing.status === 'DRAFT') {
      const result = await validateShipment(app.db, draftFromDoc(existing), { shipmentId: existing._id, mode: 'planned' });
      if (result.errors.length > 0) throw invalid(result.errors, result.warnings);
      set.warnings = result.warnings;
    }
    return shipmentView(
      await transition(app, existing, { version: req.body.version, from: ['DRAFT'], set, action: 'plan', by: actorOf(req), notAllowedCode: 'SHIPMENT_NOT_DRAFT' }),
    );
  });

  app.post('/shipments/:id/dispatch', { schema: { tags: ['shipments'], params: IdParams, body: Version, response: { 200: ShipmentItem } }, preHandler: write }, async (req) => {
    const existing = await load(req.params.id);
    if (existing.status !== 'PLANNED') throw unprocessable('SHIPMENT_NOT_PLANNED', `Cannot dispatch a ${existing.status} shipment`);
    const result = await validateShipment(app.db, draftFromDoc(existing), { shipmentId: existing._id, mode: 'planned' });
    if (result.errors.length > 0) throw invalid(result.errors, result.warnings);
    const by = actorOf(req);
    return shipmentView(
      await transition(app, existing, {
        version: req.body.version,
        from: ['PLANNED'],
        set: { status: 'DISPATCHED', dispatch: { at: new Date(), by, version: existing.version + 1 }, driverResponse: null, warnings: result.warnings },
        action: 'dispatch',
        by,
        notAllowedCode: 'SHIPMENT_NOT_PLANNED',
      }),
    );
  });

  app.post(
    '/shipments/:id/cancel',
    { schema: { tags: ['shipments'], params: IdParams, body: Version.extend({ reason: z.string().trim().min(3).max(500) }), response: { 200: ShipmentItem } }, preHandler: write },
    async (req) =>
      shipmentView(
        await transition(app, await load(req.params.id), {
          version: req.body.version,
          from: ['DRAFT', 'PLANNED', 'DISPATCHED', 'ACCEPTED'],
          set: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: req.body.reason },
          action: 'cancel',
          by: actorOf(req),
          notAllowedCode: 'SHIPMENT_NOT_CANCELLABLE',
          releaseDos: true,
        }),
      ),
  );
};
