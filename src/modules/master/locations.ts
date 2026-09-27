import { z } from 'zod';
import { C } from '../../db/collections.js';
import { unprocessable } from '../../lib/errors.js';
import { objectIdString } from '../../lib/ids.js';
import type { ResourceDef } from './resource.js';
import { Code, Name } from './simple.js';

const LocationBody = z.object({
  code: Code,
  name: Name,
  clientId: objectIdString.nullable().default(null),
  zoneId: objectIdString,
  isSite: z.boolean().default(false),
  address: z.string().trim().max(500).nullable().default(null),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  geofenceRadiusM: z.number().int().min(50).max(5000).default(300),
});

const LocationItem = LocationBody.extend({ clientId: z.string().nullable(), zoneId: z.string() });

export const locationsDef: ResourceDef = {
  name: 'location',
  path: '/locations',
  collection: C.locations,
  body: LocationBody,
  item: LocationItem,
  refs: [
    { path: 'clientId', collection: C.clients },
    { path: 'zoneId', collection: C.zones },
  ],
  searchFields: ['code', 'name', 'address'],
  filterFields: [{ name: 'zoneId', ref: true }, { name: 'clientId', ref: true }, { name: 'isSite', boolean: true }],
  toDb: (body) => {
    const { lat, lng, ...rest } = body;
    if ((lat === undefined) !== (lng === undefined)) {
      throw unprocessable('LAT_LNG_PAIR', 'lat and lng must be provided together');
    }
    return lat === undefined ? rest : { ...rest, geo: { type: 'Point', coordinates: [lng, lat] } };
  },
  fromDb: (doc) => {
    const { geo, ...rest } = doc as { geo?: { coordinates: [number, number] } } & Record<string, unknown>;
    return geo ? { ...rest, lat: geo.coordinates[1], lng: geo.coordinates[0] } : rest;
  },
  validate: async (merged, { db, existing }) => {
    if (!existing || existing.isSite !== true || merged.isSite !== false) return;
    const used = await db.collection(C.jobGroups).countDocuments({ 'criteria.siteIds': existing._id }, { limit: 1 });
    if (used > 0) {
      throw unprocessable('LOCATION_USED_AS_SITE', 'This location is a site in a job group; remove it from the job group first');
    }
  },
};
