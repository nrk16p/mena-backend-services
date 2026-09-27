import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId, type Db } from 'mongodb';
import { z } from 'zod';
import { C } from '../../db/collections.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { objectIdString } from '../../lib/ids.js';
import { STAFF_ROLES } from '../../lib/roles.js';
import { type JobGroupCriteria, type MatchResult, matchJobGroup } from './job-group-match.js';
import type { ResourceDef } from './resource.js';
import { Code, Name } from './simple.js';

const ids = z.array(objectIdString).default([]);
const Criteria = z
  .object({ truckTypeIds: ids, serviceTypeIds: ids, siteIds: ids, materialIds: ids, originZoneIds: ids, destZoneIds: ids })
  .default({});

const JobGroupBody = z.object({ code: Code, name: Name, criteria: Criteria });
const JobGroupItem = z.object({
  clientId: z.string(),
  code: z.string(),
  name: z.string(),
  criteria: z.object({
    truckTypeIds: z.array(z.string()),
    serviceTypeIds: z.array(z.string()),
    siteIds: z.array(z.string()),
    materialIds: z.array(z.string()),
    originZoneIds: z.array(z.string()),
    destZoneIds: z.array(z.string()),
  }),
});

export const jobGroupsDef: ResourceDef = {
  name: 'jobGroup',
  path: '/clients/:clientId/job-groups',
  collection: C.jobGroups,
  body: JobGroupBody,
  item: JobGroupItem,
  parent: { param: 'clientId', field: 'clientId', collection: C.clients },
  refs: [
    { path: 'criteria.truckTypeIds', collection: C.truckTypes, many: true },
    { path: 'criteria.serviceTypeIds', collection: C.serviceTypes, many: true },
    { path: 'criteria.siteIds', collection: C.locations, many: true },
    { path: 'criteria.materialIds', collection: C.materials, many: true },
    { path: 'criteria.originZoneIds', collection: C.zones, many: true },
    { path: 'criteria.destZoneIds', collection: C.zones, many: true },
  ],
  searchFields: ['code', 'name'],
  validate: async (merged, { db }) => {
    const siteIds = ((merged.criteria as { siteIds?: ObjectId[] } | undefined)?.siteIds ?? []) as ObjectId[];
    if (siteIds.length === 0) return;
    const notSites = await db.collection(C.locations).countDocuments({ _id: { $in: siteIds }, isSite: { $ne: true } });
    if (notSites > 0) throw unprocessable('NOT_A_SITE', 'criteria.siteIds must reference locations marked isSite');
  },
};

export interface DoMatchFields {
  truckTypeId: ObjectId | null;
  serviceTypeId: ObjectId;
  materialId: ObjectId;
  originLocationId: ObjectId;
  destLocationId: ObjectId;
}

export type CriteriaDoc = { [K in keyof JobGroupCriteria]: ObjectId[] };

/** Lean shape of a `locations` document, as needed for job-group matching. */
export interface LocationLite {
  _id: ObjectId;
  isSite?: boolean;
  zoneId: ObjectId;
}

/** Lean shape of a `jobGroups` document, as needed for job-group matching. */
export interface JobGroupLite {
  _id: ObjectId;
  clientId: ObjectId;
  criteria: CriteriaDoc;
}

/**
 * Matches a DO against already-fetched locations/job-groups. Pulled out of `matchJobGroupForDo`
 * so batched callers (e.g. `refreshJobGroups`, which matches every DO of a shipment) can fetch
 * locations and job groups once with `$in` and match in memory, instead of re-querying per DO.
 */
export function matchJobGroupWithData(f: DoMatchFields, origin: LocationLite, dest: LocationLite, groups: JobGroupLite[]): MatchResult {
  const hex = (list: ObjectId[] = []) => list.map((i) => i.toHexString());
  return matchJobGroup(
    {
      truckTypeId: f.truckTypeId?.toHexString() ?? null,
      serviceTypeId: f.serviceTypeId.toHexString(),
      materialId: f.materialId.toHexString(),
      siteIds: [origin, dest].filter((l) => l.isSite === true).map((l) => l._id.toHexString()),
      originZoneId: origin.zoneId.toHexString(),
      destZoneId: dest.zoneId.toHexString(),
    },
    groups.map((g) => {
      const c = g.criteria;
      return {
        id: g._id.toHexString(),
        criteria: {
          truckTypeIds: hex(c.truckTypeIds),
          serviceTypeIds: hex(c.serviceTypeIds),
          siteIds: hex(c.siteIds),
          materialIds: hex(c.materialIds),
          originZoneIds: hex(c.originZoneIds),
          destZoneIds: hex(c.destZoneIds),
        },
      };
    }),
  );
}

export async function matchJobGroupForDo(db: Db, clientId: ObjectId, f: DoMatchFields): Promise<MatchResult> {
  const locs = await db
    .collection<LocationLite>(C.locations)
    .find({ _id: { $in: [f.originLocationId, f.destLocationId] } })
    .toArray();
  const origin = locs.find((l) => l._id.equals(f.originLocationId));
  const dest = locs.find((l) => l._id.equals(f.destLocationId));
  if (!origin || !dest) throw unprocessable('INVALID_REFERENCE', 'origin or destination location does not exist');
  const groups = await db.collection<JobGroupLite>(C.jobGroups).find({ clientId, active: true }).toArray();
  return matchJobGroupWithData(f, origin, dest, groups);
}

const MatchBody = z.object({
  truckTypeId: objectIdString.nullable().default(null),
  serviceTypeId: objectIdString,
  materialId: objectIdString,
  originLocationId: objectIdString,
  destLocationId: objectIdString,
});

const MatchResultSchema = z.object({
  status: z.enum(['auto', 'ambiguous', 'none']),
  jobGroupId: z.string().nullable(),
  candidates: z.array(z.string()),
});

export const jobGroupMatchRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/clients/:clientId/job-groups/match',
    {
      schema: { tags: ['jobGroup'], params: z.object({ clientId: objectIdString }), body: MatchBody, response: { 200: MatchResultSchema } },
      preHandler: app.requireRoles(...STAFF_ROLES),
    },
    async (req) => {
      const clientId = new ObjectId(req.params.clientId);
      if (!(await app.db.collection(C.clients).countDocuments({ _id: clientId }, { limit: 1 }))) throw notFound('client');
      const b = req.body;
      return matchJobGroupForDo(app.db, clientId, {
        truckTypeId: b.truckTypeId ? new ObjectId(b.truckTypeId) : null,
        serviceTypeId: new ObjectId(b.serviceTypeId),
        materialId: new ObjectId(b.materialId),
        originLocationId: new ObjectId(b.originLocationId),
        destLocationId: new ObjectId(b.destLocationId),
      });
    },
  );
};
