import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf, writeAudit } from '../../lib/audit.js';
import { nextNumber } from '../../lib/counters.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { IdParams, objectIdString } from '../../lib/ids.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import { DO_STATUSES, type DeliveryOrderDoc } from './order.types.js';
import { DoFields, DoItem, DoWithWarnings, PatchDoBody } from './orders.schemas.js';
import { prepareDoFields, updateDoIfUnchanged } from './orders.service.js';

export const orderRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = app.requireRoles(...STAFF_ROLES);
  const write = app.requireRoles('admin', 'planner');
  const coll = () => app.db.collection<DeliveryOrderDoc>(C.deliveryOrders);
  const load = async (id: string) => {
    const d = await coll().findOne({ _id: new ObjectId(id) });
    if (!d) throw notFound('Delivery order');
    return d;
  };

  app.post('/delivery-orders', { schema: { tags: ['delivery-orders'], body: DoFields, response: { 201: DoWithWarnings } }, preHandler: write }, async (req, reply) => {
    const { set, warnings } = await prepareDoFields(app.db, req.body, null);
    const by = actorOf(req);
    const now = new Date();
    const doNo = await nextNumber(app.db, 'DO');
    const doc = {
      ...set,
      _id: new ObjectId(),
      doNo,
      status: 'UNASSIGNED',
      shipmentId: null,
      pickupStopId: null,
      dropStopId: null,
      cancelledAt: null,
      cancelReason: null,
      createdBy: by,
      createdAt: now,
      updatedBy: by,
      updatedAt: now,
    } as DeliveryOrderDoc;
    await coll().insertOne(doc);
    await writeAudit(app.db, { entity: 'deliveryOrder', entityId: doc._id.toHexString(), action: 'create', by, after: toApi(doc) });
    return reply.status(201).send({ ...toApi(doc), warnings: warnings.map((w) => ({ ...w, details: { doNo } })) });
  });

  app.get(
    '/delivery-orders',
    {
      schema: {
        tags: ['delivery-orders'],
        querystring: PageQuery.extend({
          status: z.enum(DO_STATUSES).optional(),
          clientId: objectIdString.optional(),
          jobGroupId: objectIdString.optional(),
          shipmentId: objectIdString.optional(),
          from: z.string().datetime({ offset: true }).optional(),
          to: z.string().datetime({ offset: true }).optional(),
        }),
        response: { 200: pageResponse(DoItem) },
      },
      preHandler: read,
    },
    async (req) => {
      const q = req.query;
      const f: Filter<DeliveryOrderDoc> = {};
      if (q.status) f.status = q.status;
      if (q.clientId) f.clientId = new ObjectId(q.clientId);
      if (q.jobGroupId) f.jobGroupId = new ObjectId(q.jobGroupId);
      if (q.shipmentId) f.shipmentId = new ObjectId(q.shipmentId);
      if (q.from || q.to) {
        f['pickupWindow.from'] = {
          ...(q.from ? { $gte: new Date(q.from) } : {}),
          ...(q.to ? { $lt: new Date(q.to) } : {}),
        };
      }
      const page = await paginate(coll(), f, q);
      return { items: page.items.map(toApi), nextCursor: page.nextCursor };
    },
  );

  app.get('/delivery-orders/:id', { schema: { tags: ['delivery-orders'], params: IdParams, response: { 200: DoItem } }, preHandler: read }, async (req) =>
    toApi(await load(req.params.id)),
  );

  app.patch(
    '/delivery-orders/:id',
    { schema: { tags: ['delivery-orders'], params: IdParams, body: PatchDoBody, response: { 200: DoWithWarnings } }, preHandler: write },
    async (req) => {
      const existing = await load(req.params.id);
      if (existing.status !== 'UNASSIGNED' && existing.status !== 'PLANNED') {
        throw unprocessable('DO_NOT_EDITABLE', `A ${existing.status} delivery order cannot be edited`);
      }
      const { set, warnings } = await prepareDoFields(app.db, req.body, existing);
      const by = actorOf(req);
      const updated = await updateDoIfUnchanged(app.db, existing, { ...set, updatedBy: by, updatedAt: new Date() });
      if (!updated) throw conflict('DO_CHANGED', 'The delivery order changed; reload and try again');
      await writeAudit(app.db, { entity: 'deliveryOrder', entityId: req.params.id, action: 'update', by, before: toApi(existing), after: toApi(updated) });
      return { ...toApi(updated), warnings };
    },
  );

  app.post(
    '/delivery-orders/:id/cancel',
    {
      schema: { tags: ['delivery-orders'], params: IdParams, body: z.object({ reason: z.string().trim().min(3).max(500) }), response: { 200: DoItem } },
      preHandler: write,
    },
    async (req) => {
      const existing = await load(req.params.id);
      if (existing.shipmentId) throw unprocessable('DO_IN_SHIPMENT', 'Remove the delivery order from its shipment first');
      if (existing.status !== 'UNASSIGNED') throw unprocessable('DO_NOT_CANCELLABLE', `A ${existing.status} delivery order cannot be cancelled`);
      const by = actorOf(req);
      const updated = await coll().findOneAndUpdate(
        { _id: existing._id, status: 'UNASSIGNED', shipmentId: null },
        { $set: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: req.body.reason, updatedBy: by, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      if (!updated) throw unprocessable('DO_NOT_CANCELLABLE', 'The delivery order changed; reload and try again');
      await writeAudit(app.db, { entity: 'deliveryOrder', entityId: req.params.id, action: 'cancel', by, before: toApi(existing), after: toApi(updated) });
      return toApi(updated);
    },
  );
};
