import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Filter } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { actorOf, writeAudit } from '../../lib/audit.js';
import { AppError, notFound, unprocessable } from '../../lib/errors.js';
import { gpsFlags } from '../../lib/geo.js';
import { GpsFields } from '../../lib/gps.js';
import { objectIdString } from '../../lib/ids.js';
import { PageQuery, pageResponse, paginate } from '../../lib/pagination.js';
import type { UserPrincipal } from '../../lib/principal.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { toApi } from '../../lib/serialize.js';
import { withTransaction } from '../../lib/tx.js';
import { driverIdOf, loadDriverShipment } from '../shipments/driver-access.js';
import { doIdsOf } from '../shipments/shipment.service.js';
import type { ShipmentStatus } from '../shipments/shipment.types.js';

interface MovementDoc {
  _id: ObjectId; clientEventId: string | null; tailVehicleId: ObjectId; driverId: ObjectId | null; shipmentId: ObjectId | null; doId: ObjectId | null;
  stopId: ObjectId | null; locationId: ObjectId | null; typeCode: string; sign: number; qty: number; remark: string | null;
  deviceTime: Date; receivedAt: Date; lat: number | null; lng: number | null; accuracyM: number | null; noGpsReason: string | null;
  geofenceDistanceM: number | null; flags: string[]; balanceAfter: number; source: 'app' | 'admin'; by: string;
}

interface BalanceDoc {
  _id: ObjectId;
  tailVehicleId: ObjectId;
  balance: number;
  lastMovementAt: Date;
}

const MovementItem = z.object({
  id: z.string(), clientEventId: z.string().nullable(), tailVehicleId: z.string(), driverId: z.string().nullable(), shipmentId: z.string().nullable(),
  doId: z.string().nullable(), stopId: z.string().nullable(), locationId: z.string().nullable(), typeCode: z.string(), sign: z.number(), qty: z.number(),
  remark: z.string().nullable(), deviceTime: z.string(), receivedAt: z.string(), lat: z.number().nullable(), lng: z.number().nullable(),
  accuracyM: z.number().nullable(), noGpsReason: z.string().nullable(), geofenceDistanceM: z.number().nullable(), flags: z.array(z.string()),
  balanceAfter: z.number(), source: z.enum(['app', 'admin']), by: z.string(),
});

const PALLET_ACTIVE_STATUSES: ShipmentStatus[] = ['ACCEPTED', 'IN_TRANSIT', 'COMPLETED'];

const isDuplicateKey = (e: unknown, field: string) =>
  (e as { code?: unknown }).code === 11000 && !!(e as { keyPattern?: Record<string, unknown> }).keyPattern?.[field];

// NOTE (Task 7, 2026-09-27): the brief for this task has the route import a shared
// `geofenceTarget` from `../execution/stop-context.js` (Task 4). Task 4 is being built in
// parallel on another branch and isn't in this worktree, so this is a local equivalent instead
// of creating that shared file here — same location shape (`geo.coordinates` + `geofenceRadiusM`)
// already used by `driver.routes.ts`. When Task 4 merges, this route should switch to importing
// the shared `geofenceTarget` and this local copy should be removed.
async function geofenceTarget(app: FastifyInstance, locationId: ObjectId): Promise<{ lat: number; lng: number; radiusM: number } | undefined> {
  const loc = await app.db.collection(C.locations).findOne({ _id: locationId }, { projection: { geo: 1, geofenceRadiusM: 1 } });
  if (!loc?.geo) return undefined;
  return { lat: loc.geo.coordinates[1], lng: loc.geo.coordinates[0], radiusM: loc.geofenceRadiusM as number };
}

