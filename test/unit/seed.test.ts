import type { Db, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { C } from '../../src/db/collections.js';
import { ensureIndexes } from '../../src/db/indexes.js';
import { verifyPassword } from '../../src/lib/passwords.js';
import { matchJobGroupForDo } from '../../src/modules/master/job-groups.js';
import { findUserByUsername } from '../../src/modules/users/users.repo.js';
import { BASE_STATUS_CODES, seedAdmin, seedBase, seedDemo } from '../../src/seed/seed.js';
import { testDb } from '../helpers/db.js';

describe('seed', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await testDb());
    await ensureIndexes(db);
  });
  afterAll(async () => close());

  it('seeds base data idempotently without overwriting edits', async () => {
    await seedBase(db);
    await db.collection(C.truckTypes).updateOne({ code: 'MIXER' }, { $set: { name: 'Mixer 6 คิว' } });
    await seedBase(db);
    expect(await db.collection(C.truckTypes).countDocuments()).toBe(5);
    expect(await db.collection(C.palletMovementTypes).countDocuments()).toBe(4);
    expect(await db.collection(C.statusCodes).countDocuments()).toBe(BASE_STATUS_CODES.length);
    expect(await db.collection(C.statusCodes).findOne({ code: 'A' })).toMatchObject({ level1: 'working', blocksAssignment: false });
    expect(await db.collection(C.statusCodes).findOne({ code: 'PM' })).toMatchObject({ level1: 'not_working', appliesTo: 'vehicle', blocksAssignment: true });
    expect((await db.collection(C.truckTypes).findOne({ code: 'MIXER' }))?.name).toBe('Mixer 6 คิว');
  });

  it('creates the admin once', async () => {
    expect(await seedAdmin(db, 'admin', 'Admin-pass-1')).toBe('created');
    expect(await seedAdmin(db, 'admin', 'other')).toBe('exists');
    const admin = await findUserByUsername(db, 'admin');
    expect(admin?.roles).toEqual(['admin']);
    expect(await verifyPassword(admin!.passwordHash, 'Admin-pass-1')).toBe(true);
  });

  it('restores a locked-out admin with force, without touching the password', async () => {
    expect(await seedAdmin(db, 'lockedadmin', 'Original-pass-1')).toBe('created');
    await db.collection(C.users).updateOne({ username: 'lockedadmin' }, { $set: { active: false, roles: ['viewer'] } });

    expect(await seedAdmin(db, 'lockedadmin', 'other')).toBe('exists');
    const untouched = await findUserByUsername(db, 'lockedadmin');
    expect(untouched?.active).toBe(false);

    expect(await seedAdmin(db, 'lockedadmin', 'ignored-pass', { force: true })).toBe('restored');
    const restored = await findUserByUsername(db, 'lockedadmin');
    expect(restored?.active).toBe(true);
    expect(restored?.roles).toContain('admin');
    expect(await verifyPassword(restored!.passwordHash, 'Original-pass-1')).toBe(true);
  });

  it('seeds demo data idempotently and it matches a job group', async () => {
    await seedDemo(db, { password: 'Demo-pass-1' });
    await seedDemo(db, { password: 'Demo-pass-1' });
    expect(await db.collection(C.clients).countDocuments({ code: 'DEMO' })).toBe(1);
    const client = await db.collection(C.clients).findOne({ code: 'DEMO' });
    const byCode = async (coll: string, code: string) => (await db.collection(coll).findOne({ code }))!._id as ObjectId;
    const result = await matchJobGroupForDo(db, client!._id, {
      truckTypeId: await byCode(C.truckTypes, 'MIXER'),
      serviceTypeId: await byCode(C.serviceTypes, 'SINGLE'),
      materialId: await byCode(C.materials, 'READYMIX'),
      originLocationId: await byCode(C.locations, 'DEMO-PLANT'),
      destLocationId: await byCode(C.locations, 'DEMO-SITE-BKK'),
    });
    expect(result.status).toBe('auto');
    expect(await db.collection(C.podTemplates).countDocuments({ clientId: client!._id, status: 'published' })).toBe(1);
  });

  it('seeds demo users, fleet and unassigned DOs idempotently', async () => {
    await seedDemo(db, { password: 'Demo-pass-1' });
    await seedDemo(db, { password: 'Demo-pass-1' });
    for (const u of ['demo-admin', 'demo-planner', 'demo-driver1', 'demo-driver2']) {
      const user = await findUserByUsername(db, u);
      expect(user).not.toBeNull();
      expect(await verifyPassword(user!.passwordHash, 'Demo-pass-1')).toBe(true);
    }
    expect((await findUserByUsername(db, 'demo-driver1'))!.driverId).not.toBeNull();
    expect(await db.collection(C.vehicles).countDocuments({ plate: { $in: ['70-1001', '70-1002', '71-2001', '71-2002', '80-3001', '80-3002'] } })).toBe(6);
    expect(await db.collection(C.deliveryOrders).countDocuments({ status: 'UNASSIGNED' })).toBe(3);
  });

  it("puts a shipment on demo-driver1's phone, already dispatched and ready", async () => {
    await seedDemo(db, { password: 'Demo-pass-1' });
    await seedDemo(db, { password: 'Demo-pass-1' });
    const driver1 = await findUserByUsername(db, 'demo-driver1');
    const shipment = await db.collection(C.shipments).findOne({ 'head.driverId': driver1!.driverId, status: 'DISPATCHED' });
    expect(shipment).not.toBeNull();
    // Visible to the driver app the same way `GET /driver/shipments` finds it.
    const driverVisible = await db.collection(C.shipments).findOne({
      _id: shipment!._id,
      status: { $in: ['DISPATCHED', 'ACCEPTED', 'IN_TRANSIT', 'COMPLETED'] },
      $or: [{ 'head.driverId': driver1!.driverId }, { 'tail.driverId': driver1!.driverId }],
    });
    expect(driverVisible).not.toBeNull();
    const linkedDo = await db.collection(C.deliveryOrders).findOne({ clientRef: 'DEMO-4' });
    expect(linkedDo!.shipmentId).toEqual(shipment!._id);
    expect(linkedDo!.status).toBe('PLANNED');
    // Only one dispatched demo shipment even after a second seed run.
    expect(await db.collection(C.shipments).countDocuments({ note: 'Demo shipment — ready for demo-driver1' })).toBe(1);
  });
});
