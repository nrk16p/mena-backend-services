import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf, writeAudit } from '../../lib/audit.js';
import { nextNumber } from '../../lib/counters.js';
import { AppError, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { IdParams, objectIdString } from '../../lib/ids.js';
import { IssueSchema, type Issue } from '../../lib/issues.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import { withTransaction } from '../../lib/tx.js';
import type { ShipmentDoc } from '../shipments/shipment.types.js';
import { DO_STATUSES, type DeliveryOrderDoc } from './order.types.js';
import { DoFields, DoItem, DoWithWarnings, PatchDoBody } from './orders.schemas.js';
import { prepareDoFields, updateDoIfUnchanged } from './orders.service.js';

/** The two job-group warning codes `jobGroupWarnings` can put on a shipment (see orders.service.ts). */
const JOB_GROUP_WARNING_CODES = ['JOB_GROUP_NONE', 'JOB_GROUP_AMBIGUOUS'];

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
    await withTransaction(app.mongo, async (session) => {
      await coll().insertOne(doc, { session });
      await writeAudit(app.db, { entity: 'deliveryOrder', entityId: doc._id.toHexString(), action: 'create', by, after: toApi(doc) }, { session });
    });
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

  const BulkResult = z.object({
    index: z.number(),
    ok: z.boolean(),
    id: z.string().nullable(),
    doNo: z.string().nullable(),
    warnings: z.array(IssueSchema),
    errors: z.array(IssueSchema),
  });
  const BulkReport = z.object({
    dryRun: z.boolean(),
    total: z.number(),
    valid: z.number(),
    invalid: z.number(),
    results: z.array(BulkResult),
  });

  app.post(
    '/delivery-orders/bulk',
    {
      schema: {
        tags: ['delivery-orders'],
        querystring: z.object({ dryRun: z.enum(['true', 'false']).default('true') }),
        body: z.object({ items: z.array(DoFields).min(1).max(500) }),
        response: { 200: BulkReport },
      },
      preHandler: write,
    },
    async (req) => {
      const dryRun = req.query.dryRun === 'true';
      const prepared: { set: Partial<DeliveryOrderDoc>; warnings: Issue[] }[] = [];
      const results: z.infer<typeof BulkResult>[] = [];
      for (const [index, input] of req.body.items.entries()) {
        try {
          const p = await prepareDoFields(app.db, input, null);
          prepared.push(p);
          results.push({ index, ok: true, id: null, doNo: null, warnings: p.warnings, errors: [] });
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          results.push({ index, ok: false, id: null, doNo: null, warnings: [], errors: [{ code: e.code, message: e.message, details: e.details }] });
        }
      }
      const invalid = results.filter((r) => !r.ok).length;
      const report = { dryRun, total: results.length, valid: results.length - invalid, invalid, results };
      if (dryRun) return report;
      if (invalid > 0) throw unprocessable('BULK_HAS_ERRORS', `${invalid} item(s) have errors; nothing was saved`, report);

      const by = actorOf(req);
      const now = new Date();
      const docs: DeliveryOrderDoc[] = [];
      for (const p of prepared) {
        docs.push({
          ...p.set,
          _id: new ObjectId(),
          doNo: await nextNumber(app.db, 'DO'),
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
        } as DeliveryOrderDoc);
      }
      await withTransaction(
        app.mongo,
        async (session) => {
          // `insertMany` calls `bulkWrite` internally, which resolves its options twice and
          // rejects with "An operation cannot be given a timeoutMS setting when inside a
          // withTransaction call that has a timeoutMS setting" once the client has a `timeoutMS`
          // (our MONGO_TIMEOUT_MS guardrail) and the write runs inside a convenient
          // `session.withTransaction()` — see the longer note in imports.service.ts. Insert one
          // at a time instead; still one atomic transaction, same rollback semantics.
          for (const doc of docs) await coll().insertOne(doc, { session });
          await writeAudit(
            app.db,
            { entity: 'deliveryOrder', entityId: 'bulk', action: 'bulk-create', by, after: { doNos: docs.map((d) => d.doNo) } },
            { session },
          );
        },
        // The whole batch (up to 500 DOs) shares this budget instead of the tighter per-request
        // MONGO_TIMEOUT_MS (spec §13.2).
        { timeoutMS: app.config.MONGO_BATCH_TIMEOUT_MS },
      );
      docs.forEach((d, i) => {
        results[i]!.id = d._id.toHexString();
        results[i]!.doNo = d.doNo;
      });
      return report;
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
      const updated = await withTransaction(app.mongo, async (session) => {
        const u = await updateDoIfUnchanged(app.db, existing, { ...set, updatedBy: by, updatedAt: new Date() }, session);
        if (!u) throw conflict('DO_CHANGED', 'The delivery order changed; reload and try again');
        await writeAudit(app.db, { entity: 'deliveryOrder', entityId: req.params.id, action: 'update', by, before: toApi(existing), after: toApi(u) }, { session });
        return u;
      });
      return { ...toApi(updated), warnings };
    },
  );

  app.post(
    '/delivery-orders/:id/job-group',
    {
      schema: {
        tags: ['delivery-orders'],
        description:
          'Manually assigns a job group to a delivery order, at any status except CANCELLED. Unlike PATCH ' +
          '(which only accepts a DO in UNASSIGNED or PLANNED), this is the only way to give a job group to a ' +
          'DO that already moved past PLANNED — the usual way a DO ends up blocking close with JOB_GROUP_REQUIRED.',
        params: IdParams,
        body: z.object({ jobGroupId: objectIdString }),
        response: { 200: DoItem },
      },
      preHandler: write,
    },
    async (req) => {
      const existing = await load(req.params.id);
      if (existing.status === 'CANCELLED') throw unprocessable('DO_NOT_EDITABLE', 'A CANCELLED delivery order cannot be edited');
      const jobGroupId = new ObjectId(req.body.jobGroupId);
      const group = await app.db.collection(C.jobGroups).findOne({ _id: jobGroupId, clientId: existing.clientId, active: true });
      if (!group) throw unprocessable('INVALID_REFERENCE', 'jobGroupId must be an active job group of the same client');
      const by = actorOf(req);
      const now = new Date();
      const updated = await withTransaction(app.mongo, async (session) => {
        if (existing.shipmentId) {
          const shipment = await app.db
            .collection<ShipmentDoc>(C.shipments)
            .findOne({ _id: existing.shipmentId }, { session, projection: { status: 1 } });
          if (shipment?.status === 'CLOSED') {
            throw unprocessable('DO_LOCKED_BY_SHIPMENT', 'The delivery order is on a closed shipment; its job group can no longer change');
          }
        }
        const upd = await coll().findOneAndUpdate(
          { _id: existing._id, status: existing.status, shipmentId: existing.shipmentId },
          { $set: { jobGroupId, jobGroupMatch: { status: 'manual', candidates: [jobGroupId] }, updatedBy: by, updatedAt: now } },
          { returnDocument: 'after', session },
        );
        if (!upd) throw conflict('DO_CHANGED', 'The delivery order changed; reload and try again');
        if (existing.shipmentId) {
          // The DO now has a group, so drop its own JOB_GROUP_NONE/AMBIGUOUS warnings from the
          // shipment (spec fix: this is a targeted field edit, not a planning re-validation, so
          // it does not bump the shipment's version).
          await app.db.collection<ShipmentDoc>(C.shipments).updateOne(
            { _id: existing.shipmentId },
            { $pull: { warnings: { code: { $in: JOB_GROUP_WARNING_CODES }, details: { doNo: existing.doNo } } } },
            { session },
          );
        }
        await writeAudit(
          app.db,
          { entity: 'deliveryOrder', entityId: existing._id.toHexString(), action: 'job-group', by, before: toApi(existing), after: toApi(upd) },
          { session },
        );
        return upd;
      });
      return toApi(updated);
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
      const updated = await withTransaction(app.mongo, async (session) => {
        const u = await coll().findOneAndUpdate(
          { _id: existing._id, status: 'UNASSIGNED', shipmentId: null },
          { $set: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: req.body.reason, updatedBy: by, updatedAt: new Date() } },
          { returnDocument: 'after', session },
        );
        if (!u) throw unprocessable('DO_NOT_CANCELLABLE', 'The delivery order changed; reload and try again');
        await writeAudit(app.db, { entity: 'deliveryOrder', entityId: req.params.id, action: 'cancel', by, before: toApi(existing), after: toApi(u) }, { session });
        return u;
      });
      return toApi(updated);
    },
  );
};
