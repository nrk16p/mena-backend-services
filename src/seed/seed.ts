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

const UNCONFIRMED_WORKING = ['Aล', 'Aส', 'Aซ', 'Aค', 'Aน', 'Aป'];
const UNCONFIRMED_NOT_WORKING = ['ล', 'ป', 'ก', 'ฝ', 'ลพ', 'ลอ', 'ย', 'ลข', 'ลส', 'ปอ', 'จ', 'ลฃ'];

export const BASE_STATUS_CODES = [
  // Planning codes used by resource blocks.
  { code: 'PM', name: 'เข้า PM เช็คระยะ', level1: 'not_working', appliesTo: 'vehicle', blocksAssignment: true },
  { code: 'REPAIR', name: 'ซ่อม', level1: 'not_working', appliesTo: 'vehicle', blocksAssignment: true },
  { code: 'TIRE', name: 'เปลี่ยนยาง', level1: 'not_working', appliesTo: 'vehicle', blocksAssignment: true },
  { code: 'INSPECTION', name: 'ตรวจสภาพ / ต่อภาษี', level1: 'not_working', appliesTo: 'vehicle', blocksAssignment: true },
  { code: 'LEAVE', name: 'ลา', level1: 'not_working', appliesTo: 'driver', blocksAssignment: true },
  { code: 'SICK', name: 'ลาป่วย', level1: 'not_working', appliesTo: 'driver', blocksAssignment: true },
  { code: 'HOLIDAY', name: 'วันหยุด', level1: 'not_working', appliesTo: 'driver', blocksAssignment: true },
  { code: 'TRAINING', name: 'อบรม', level1: 'not_working', appliesTo: 'driver', blocksAssignment: true },
  { code: 'OTHER', name: 'อื่น ๆ', level1: 'not_working', appliesTo: 'both', blocksAssignment: false },
  // ATMS daily status codes (atms.vehicle_daily_asia, field คนขับ): codes starting with A are working.
  { code: 'A', name: 'ทำงานปกติ', level1: 'working', appliesTo: 'both', blocksAssignment: false },
  { code: 'A50', name: 'ทำงาน 4 ชม.', level1: 'working', appliesTo: 'both', blocksAssignment: false },
  { code: 'Aอส', name: 'รถโอนสาย', level1: 'working', appliesTo: 'both', blocksAssignment: false },
  ...UNCONFIRMED_WORKING.map((code) => ({
    code, name: `ATMS ${code} (รอยืนยันความหมาย)`, level1: 'working', appliesTo: 'both', blocksAssignment: false,
  })),
  ...UNCONFIRMED_NOT_WORKING.map((code) => ({
    code, name: `ATMS ${code} (รอยืนยันความหมาย)`, level1: 'not_working', appliesTo: 'both', blocksAssignment: true,
  })),
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
  for (const s of BASE_STATUS_CODES) await upsertByCode(db, C.statusCodes, { ...s });
}

export async function seedAdmin(
  db: Db,
  username: string,
  password: string,
  opts: { force?: boolean } = {},
): Promise<'created' | 'exists' | 'restored'> {
  const existing = await findUserByUsername(db, username);
  if (!existing) {
    await createUser(db, { username, password, roles: ['admin'] });
    return 'created';
  }
  if (!opts.force) return 'exists';
  // Recovery path for a locked-out admin: reactivate and (re-)grant the admin role
  // without touching the password, so this can't be used to take over the account.
  const roles = existing.roles.includes('admin') ? existing.roles : [...existing.roles, 'admin'];
  await db.collection(C.users).updateOne({ _id: existing._id }, { $set: { active: true, roles, updatedAt: new Date() } });
  return 'restored';
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
