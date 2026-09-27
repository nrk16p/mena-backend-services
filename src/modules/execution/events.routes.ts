import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { IdParams } from '../../lib/ids.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import { DRIVER_VISIBLE_STATUSES } from '../../lib/status.js';
import { driverIdOf, loadDriverShipment } from '../shipments/driver-access.js';
import { type EventDoc, EventInput, recordDriverEvent } from './events.service.js';

const EventResultSchema = z.object({
  clientEventId: z.string(),
  status: z.enum(['accepted', 'duplicate', 'rejected']),
  eventId: z.string().nullable(),
  flags: z.array(z.string()),
  code: z.string().optional(),
  message: z.string().optional(),
});

const EventItem = z.object({
  id: z.string(), clientEventId: z.string(), shipmentId: z.string(), stopId: z.string().nullable(), code: z.string(),
  reasonCode: z.string().nullable(), note: z.string().nullable(), deviceTime: z.string(), receivedAt: z.string(),
  lat: z.number().nullable(), lng: z.number().nullable(), accuracyM: z.number().nullable(), noGpsReason: z.string().nullable(),
  geofenceDistanceM: z.number().nullable(), source: z.string(), by: z.string(), flags: z.array(z.string()),
});

const Timeline = z.object({ items: z.array(EventItem) });

export const eventRoutes: FastifyPluginAsyncZod = async (app) => {
  /** A shipment's events in the order they happened on the device (receipt order, then insertion, breaks ties). */
  const timeline = async (shipmentId: ObjectId) => {
    const items = await app.db
      .collection<EventDoc>(C.events)
      .find({ shipmentId })
      .sort({ deviceTime: 1, receivedAt: 1, _id: 1 })
      .limit(1000)
      .toArray();
    return { items: items.map(toApi) };
  };

  app.post(
    '/driver/events',
    { schema: { tags: ['driver'], body: z.object({ events: z.array(EventInput).min(1).max(100) }), response: { 200: z.object({ results: z.array(EventResultSchema) }) } }, preHandler: app.requireRoles('driver') },
    async (req) => {
      const driverId = driverIdOf(req);
      const by = actorOf(req);
      const results = [];
      for (const e of req.body.events) results.push(await recordDriverEvent(app, by, driverId, e));
      return { results };
    },
  );

  app.get(
    '/shipments/:id/events',
    { schema: { tags: ['shipments'], params: IdParams, response: { 200: Timeline } }, preHandler: app.requireRoles(...STAFF_ROLES) },
    async (req) => {
      const id = new ObjectId(req.params.id);
      if (!(await app.db.collection(C.shipments).countDocuments({ _id: id }, { limit: 1 }))) throw notFound('Shipment');
      return timeline(id);
    },
  );

  // The phone app's own timeline (P3-R10); another driver's shipment is reported as not found.
  app.get(
    '/driver/shipments/:id/events',
    { schema: { tags: ['driver'], params: IdParams, response: { 200: Timeline } }, preHandler: app.requireRoles('driver') },
    async (req) => {
      const shipment = await loadDriverShipment(app.db, new ObjectId(req.params.id), driverIdOf(req));
      if (!DRIVER_VISIBLE_STATUSES.includes(shipment.status)) throw notFound('Shipment');
      return timeline(shipment._id);
    },
  );
};
