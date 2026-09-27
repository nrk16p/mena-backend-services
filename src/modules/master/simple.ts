import { z } from 'zod';
import { C } from '../../db/collections.js';
import type { ResourceDef } from './resource.js';

export const Code = z.string().trim().min(1).max(40);
export const Name = z.string().trim().min(1).max(200);

const codeName = z.object({ code: Code, name: Name });

export const clientsDef: ResourceDef = {
  name: 'client', path: '/clients', collection: C.clients,
  body: codeName, item: codeName, searchFields: ['code', 'name'],
};

export const zonesDef: ResourceDef = {
  name: 'zone', path: '/zones', collection: C.zones,
  body: codeName, item: codeName, searchFields: ['code', 'name'],
};

const material = codeName.extend({ unit: z.string().trim().min(1).max(20) });
export const materialsDef: ResourceDef = {
  name: 'material', path: '/materials', collection: C.materials,
  body: material, item: material, searchFields: ['code', 'name'],
};

export const serviceTypesDef: ResourceDef = {
  name: 'serviceType', path: '/service-types', collection: C.serviceTypes,
  body: codeName, item: codeName, searchFields: ['code', 'name'],
};

export const TRUCK_CATEGORIES = ['tractor', 'rigid'] as const;
const truckType = codeName.extend({ category: z.enum(TRUCK_CATEGORIES) });
export const truckTypesDef: ResourceDef = {
  name: 'truckType', path: '/truck-types', collection: C.truckTypes,
  body: truckType, item: truckType, searchFields: ['code', 'name'], filterFields: [{ name: 'category' }],
};

const palletMovementType = codeName.extend({ sign: z.union([z.literal(-1), z.literal(0), z.literal(1)]) });
export const palletMovementTypesDef: ResourceDef = {
  name: 'palletMovementType', path: '/pallet-movement-types', collection: C.palletMovementTypes,
  body: palletMovementType, item: palletMovementType, searchFields: ['code', 'name'], writeRoles: ['admin'],
};