async function applyMovement(
  app: FastifyInstance,
  m: Omit<MovementDoc, '_id' | 'sign' | 'balanceAfter'>,
  audit?: { action: string },
): Promise<MovementDoc> {
  const type = await app.db.collection(C.palletMovementTypes).findOne({ code: m.typeCode, active: true });
  if (!type) throw unprocessable('INVALID_REFERENCE', `Unknown pallet movement type ${m.typeCode}`, { field: 'typeCode' });
  const sign = type.sign as number;
  const run = () =>
    withTransaction(app.mongo, async (session) => {
      const bal = await app.db.collection<BalanceDoc>(C.palletBalances).findOneAndUpdate(
        { tailVehicleId: m.tailVehicleId },
        { $inc: { balance: sign * m.qty }, $max: { lastMovementAt: m.deviceTime } },
        { upsert: true, returnDocument: 'after', session },
      );
      const doc: MovementDoc = { ...m, _id: new ObjectId(), sign, balanceAfter: bal!.balance };
      await app.db.collection<MovementDoc>(C.palletMovements).insertOne(doc, { session });
      if (audit) {
        await writeAudit(app.db, { entity: 'palletMovement', entityId: doc._id.toHexString(), action: audit.action, by: m.by, after: toApi(doc) }, { session });
      }
      return doc;
    });
  try {
    return await run();
  } catch (e) {
    // The first two movements of a vehicle can race on the balance upsert; the loser finds the row on a second try.
    if (isDuplicateKey(e, 'tailVehicleId')) return run();
    throw e;
  }
}

const DriverMovement = z
  .object({
    clientEventId: z.string().uuid(),
    shipmentId: objectIdString,
    stopId: objectIdString.nullable().default(null),
    doId: objectIdString.nullable().default(null),
    typeCode: z.string().trim().min(1).max(40),
    qty: z.number().int().min(1),
    remark: z.string().trim().max(200).nullable().default(null),
  })
  .and(GpsFields);

