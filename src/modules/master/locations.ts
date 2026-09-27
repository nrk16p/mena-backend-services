import { z } from 'zod';
import { C } from '../../db/collections.js';
import { unprocessable } from '../../lib/errors.js';
import { objectIdString } from '../../lib/ids.js';
import type { ResourceDef } from './resource.js';
import { Code, Name } from './simple.js';

const LocationBody = z.object({
  code: Code,
  name: Name,
  clientId: objectIdString.nullable().default(null).describe('Owning client, or null for a location shared across clients.'),
  zoneId: objectIdString.describe('Zone (โซน) this location belongs to; used for job-group and pricing zone matching.'),
  isSite: z.boolean().default(false).describe('Whether this location can be used as a "site" criterion in job-group matching (see /clients/{clientId}/job-groups). Cannot be unset while a job group still references it as a site.'),
  address: z.string().trim().max(500).nullable().default(null),
  lat: z.number().min(-90).max(90).describe('Latitude in decimal degrees; must be provided together with `lng`.'),
  lng: z.number().min(-180).max(180).describe('Longitude in decimal degrees; must be provided together with `lat`.'),
  geofenceRadiusM: z.number().int().min(50).max(5000).default(300).describe('Radius in meters around (lat, lng) used to detect arrival/departure at this location.'),
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
  label: 'location', labelTh: 'สถานที่',
  notes: '`lat`/`lng` must be provided together (422 `LAT_LNG_PAIR`). A location cannot have `isSite` cleared while a job group still uses it in `criteria.siteIds` (422 `LOCATION_USED_AS_SITE`).',
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
