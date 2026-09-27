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
  geofenceDistanceM: z.number().nullable().describe('Distance from the stop location\'s geofence centre, in metres; null when the location has no geofence configured.'),
  source: z.string(), by: z.string(),
  flags: z.array(z.string()).describe('GPS/timing quality flags computed server-side (NO_GPS, LOW_ACCURACY, OUTSIDE_GEOFENCE, LATE_SYNC) — informational, never block the event.'),
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
    {
      schema: {
        tags: ['driver'],
        summary: 'Record driver trip steps (ARRIVED, DEPARTED, etc.)',
        description:
          'Driver-only. Records up to 100 step events in one batch (e.g. queued while the phone was offline). Stop steps must follow the order ' +
          'ARRIVED → UNLOAD_START → UNLOAD_END (if the stop has drops) → LOAD_START → LOAD_END (if the stop has pickups) → DEPARTED, one at a time; ' +
          'DEPARTED additionally requires every dropped delivery order to already have a POD (422 `POD_REQUIRED`). Each `clientEventId` is a UUID ' +
          'generated on the phone: replaying the same one returns `status: "duplicate"` with the original result instead of creating a second event, ' +
          'so retries after a dropped response are safe. Per-item `status` is `"accepted"`, `"duplicate"`, or `"rejected"` (with `code`/`message`, ' +
          'e.g. `EVENT_OUT_OF_ORDER`, `PREVIOUS_STOP_OPEN`, `STOP_NOT_FOUND`, `SHIPMENT_NOT_ACTIVE`) — the batch call itself always returns 200.',
        body: z.object({ events: z.array(EventInput).min(1).max(100) }),
        response: { 200: z.object({ results: z.array(EventResultSchema) }) },
      },
      preHandler: app.requireRoles('driver'),
    },
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
    {
      schema: {
        tags: ['shipments'],
        summary: 'Get a shipment\'s driver event timeline',
        description: 'Callable by admin, planner or viewer. Returns up to the most recent 1000 events, ordered by device time then receipt time. 404 if the shipment does not exist.',
        params: IdParams,
        response: { 200: Timeline },
      },
      preHandler: app.requireRoles(...STAFF_ROLES),
    },
    async (req) => {
      const id = new ObjectId(req.params.id);
      if (!(await app.db.collection(C.shipments).countDocuments({ _id: id }, { limit: 1 }))) throw notFound('Shipment');
      return timeline(id);
    },
  );

  // The phone app's own timeline (P3-R10); another driver's shipment is reported as not found.
  app.get(
    '/driver/shipments/:id/events',
    {
      schema: {
        tags: ['driver'],
        summary: 'Get the caller\'s own event timeline for a shipment',
        description:
          'Driver-only. Only for a shipment where the caller is the head or tail driver, and only while it is in a driver-visible status ' +
          '(DISPATCHED/ACCEPTED/IN_TRANSIT/COMPLETED) — any other case is reported as 404, not 403.',
        params: IdParams,
        response: { 200: Timeline },
      },
      preHandler: app.requireRoles('driver'),
    },
    async (req) => {
      const shipment = await loadDriverShipment(app.db, new ObjectId(req.params.id), driverIdOf(req));
      if (!DRIVER_VISIBLE_STATUSES.includes(shipment.status)) throw notFound('Shipment');
      return timeline(shipment._id);
    },
  );
};