export const palletRoutes: FastifyPluginAsyncZod = async (app) => {
  const staff = app.requireRoles(...STAFF_ROLES);
  const moves = () => app.db.collection<MovementDoc>(C.palletMovements);

  app.post(
    '/driver/pallet-movements',
    {
      schema: {
        tags: ['driver'],
        body: z.object({ movements: z.array(DriverMovement).min(1).max(50) }),
        response: { 200: z.object({ results: z.array(z.object({ clientEventId: z.string(), status: z.enum(['accepted', 'duplicate', 'rejected']), balanceAfter: z.number().nullable(), code: z.string().optional(), message: z.string().optional() })) }) },
      },
      preHandler: app.requireRoles('driver'),
    },
    async (req) => {
      const driverId = driverIdOf(req);
      const by = actorOf(req);
      const results = [];
      for (const m of req.body.movements) {
        const dup = await moves().findOne({ clientEventId: m.clientEventId });
        if (dup) {
          results.push({ clientEventId: m.clientEventId, status: 'duplicate' as const, balanceAfter: dup.balanceAfter });
          continue;
        }
        try {
          const sh = await loadDriverShipment(app.db, new ObjectId(m.shipmentId), driverId);
          if (!PALLET_ACTIVE_STATUSES.includes(sh.status)) throw unprocessable('SHIPMENT_NOT_ACTIVE', `Cannot record pallets on a ${sh.status} shipment`);
          const stop = m.stopId ? sh.stops.find((s) => s.stopId.toHexString() === m.stopId) : null;
          if (m.stopId && !stop) throw unprocessable('INVALID_REFERENCE', 'stopId is not a stop of this shipment', { field: 'stopId' });
          if (m.doId && !doIdsOf(sh.stops).some((id) => id.toHexString() === m.doId)) {
            throw unprocessable('INVALID_REFERENCE', 'doId is not on this shipment', { field: 'doId' });
          }
          const deviceTime = new Date(m.deviceTime);
          const receivedAt = new Date();
          const { flags, distanceM } = gpsFlags({
            lat: m.lat, lng: m.lng, accuracyM: m.accuracyM, deviceTime, receivedAt,
            target: stop ? await geofenceTarget(app, stop.locationId) : undefined,
          });
          const doc = await applyMovement(app, {
            clientEventId: m.clientEventId, tailVehicleId: sh.tail?.vehicleId ?? sh.head!.vehicleId, driverId, shipmentId: sh._id,
            doId: m.doId ? new ObjectId(m.doId) : null, stopId: stop?.stopId ?? null, locationId: stop?.locationId ?? null,
            typeCode: m.typeCode, qty: m.qty, remark: m.remark, deviceTime, receivedAt, lat: m.lat, lng: m.lng, accuracyM: m.accuracyM,
            noGpsReason: m.noGpsReason, geofenceDistanceM: distanceM, flags, source: 'app', by,
          });
          results.push({ clientEventId: m.clientEventId, status: 'accepted' as const, balanceAfter: doc.balanceAfter });
        } catch (e) {
          if (isDuplicateKey(e, 'clientEventId')) {
            const again = await moves().findOne({ clientEventId: m.clientEventId });
            results.push({ clientEventId: m.clientEventId, status: 'duplicate' as const, balanceAfter: again?.balanceAfter ?? null });
          } else if (e instanceof AppError) {
            results.push({ clientEventId: m.clientEventId, status: 'rejected' as const, balanceAfter: null, code: e.code, message: e.message });
          } else throw e;
        }
      }
      return { results };
    },
  );

  app.post(
    '/pallet-movements',
    {
      schema: {
        tags: ['pallets'],
        body: z.object({ tailVehicleId: objectIdString, typeCode: z.string().trim().min(1).max(40), qty: z.number().int().min(1), remark: z.string().trim().min(3).max(200) }),
        response: { 201: MovementItem },
      },
      preHandler: app.requireRoles('admin'),
    },
    async (req, reply) => {
      const tailVehicleId = new ObjectId(req.body.tailVehicleId);
      if (!(await app.db.collection(C.vehicles).countDocuments({ _id: tailVehicleId }, { limit: 1 }))) throw notFound('Vehicle');
      const now = new Date();
      const doc = await applyMovement(
        app,
        {
          clientEventId: null, tailVehicleId, driverId: null, shipmentId: null, doId: null, stopId: null, locationId: null,
          typeCode: req.body.typeCode, qty: req.body.qty, remark: req.body.remark, deviceTime: now, receivedAt: now,
          lat: null, lng: null, accuracyM: null, noGpsReason: null, geofenceDistanceM: null, flags: [], source: 'admin', by: actorOf(req),
        },
        { action: 'correct' },
      );
      return reply.status(201).send(toApi(doc));
    },
  );

  app.get(
    '/pallet-balances',
    {
      schema: {
        tags: ['pallets'],
        querystring: z.object({ tailVehicleId: objectIdString.optional() }),
        response: { 200: z.object({ items: z.array(z.object({ tailVehicleId: z.string(), plate: z.string(), balance: z.number(), lastMovementAt: z.string().nullable() })) }) },
      },
      preHandler: staff,
    },
    async (req) => {
      const f: Filter<BalanceDoc> = req.query.tailVehicleId ? { tailVehicleId: new ObjectId(req.query.tailVehicleId) } : {};
      const bals = await app.db.collection<BalanceDoc>(C.palletBalances).find(f).limit(2000).toArray();
      const vehicles = await app.db.collection(C.vehicles).find({ _id: { $in: bals.map((b) => b.tailVehicleId) } }, { projection: { plate: 1 } }).toArray();
      const plate = new Map(vehicles.map((v) => [v._id.toHexString(), v.plate as string]));
      return {
        items: bals.map((b) => ({
          tailVehicleId: b.tailVehicleId.toHexString(),
          plate: plate.get(b.tailVehicleId.toHexString()) ?? '',
          balance: b.balance,
          lastMovementAt: b.lastMovementAt ? b.lastMovementAt.toISOString() : null,
        })),
      };
    },
  );

  app.get(
    '/pallet-movements',
    {
      schema: {
        tags: ['pallets'],
        querystring: PageQuery.extend({ tailVehicleId: objectIdString.optional(), driverId: objectIdString.optional() }),
        response: { 200: pageResponse(MovementItem) },
      },
      preHandler: app.requireRoles(...STAFF_ROLES, 'driver'),
    },
    async (req) => {
      const q = req.query;
      const filter: Filter<MovementDoc> = {};
      if (q.tailVehicleId) filter.tailVehicleId = new ObjectId(q.tailVehicleId);
      if (q.driverId) filter.driverId = new ObjectId(q.driverId);
      // Drivers see only their own movements (spec §7, §8.2), whatever filter they send.
      const roles = (req.principal as UserPrincipal).roles;
      if (!roles.some((r) => STAFF_ROLES.includes(r))) filter.driverId = driverIdOf(req);
      const page = await paginate(moves(), filter, q);
      return { items: page.items.map(toApi), nextCursor: page.nextCursor };
    },
  );
};
