import { ObjectId, type Db } from 'mongodb';
import { C } from '../../db/collections.js';
import { assertActiveRefs } from '../../lib/active-refs.js';
import { unprocessable } from '../../lib/errors.js';
import type { Issue } from '../../lib/issues.js';
import { findShipmentsUsing } from '../shipments/shipment.queries.js';
import type { AppliesTo, Level1 } from './status-codes.js';

export const RESOURCE_TYPES = ['vehicle', 'driver'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export interface BlockDoc {
  _id: ObjectId;
  resourceType: ResourceType;
  resourceId: ObjectId;
  statusCode: string;
  level1: Level1;
  blocksAssignment: boolean;
  from: Date;
  to: Date;
  note: string | null;
  source: 'manual' | 'atms';
  cancelledAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
}

export async function findActiveBlocks(db: Db, resources: { type: ResourceType; id: ObjectId }[], from: Date, to: Date): Promise<BlockDoc[]> {
  if (resources.length === 0) return [];
  return db
    .collection<BlockDoc>(C.resourceBlocks)
    .find({
      cancelledAt: null,
      from: { $lt: to },
      to: { $gt: from },
      $or: resources.map((r) => ({ resourceType: r.type, resourceId: r.id })),
    })
    .sort({ from: 1 })
    .toArray();
}

/** Validates a block's fields (merged with an existing block on PATCH) and returns catalogue-derived fields + warnings. */
export async function prepareBlock(
  db: Db,
  b: { resourceType: ResourceType; resourceId: ObjectId; statusCode: string; from: Date; to: Date },
): Promise<{ level1: Level1; blocksAssignment: boolean; warnings: Issue[] }> {
  if (b.to.getTime() <= b.from.getTime()) throw unprocessable('INVALID_RANGE', '`to` must be after `from`');
  await assertActiveRefs(db, [{ field: 'resourceId', collection: b.resourceType === 'vehicle' ? C.vehicles : C.drivers, ids: [b.resourceId] }]);
  const code = await db.collection(C.statusCodes).findOne({ code: b.statusCode, active: true });
  if (!code) throw unprocessable('INVALID_REFERENCE', `Unknown status code ${b.statusCode}`, { field: 'statusCode' });
  const applies = code.appliesTo as AppliesTo;
  if (applies !== 'both' && applies !== b.resourceType) {
    throw unprocessable('STATUS_CODE_NOT_APPLICABLE', `Status code ${b.statusCode} does not apply to a ${b.resourceType}`);
  }
  const using = await findShipmentsUsing(db, b.resourceType, b.resourceId, b.from, b.to);
  const warnings: Issue[] = using.map((s) => ({
    code: 'SHIPMENT_CONFLICT',
    message: `Shipment ${s.shipmentNo} already uses this ${b.resourceType} in this period`,
    details: { shipmentId: s._id.toHexString(), shipmentNo: s.shipmentNo },
  }));
  return { level1: code.level1 as Level1, blocksAssignment: code.blocksAssignment === true, warnings };
}
