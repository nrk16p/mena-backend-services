import { z } from 'zod';
import { C } from '../../db/collections.js';
import { unprocessable } from '../../lib/errors.js';
import type { ResourceDef } from './resource.js';

export const Code = z.string().trim().min(1).max(40).describe('Short unique business code used to look this record up (e.g. in imports and integrations).');
export const Name = z.string().trim().min(1).max(200).describe('Display name shown to users.');

const codeName = z.object({ code: Code, name: Name });

export const clientsDef: ResourceDef = {
  name: 'client', path: '/clients', collection: C.clients,
  body: codeName, item: codeName, searchFields: ['code', 'name'],
  label: 'client', labelTh: 'ลูกค้า',
};

export const zonesDef: ResourceDef = {
  name: 'zone', path: '/zones', collection: C.zones,
  body: codeName, item: codeName, searchFields: ['code', 'name'],
  label: 'zone', labelTh: 'โซน',
};

const material = codeName.extend({ unit: z.string().trim().min(1).max(20).describe('Unit of measure for this material (e.g. "ton", "m3").') });
export const materialsDef: ResourceDef = {
  name: 'material', path: '/materials', collection: C.materials,
  body: material, item: material, searchFields: ['code', 'name'],
  label: 'material', labelTh: 'ชนิดสินค้า',
};

export const serviceTypesDef: ResourceDef = {
  name: 'serviceType', path: '/service-types', collection: C.serviceTypes,
  body: codeName, item: codeName, searchFields: ['code', 'name'],
  label: 'service type', labelTh: 'ประเภทบริการ',
};

export const TRUCK_CATEGORIES = ['tractor', 'rigid'] as const;
const truckType = codeName.extend({ category: z.enum(TRUCK_CATEGORIES).describe('Vehicle category this truck type is for: "tractor" (head/tail, articulated) or "rigid" (single-unit truck).') });
export const truckTypesDef: ResourceDef = {
  name: 'truckType', path: '/truck-types', collection: C.truckTypes,
  body: truckType, item: truckType, searchFields: ['code', 'name'], filterFields: [{ name: 'category' }],
  label: 'truck type', labelTh: 'ประเภทรถ',
  notes: 'The `category` cannot change while any vehicle still uses this truck type (422 `TRUCK_TYPE_IN_USE`).',
  validate: async (merged, { db, existing }) => {
    if (!existing || existing.category === merged.category) return;
    const inUse = await db.collection(C.vehicles).countDocuments({ truckTypeId: existing._id }, { limit: 1 });
    if (inUse > 0) {
      throw unprocessable('TRUCK_TYPE_IN_USE', 'The category cannot change while vehicles use this truck type');
    }
  },
};

const palletMovementType = codeName.extend({
  sign: z.union([z.literal(-1), z.literal(0), z.literal(1)]).describe('Effect on pallet balance when this movement type is used: -1 = pallets out, +1 = pallets in, 0 = no change to the balance.'),
});
export const palletMovementTypesDef: ResourceDef = {
  name: 'palletMovementType', path: '/pallet-movement-types', collection: C.palletMovementTypes,
  body: palletMovementType, item: palletMovementType, searchFields: ['code', 'name'], writeRoles: ['admin'],
  label: 'pallet movement type', labelTh: 'ประเภทการเคลื่อนไหวพาเลท',
};
