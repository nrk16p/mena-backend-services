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
  plate: z.string().trim().min(2).max(20),
  part: z.enum(VEHICLE_PARTS),
  truckTypeId: objectIdString,
  gpsVendor: z.string().trim().max(40).nullable().default(null),
  gpsId: z.string().trim().max(60).nullable().default(null),
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
  licenseExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').nullable().default(null),
  weeklyDaysOff: z.array(z.number().int().min(0).max(6)).max(7).default([]),
});

export const driversDef: ResourceDef = {
  name: 'driver',
  path: '/drivers',
  collection: C.drivers,
  body: DriverBody,
  item: DriverBody,
  searchFields: ['code', 'name', 'phone'],
};
