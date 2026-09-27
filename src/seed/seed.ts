import type { Db, Document, ObjectId } from 'mongodb';
import { C } from '../db/collections.js';
import { createUser, findUserByUsername } from '../modules/users/users.repo.js';

export const BASE_TRUCK_TYPES = [
  { code: 'MIXER', name: 'Mixer', category: 'rigid' },
  { code: 'TRAILER', name: 'Trailer (หัวลาก + หาง)', category: 'tractor' },
  { code: 'FEEDMILL', name: 'Feedmill', category: 'rigid' },
  { code: 'COLDCHAIN', name: 'Coldchain', category: 'rigid' },
  { code: 'SIDE_CURTAIN', name: 'Side Curtain', category: 'rigid' },
] as const;

export const BASE_PALLET_MOVEMENT_TYPES = [
  { code: 'RETURN_IN', name: 'รับคืน', sign: 1 },
  { code: 'BORROW_CUSTOMER', name: 'ยืมลค.', sign: 1 },
  { code: 'DEPOSIT', name: 'นำฝาก', sign: -1 },
  { code: 'RETURN_CUSTOMER', name: 'คืนลค.', sign: -1 },
] as const;

// Inserts by `code` only when missing, so later edits in the admin panel are never overwritten.
async function upsertByCode(db: Db, collection: string, doc: Document): Promise<ObjectId> {
  const now = new Date();
  const res = await db.collection(collection).findOneAndUpdate(
    { code: doc.code },
    { $setOnInsert: { ...doc, active: true, createdAt: now, updatedAt: now } },
    { upsert: true, returnDocument: 'after' },
  );
  return res!._id as ObjectId;
}

export async function seedBase(db: Db): Promise<void> {
  for (const t of BASE_TRUCK_TYPES) await upsertByCode(db, C.truckTypes, { ...t });
  for (const p of BASE_PALLET_MOVEMENT_TYPES) await upsertByCode(db, C.palletMovementTypes, { ...p });
}

export async function seedAdmin(db: Db, username: string, password: string): Promise<'created' | 'exists'> {
  if (await findUserByUsername(db, username)) return 'exists';
  await createUser(db, { username, password, roles: ['admin'] });
  return 'created';
}

export async function seedDemo(db: Db): Promise<void> {
  await seedBase(db);
  const clientId = await upsertByCode(db, C.clients, { code: 'DEMO', name: 'Demo Client' });
  const zBkk = await upsertByCode(db, C.zones, { code: 'BKK', name: 'กรุงเทพฯ' });
  const zCen = await upsertByCode(db, C.zones, { code: 'CEN', name: 'ภาคกลาง' });
  const readymix = await upsertByCode(db, C.materials, { code: 'READYMIX', name: 'คอนกรีตผสมเสร็จ', unit: 'm3' });
  await upsertByCode(db, C.materials, { code: 'BAGCEMENT', name: 'ปูนถุง', unit: 'bag' });
  await upsertByCode(db, C.serviceTypes, { code: 'SINGLE', name: 'ส่งเที่ยวเดียว' });
  await upsertByCode(db, C.serviceTypes, { code: 'DAILY', name: 'เหมาวัน' });
  const mixer = (await db.collection(C.truckTypes).findOne({ code: 'MIXER' }))!._id as ObjectId;
  const plant = await upsertByCode(db, C.locations, {
    code: 'DEMO-PLANT', name: 'Demo batching plant', clientId, zoneId: zCen, isSite: true, address: null,
    geo: { type: 'Point', coordinates: [100.91, 14.53] }, geofenceRadiusM: 300,
  });
  await upsertByCode(db, C.locations, {
    code: 'DEMO-SITE-BKK', name: 'Demo construction site', clientId, zoneId: zBkk, isSite: false, address: 'Bangkok',
    geo: { type: 'Point', coordinates: [100.53, 13.74] }, geofenceRadiusM: 300,
  });
  const now = new Date();
  const group = await db.collection(C.jobGroups).findOneAndUpdate(
    { clientId, code: 'RMC-PLANT' },
    {
      $setOnInsert: {
        clientId, code: 'RMC-PLANT', name: 'Ready-mix from demo plant',
        criteria: { truckTypeIds: [mixer], serviceTypeIds: [], siteIds: [plant], materialIds: [readymix], originZoneIds: [], destZoneIds: [] },
        active: true, createdAt: now, updatedAt: now,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );
  await db.collection(C.podTemplates).updateOne(
    { clientId, jobGroupId: group!._id, status: 'published', version: 1 },
    {
      $setOnInsert: {
        name: 'Mixer POD', extraSteps: [],
        fields: [
          { key: 'ticketPhoto', label: 'รูปตั๋วส่งคอนกรีต', type: 'photo', required: true, min: 1, max: 3 },
          { key: 'slumpCm', label: 'ค่ายุบตัว (ซม.)', type: 'number', required: true, min: 0, max: 25, unit: 'cm' },
          { key: 'receiverName', label: 'ชื่อผู้รับ', type: 'text', required: true },
          { key: 'receiverSign', label: 'ลายเซ็นผู้รับ', type: 'signature', required: true },
        ],
        publishedAt: now, publishedBy: 'seed', createdAt: now, updatedAt: now, createdBy: 'seed',
      },
    },
    { upsert: true },
  );
}
