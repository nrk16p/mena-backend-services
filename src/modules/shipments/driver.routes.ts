import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf } from '../../lib/audit.js';
import { IdParams } from '../../lib/ids.js';
import { toApi } from '../../lib/serialize.js';
import { DRIVER_VISIBLE_STATUSES } from '../../lib/status.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import { DoItem } from '../orders/orders.schemas.js';
import { podFormsFor } from '../pods/pod-form.js';
import { driverIdOf, driverScope, loadDriverShipment } from './driver-access.js';
import { ShipmentItem } from './shipment.schemas.js';
import { doIdsOf, shipmentView, transition } from './shipment.service.js';
import type { ShipmentDoc } from './shipment.types.js';

const LocationLite = z.object({ id: z.string(), code: z.string(), name: z.string(), lat: z.number(), lng: z.number(), geofenceRadiusM: z.number() });
const PodFormOut = z.object({
  templateId: z.string().nullable(),
  version: z.number(),
  extraSteps: z.array(z.string()),
  fields: z.array(z.object({ key: z.string(), label: z.string(), type: z.string(), required: z.boolean(), min: z.number().optional(), max: z.number().optional(), unit: z.string().optional(), options: z.array(z.string()).optional() })),
});
/** Driver-visible statuses other than COMPLETED: the jobs still to accept or drive. */
const DRIVER_ACTIVE_STATUSES = DRIVER_VISIBLE_STATUSES.filter((st) => st !== 'COMPLETED');
/** Most recent COMPLETED shipments kept in the job list besides those needing a POD resubmission. */
const RECENT_COMPLETED = 10;

const DriverShipment = ShipmentItem.extend({ deliveryOrders: z.array(DoItem.extend({ podForm: PodFormOut })), locations: z.array(LocationLite) });

export const driverRoutes: FastifyPluginAsyncZod = async (app) => {
  const driverOnly = app.requireRoles('driver');
  const coll = () => app.db.collection<ShipmentDoc>(C.shipments);

  app.get('/driver/shipments', { schema: { tags: ['driver'], response: { 200: z.object({ items: z.array(DriverShipment) }) } }, preHandler: driverOnly }, async (req) => {
    const driverId = driverIdOf(req);
    const scope = driverScope(driverId);
    // Active jobs are queried on their own so a backlog of COMPLETED-but-unclosed shipments can
    // never push today's DISPATCHED job past the limit. COMPLETED stays listed until CLOSED only
    // where the driver may still act (P3-R4): a DO with a rejected POD to resubmit, plus the most
    // recent few so a just-finished trip doesn't vanish from the phone.
    const rejectedOn = (await app.db
      .collection<DeliveryOrderDoc>(C.deliveryOrders)
      .distinct('shipmentId', { status: 'POD_REJECTED', shipmentId: { $ne: null } })) as ObjectId[];
    const [active, rejected, recent] = await Promise.all([
      coll().find({ status: { $in: DRIVER_ACTIVE_STATUSES }, ...scope }).sort({ plannedStart: 1 }).limit(50).toArray(),
      rejectedOn.length > 0
        ? coll().find({ _id: { $in: rejectedOn }, status: 'COMPLETED', ...scope }).sort({ plannedStart: 1 }).limit(50).toArray()
        : Promise.resolve([]),
      coll().find({ status: 'COMPLETED', ...scope }).sort({ plannedStart: -1 }).limit(RECENT_COMPLETED).toArray(),
    ]);
    const seen = new Set<string>();
    const docs = [...active, ...rejected, ...recent].filter((d) => {
      const id = d._id.toHexString();
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const allDoIds = docs.flatMap((d) => doIdsOf(d.stops));
    const allLocIds = docs.flatMap((d) => d.stops.map((s) => s.locationId));
    const [dos, locs] = await Promise.all([
      app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).find({ _id: { $in: allDoIds } }).toArray(),
      app.db.collection(C.locations).find({ _id: { $in: allLocIds } }).toArray(),
    ]);
    const forms = await podFormsFor(app.db, dos);
    const doById = new Map(dos.map((d) => [d._id.toHexString(), d]));
    const locById = new Map(locs.map((l) => [l._id.toHexString(), l]));
    const items = docs.map((doc) => ({
      ...shipmentView(doc),
      deliveryOrders: doIdsOf(doc.stops)
        .map((id) => doById.get(id.toHexString()))
        .filter((d): d is DeliveryOrderDoc => !!d)
        .map((d) => ({ ...toApi(d), podForm: toApi(forms.get(d._id.toHexString())!) })),
      locations: [...new Set(doc.stops.map((s) => s.locationId.toHexString()))]
        .map((id) => locById.get(id))
        .filter((l): l is NonNullable<typeof l> => !!l)
        .map((l) => ({ id: l._id.toHexString(), code: l.code, name: l.name, lat: l.geo.coordinates[1], lng: l.geo.coordinates[0], geofenceRadiusM: l.geofenceRadiusM })),
    }));
    return { items };
  });

  const VersionBody = z.object({ version: z.number().int().positive() });

  app.post(
    '/driver/shipments/:id/accept',
    { schema: { tags: ['driver'], params: IdParams, body: VersionBody, response: { 200: ShipmentItem } }, preHandler: driverOnly },
    async (req) => {
      const driverId = driverIdOf(req);
      const existing = await loadDriverShipment(app.db, new ObjectId(req.params.id), driverId);
      const by = actorOf(req);
      return shipmentView(
        await transition(app, existing, {
          // Bound to the version the driver's job list showed them (spec §5.1): if the planner
          // edited and re-dispatched in the meantime, this is stale and `transition` reports
          // 409 VERSION_CONFLICT instead of silently accepting a plan the driver never saw.
          version: req.body.version,
          from: ['DISPATCHED'],
          set: { status: 'ACCEPTED', driverResponse: { status: 'ACCEPTED', reason: null, at: new Date(), by } },
          action: 'accept',
          by,
          notAllowedCode: 'SHIPMENT_NOT_DISPATCHED',
        }),
      );
    },
  );

  app.post(
    '/driver/shipments/:id/decline',
    {
      schema: {
        tags: ['driver'],
        params: IdParams,
        body: VersionBody.extend({ reason: z.string().trim().min(3).max(500) }),
        response: { 200: ShipmentItem },
      },
      preHandler: driverOnly,
    },
    async (req) => {
      const driverId = driverIdOf(req);
      const existing = await loadDriverShipment(app.db, new ObjectId(req.params.id), driverId);
      const by = actorOf(req);
      return shipmentView(
        await transition(app, existing, {
          version: req.body.version,
          from: ['DISPATCHED'],
          set: { status: 'PLANNED', dispatch: null, driverResponse: { status: 'DECLINED', reason: req.body.reason, at: new Date(), by } },
          action: 'decline',
          by,
          notAllowedCode: 'SHIPMENT_NOT_DISPATCHED',
        }),
      );
    },
  );
};
