import { ObjectId } from 'mongodb';
import type { Db, Document } from 'mongodb';
import { C } from '../db/collections.js';
import { nextNumber } from '../lib/counters.js';
import type { Role } from '../lib/roles.js';
import { normalizePlate, plateKey } from '../modules/master/fleet.js';
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

/** "Today" at 08:00 Bangkok time, as a UTC `Date` — used for the demo's already-dispatched shipment. */
function bangkokTodayAt(hour: number): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return new Date(`${ymd}T${String(hour).padStart(2, '0')}:00:00+07:00`);
}

export async function seedDemo(db: Db, opts: { password: string }): Promise<void> {
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

  // --- Fleet, drivers and demo user accounts (Task 11) ---
  const trailer = (await db.collection(C.truckTypes).findOne({ code: 'TRAILER' }))!._id as ObjectId;
  const kkn = await upsertByCode(db, C.locations, {
    code: 'DEMO-SHOP-KKN', name: 'ร้านวัสดุ ขอนแก่น', clientId, zoneId: zCen, isSite: false, address: 'Khon Kaen',
    geo: { type: 'Point', coordinates: [102.83, 16.43] }, geofenceRadiusM: 300,
  });
  const upsertVehicle = async (plate: string, part: string, truckTypeId: ObjectId) => {
    const now2 = new Date();
    await db.collection(C.vehicles).updateOne(
      { plateKey: plateKey(plate) },
      { $setOnInsert: { plate: normalizePlate(plate), plateKey: plateKey(plate), part, truckTypeId, gpsVendor: null, gpsId: null, active: true, createdAt: now2, updatedAt: now2 } },
      { upsert: true },
    );
  };
  await upsertVehicle('70-1001', 'head', trailer);
  await upsertVehicle('70-1002', 'head', trailer);
  await upsertVehicle('71-2001', 'tail', trailer);
  await upsertVehicle('71-2002', 'tail', trailer);
  await upsertVehicle('80-3001', 'rigid', mixer);
  await upsertVehicle('80-3002', 'rigid', mixer);
  const d1 = await upsertByCode(db, C.drivers, { code: 'DRV-001', name: 'สมชาย ใจดี', phone: '0810000001', licenseType: 'ท.4', licenseExpiry: '2030-12-31', weeklyDaysOff: [] });
  const d2 = await upsertByCode(db, C.drivers, { code: 'DRV-002', name: 'สมศักดิ์ ขยัน', phone: '0810000002', licenseType: 'ท.4', licenseExpiry: '2030-12-31', weeklyDaysOff: [0] });
  const ensureUser = async (username: string, roles: Role[], driverId: ObjectId | null) => {
    if (!(await findUserByUsername(db, username))) await createUser(db, { username, password: opts.password, roles, driverId });
  };
  await ensureUser('demo-admin', ['admin'], null);
  await ensureUser('demo-planner', ['planner'], null);
  await ensureUser('demo-driver1', ['driver'], d1);
  await ensureUser('demo-driver2', ['driver'], d2);
  const single = (await db.collection(C.serviceTypes).findOne({ code: 'SINGLE' }))!._id as ObjectId;
  if ((await db.collection(C.deliveryOrders).countDocuments({ clientRef: /^DEMO-/ })) === 0) {
    const plantId = plant;
    const dests = [(await db.collection(C.locations).findOne({ code: 'DEMO-SITE-BKK' }))!._id as ObjectId, kkn, kkn];
    for (const [i, dest] of dests.entries()) {
      const now2 = new Date();
      await db.collection(C.deliveryOrders).insertOne({
        doNo: await nextNumber(db, 'DO'), clientRef: `DEMO-${i + 1}`, clientId, jobGroupId: group!._id, jobGroupMatch: { status: 'manual', candidates: [group!._id] },
        serviceTypeId: single, materialId: readymix, intendedTruckTypeId: mixer, qty: 6, unit: 'm3', palletPlan: null,
        originLocationId: plantId, destLocationId: dest, pickupWindow: null, dropWindow: null, distance: { clientKm: null },
        shipmentId: null, pickupStopId: null, dropStopId: null, status: 'UNASSIGNED', note: null, cancelledAt: null, cancelReason: null,
        attempts: [], createdBy: 'seed', createdAt: now2, updatedBy: 'seed', updatedAt: now2,
      });
    }
  }

  // One shipment already DISPATCHED to demo-driver1 (a 4th DO, `DEMO-4`), so the phone app shows
  // a job the moment it's logged into — no planning steps needed for the first demo look. Built
  // as plain documents (not via `createShipment`/`transition`, which need a Fastify app this
  // script doesn't have); the shape mirrors what those services produce. Idempotent on `DEMO-4`.
  if (!(await db.collection(C.deliveryOrders).findOne({ clientRef: 'DEMO-4' }))) {
    const now2 = new Date();
    const bkkSite = (await db.collection(C.locations).findOne({ code: 'DEMO-SITE-BKK' }))!._id as ObjectId;
    const vehicle1 = (await db.collection(C.vehicles).findOne({ plateKey: plateKey('80-3001') }))!._id as ObjectId;
    const doId = new ObjectId();
    const pickupStopId = new ObjectId();
    const dropStopId = new ObjectId();
    await db.collection(C.deliveryOrders).insertOne({
      _id: doId,
      doNo: await nextNumber(db, 'DO'), clientRef: 'DEMO-4', clientId, jobGroupId: group!._id, jobGroupMatch: { status: 'manual', candidates: [group!._id] },
      serviceTypeId: single, materialId: readymix, intendedTruckTypeId: mixer, qty: 6, unit: 'm3', palletPlan: null,
      originLocationId: plant, destLocationId: bkkSite, pickupWindow: null, dropWindow: null, distance: { clientKm: null },
      shipmentId: null, pickupStopId: null, dropStopId: null, status: 'UNASSIGNED', note: null, cancelledAt: null, cancelReason: null,
      attempts: [], createdBy: 'seed', createdAt: now2, updatedBy: 'seed', updatedAt: now2,
    });
    const shipmentId = new ObjectId();
    const plannedStart = bangkokTodayAt(8);
    const plannedEnd = bangkokTodayAt(12);
    const stops = [
      { stopId: pickupStopId, seq: 1, locationId: plant, pickupDoIds: [doId], dropDoIds: [], plannedArrival: null, status: 'PENDING' as const },
      { stopId: dropStopId, seq: 2, locationId: bkkSite, pickupDoIds: [], dropDoIds: [doId], plannedArrival: null, status: 'PENDING' as const },
    ];
    await db.collection(C.shipments).insertOne({
      _id: shipmentId,
      shipmentNo: await nextNumber(db, 'SH'),
      status: 'DISPATCHED',
      version: 3,
      plannedStart, plannedEnd,
      head: { vehicleId: vehicle1, driverId: d1 }, tail: null,
      stops,
      legs: [{ fromStopId: pickupStopId, toStopId: dropStopId, loaded: true, doIds: [doId], mapKm: null, gpsKm: null }],
      warnings: [], note: 'Demo shipment — ready for demo-driver1',
      dispatch: { at: now2, by: 'seed', version: 3 }, driverResponse: null,
      cancelledAt: null, cancelReason: null,
      closedAt: null, closedBy: null, summaryId: null,
      createdBy: 'seed', createdAt: now2, updatedBy: 'seed', updatedAt: now2,
    });
    await db.collection(C.deliveryOrders).updateOne(
      { _id: doId },
      { $set: { status: 'PLANNED', shipmentId, pickupStopId, dropStopId, updatedAt: now2 } },
    );
  }
}
