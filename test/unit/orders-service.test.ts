import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { C } from '../../src/db/collections.js';
import type { DeliveryOrderDoc } from '../../src/modules/orders/order.types.js';
import { updateDoIfUnchanged } from '../../src/modules/orders/orders.service.js';
import { testDb } from '../helpers/db.js';

function makeDo(overrides: Partial<DeliveryOrderDoc> = {}): DeliveryOrderDoc {
  const now = new Date();
  return {
    _id: new ObjectId(),
    doNo: 'DO-2610-00001',
    clientRef: null,
    clientId: new ObjectId(),
    jobGroupId: null,
    jobGroupMatch: { status: 'none', candidates: [] },
    serviceTypeId: new ObjectId(),
    materialId: new ObjectId(),
    intendedTruckTypeId: null,
    qty: 1,
    unit: 'ton',
    palletPlan: null,
    originLocationId: new ObjectId(),
    destLocationId: new ObjectId(),
    pickupWindow: null,
    dropWindow: null,
    distance: { clientKm: null },
    shipmentId: null,
    pickupStopId: null,
    dropStopId: null,
    status: 'UNASSIGNED',
    note: null,
    cancelledAt: null,
    cancelReason: null,
    createdBy: 'seed',
    createdAt: now,
    updatedBy: 'seed',
    updatedAt: now,
    ...overrides,
  };
}

describe('updateDoIfUnchanged', () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await testDb());
  });
  afterAll(async () => close());

  it('refuses the write (returns null) when the stored status/shipmentId no longer match the snapshot', async () => {
    const doc = makeDo();
    await db.collection(C.deliveryOrders).insertOne(doc);

    // Simulate a concurrent shipment assignment that happened after the caller loaded `doc`.
    const takenBy = new ObjectId();
    await db.collection(C.deliveryOrders).updateOne({ _id: doc._id }, { $set: { status: 'PLANNED', shipmentId: takenBy } });

    const result = await updateDoIfUnchanged(db, doc, { qty: 99 });
    expect(result).toBeNull();

    const stored = await db.collection<DeliveryOrderDoc>(C.deliveryOrders).findOne({ _id: doc._id });
    expect(stored?.qty).toBe(1);
    expect(stored?.status).toBe('PLANNED');
    expect(stored?.shipmentId).toEqual(takenBy);
  });

  it('applies the update when the stored status/shipmentId still match the snapshot', async () => {
    const doc = makeDo();
    await db.collection(C.deliveryOrders).insertOne(doc);

    const result = await updateDoIfUnchanged(db, doc, { qty: 42 });
    expect(result?.qty).toBe(42);
  });
});
