import type { Db, IndexDescription } from 'mongodb';
import { C } from './collections.js';

// Each task adds its collection's indexes here.
export const INDEXES: Record<string, IndexDescription[]> = {
  [C.users]: [
    { key: { username: 1 }, unique: true },
    { key: { driverId: 1 }, unique: true, partialFilterExpression: { driverId: { $type: 'objectId' } } },
  ],
  [C.refreshTokens]: [{ key: { familyId: 1 } }, { key: { userId: 1 } }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  [C.apiKeys]: [{ key: { active: 1 } }],
  [C.auditLog]: [{ key: { entity: 1, entityId: 1, at: -1 } }],
  [C.clients]: [{ key: { code: 1 }, unique: true }],
  [C.zones]: [{ key: { code: 1 }, unique: true }],
  [C.materials]: [{ key: { code: 1 }, unique: true }],
  [C.serviceTypes]: [{ key: { code: 1 }, unique: true }],
  [C.truckTypes]: [{ key: { code: 1 }, unique: true }],
  [C.palletMovementTypes]: [{ key: { code: 1 }, unique: true }],
  [C.locations]: [{ key: { code: 1 }, unique: true }, { key: { geo: '2dsphere' } }, { key: { zoneId: 1 } }, { key: { clientId: 1 } }],
  [C.vehicles]: [
    { key: { plateKey: 1 }, unique: true },
    { key: { plate: 1 } },
    { key: { truckTypeId: 1 } },
    { key: { gpsId: 1 } },
  ],
  [C.drivers]: [{ key: { code: 1 }, unique: true }],
  [C.jobGroups]: [{ key: { clientId: 1, code: 1 }, unique: true }, { key: { clientId: 1, active: 1 } }],
  [C.podTemplates]: [
    { key: { clientId: 1, jobGroupId: 1, status: 1, version: -1 } },
    {
      key: { clientId: 1, jobGroupId: 1, version: 1 },
      unique: true,
      partialFilterExpression: { status: 'published' },
    },
  ],
  [C.statusCodes]: [{ key: { code: 1 }, unique: true }],
  [C.holidays]: [{ key: { date: 1 }, unique: true }],
  [C.deliveryOrders]: [
    { key: { doNo: 1 }, unique: true },
    { key: { status: 1, clientId: 1 } },
    { key: { shipmentId: 1 } },
    { key: { 'pickupWindow.from': 1 } },
    { key: { clientId: 1, clientRef: 1 } },
  ],
  [C.resourceBlocks]: [
    { key: { resourceType: 1, resourceId: 1, from: 1, to: 1 } },
    { key: { cancelledAt: 1, from: 1 } },
  ],
  [C.palletMovements]: [
    { key: { clientEventId: 1 }, unique: true, partialFilterExpression: { clientEventId: { $type: 'string' } } },
    { key: { tailVehicleId: 1, _id: 1 } },
    { key: { driverId: 1, _id: 1 } },
  ],
  [C.palletBalances]: [{ key: { tailVehicleId: 1 }, unique: true }],
  [C.shipments]: [
    { key: { shipmentNo: 1 }, unique: true },
    { key: { status: 1, plannedStart: 1 } },
    { key: { 'head.vehicleId': 1, plannedStart: 1 } },
    { key: { 'tail.vehicleId': 1, plannedStart: 1 } },
    { key: { 'head.driverId': 1, plannedStart: 1 } },
    { key: { 'tail.driverId': 1, plannedStart: 1 } },
    { key: { plannedEnd: 1, plannedStart: 1 } },
  ],
  [C.events]: [{ key: { clientEventId: 1 }, unique: true }, { key: { shipmentId: 1, deviceTime: 1 } }],
  [C.pods]: [
    { key: { clientPodId: 1 }, unique: true },
    { key: { status: 1, _id: 1 } },
    { key: { doId: 1, _id: -1 } },
    { key: { shipmentId: 1, _id: 1 } },
  ],
  [C.tripSummaries]: [{ key: { shipmentId: 1 }, unique: true }],
};

export async function ensureIndexes(db: Db): Promise<void> {
  for (const [name, specs] of Object.entries(INDEXES)) {
    if (specs.length > 0) await db.collection(name).createIndexes(specs);
  }
}
