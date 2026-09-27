import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { unprocessable } from '../../lib/errors.js';
import { objectIdString } from '../../lib/ids.js';
import type { ResourceDef } from './resource.js';
import { Code, Name } from './simple.js';

export function normalizePlate(p: string): string {
  return p.trim().replace(/\s+/g, ' ').toUpperCase();
}

// A stricter matching key than the display-form `plate`: strips all whitespace, '-'
// and '.' so visually-equivalent plates entered with different separators
// (`1กข1234` / `1กข 1234` / `1กข-1234`) collide as the same vehicle.
export function plateKey(p: string): string {
  return normalizePlate(p).replace(/[\s\-.]/g, '');
}

export const VEHICLE_PARTS = ['head', 'tail', 'rigid'] as const;

const VehicleBody = z.object({
  plate: z.string().trim().min(2).max(20).describe('License plate as entered by staff; normalized (uppercased, whitespace collapsed) and also matched loosely (ignoring spaces/"-"/".") against existing vehicles to catch duplicates.'),
  part: z.enum(VEHICLE_PARTS).describe('Physical unit this record represents: "head" or "tail" of an articulated (tractor) truck, or "rigid" for a single-unit truck. Must agree with the linked truck type\'s category.'),
  truckTypeId: objectIdString.describe('Id of the truck type (see /truck-types); its category (tractor/rigid) must match `part`.'),
  gpsVendor: z.string().trim().max(40).nullable().default(null).describe('GPS tracking vendor key for this vehicle, if any (used to route location updates), otherwise null.'),
  gpsId: z.string().trim().max(60).nullable().default(null).describe('Vehicle identifier as known to the GPS vendor, otherwise null.'),
});

export const vehiclesDef: ResourceDef = {
  name: 'vehicle',
  path: '/vehicles',
  collection: C.vehicles,
  body: VehicleBody,
  item: VehicleBody.extend({ truckTypeId: z.string() }),
  refs: [{ path: 'truckTypeId', collection: C.truckTypes }],
  searchFields: ['plate', 'gpsId'],
  filterFields: [{ name: 'part' }, { name: 'truckTypeId', ref: true }],
  label: 'vehicle', labelTh: 'รถ',
  notes: '`part` must match the linked truck type\'s category ("rigid" part <-> "rigid" truck type, "head"/"tail" <-> "tractor" truck type), otherwise 422 `PART_CATEGORY_MISMATCH`.',
  toDb: (body) =>
    typeof body.plate === 'string' ? { ...body, plate: normalizePlate(body.plate), plateKey: plateKey(body.plate) } : body,
  validate: async (merged, { db }) => {
    const tt = await db.collection(C.truckTypes).findOne({ _id: merged.truckTypeId as ObjectId });
    const isRigidPart = merged.part === 'rigid';
    const isRigidType = tt?.category === 'rigid';
    if (isRigidPart !== isRigidType) {
      throw unprocessable('PART_CATEGORY_MISMATCH', `A ${String(merged.part)} vehicle cannot use a ${String(tt?.category)} truck type`);
    }
  },
};

const DriverBody = z.object({
  code: Code,
  name: Name,
  phone: z.string().trim().max(30).nullable().default(null),
  licenseType: z.string().trim().max(30).nullable().default(null),
  licenseExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').nullable().default(null).describe('Driving license expiry date as `YYYY-MM-DD`, or null if not tracked.'),
  weeklyDaysOff: z.array(z.number().int().min(0).max(6)).max(7).default([]).describe('Recurring days off each week, as 0 (Sunday) through 6 (Saturday); used when checking driver availability.'),
});

export const driversDef: ResourceDef = {
  name: 'driver',
  tag: 'driver-profile',
  path: '/drivers',
  collection: C.drivers,
  body: DriverBody,
  item: DriverBody,
  searchFields: ['code', 'name', 'phone'],
  label: 'driver', labelTh: 'พนักงานขับรถ',
};
