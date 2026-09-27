import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf } from '../../lib/audit.js';
import { AppError, notFound } from '../../lib/errors.js';
import { IdParams } from '../../lib/ids.js';
import { toApi } from '../../lib/serialize.js';
import type { DeliveryOrderDoc } from '../orders/order.types.js';
import { DoItem } from '../orders/orders.schemas.js';
import { ShipmentItem } from './shipment.schemas.js';
import { doIdsOf, shipmentView, transition } from './shipment.service.js';
import type { ShipmentDoc } from './shipment.types.js';

const LocationLite = z.object({ id: z.string(), code: z.string(), name: z.string(), lat: z.number(), lng: z.number(), geofenceRadiusM: z.number() });
const DriverShipment = ShipmentItem.extend({ deliveryOrders: z.array(DoItem), locations: z.array(LocationLite) });

export const driverRoutes: FastifyPluginAsyncZod = async (app) => {
  const driverOnly = app.requireRoles('driver');
  const coll = () => app.db.collection<ShipmentDoc>(C.shipments);

  const driverIdOf = (req: { principal: unknown }) => {
    const p = req.principal as { kind: string; driverId: string | null } | null;
    if (!p || p.kind !== 'user' || !p.driverId) throw new AppError(403, 'NOT_A_DRIVER', 'This user is not linked to a driver');
    return new ObjectId(p.driverId);
  };
  const mine = (driverId: ObjectId) => ({ $or: [{ 'head.driverId': driverId }, { 'tail.driverId': driverId }] });
  const loadMine = async (id: string, driverId: ObjectId) => {
    const doc = await coll().findOne({ _id: new ObjectId(id), ...mine(driverId) });
    if (!doc) throw notFound('Shipment');
    return doc;
  };

  app.get('/driver/shipments', { schema: { tags: ['driver'], response: { 200: z.object({ items: z.array(DriverShipment) }) } }, preHandler: driverOnly }, async (req) => {
    const driverId = driverIdOf(req);
    const docs = await coll()
      .find({ status: { $in: ['DISPATCHED', 'ACCEPTED', 'IN_TRANSIT'] }, ...mine(driverId) })
      .sort({ plannedStart: 1 })
      .limit(50)
      .toArray();
    const allDoIds = docs.flatMap((d) => doIdsOf(d.stops));
    const allLocIds = docs.flatMap((d) => d.stops.map((s) => s.locationId));
    const [dos, locs] = await Promise.all([
      app.db.collection<DeliveryOrderDoc>(C.deliveryOrders).find({ _id: { $in: allDoIds } }).toArray(),
      app.db.collection(C.locations).find({ _id: { $in: allLocIds } }).toArray(),
    ]);
    const doById = new Map(dos.map((d) => [d._id.toHexString(), d]));
    const locById = new Map(locs.map((l) => [l._id.toHexString(), l]));
    const items = docs.map((doc) => ({
      ...shipmentView(doc),
      deliveryOrders: doIdsOf(doc.stops).map((id) => doById.get(id.toHexString())).filter((d): d is DeliveryOrderDoc => !!d).map(toApi),
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
      const existing = await loadMine(req.params.id, driverId);
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
      const existing = await loadMine(req.params.id, driverId);
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
