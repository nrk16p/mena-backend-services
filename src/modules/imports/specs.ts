import { C } from '../../db/collections.js';
import { driversDef, plateKey, vehiclesDef } from '../master/fleet.js';
import { locationsDef } from '../master/locations.js';
import type { ResourceDef } from '../master/resource.js';
import { clientsDef, materialsDef, serviceTypesDef, truckTypesDef, zonesDef } from '../master/simple.js';

export class RowError extends Error {}

export interface ImportCtx {
  idByCode(collection: string, code: string, column: string): Promise<string>;
}

type Get = (column: string) => string | undefined;

export interface ImportSpec {
  def: ResourceDef;
  key: 'code' | 'plate';
  // The DB field an existing document is looked up by. Usually the same as `key`, but
  // vehicles are matched on the stricter `plateKey` (see fleet.ts) rather than the
  // display-form `plate`.
  dbKey: string;
  keyOf(get: Get): string | undefined;
  toBody(get: Get, ctx: ImportCtx): Promise<Record<string, unknown>>;
}

export const IMPORT_ENTITIES = ['clients', 'zones', 'materials', 'service-types', 'truck-types', 'locations', 'vehicles', 'drivers'] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

function bool(v: string | undefined, column: string): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  throw new RowError(`${column}: expected yes/no, got "${v}"`);
}

function num(v: string | undefined, column: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new RowError(`${column}: expected a number, got "${v}"`);
  return n;
}

const byCode = (get: Get) => get('code');

const simple = (def: ResourceDef, extra: string[] = []): ImportSpec => ({
  def,
  key: 'code',
  dbKey: 'code',
  keyOf: byCode,
  toBody: async (get) => Object.fromEntries(['code', 'name', ...extra].map((c) => [c, get(c)])),
});

export const IMPORT_SPECS: Record<ImportEntity, ImportSpec> = {
  clients: simple(clientsDef),
  zones: simple(zonesDef),
  materials: simple(materialsDef, ['unit']),
  'service-types': simple(serviceTypesDef),
  'truck-types': simple(truckTypesDef, ['category']),
  locations: {
    def: locationsDef,
    key: 'code',
    dbKey: 'code',
    keyOf: byCode,
    toBody: async (get, ctx) => {
      const zoneCode = get('zoneCode');
      const clientCode = get('clientCode');
      return {
        code: get('code'),
        name: get('name'),
        zoneId: zoneCode === undefined ? undefined : await ctx.idByCode(C.zones, zoneCode, 'zoneCode'),
        clientId: clientCode === undefined ? undefined : await ctx.idByCode(C.clients, clientCode, 'clientCode'),
        isSite: bool(get('isSite'), 'isSite'),
        address: get('address'),
        lat: num(get('lat'), 'lat'),
        lng: num(get('lng'), 'lng'),
        geofenceRadiusM: num(get('geofenceRadiusM'), 'geofenceRadiusM'),
      };
    },
  },
  vehicles: {
    def: vehiclesDef,
    key: 'plate',
    dbKey: 'plateKey',
    keyOf: (get) => {
      const p = get('plate');
      return p === undefined ? undefined : plateKey(p);
    },
    toBody: async (get, ctx) => {
      const tt = get('truckTypeCode');
      return {
        plate: get('plate'),
        part: get('part'),
        truckTypeId: tt === undefined ? undefined : await ctx.idByCode(C.truckTypes, tt, 'truckTypeCode'),
        gpsVendor: get('gpsVendor'),
        gpsId: get('gpsId'),
      };
    },
  },
  drivers: simple(driversDef, ['phone', 'licenseType', 'licenseExpiry']),
};
