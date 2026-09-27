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
  .object({
    truckTypeIds: ids.describe('Truck types this job group applies to; empty = any truck type.'),
    serviceTypeIds: ids.describe('Service types this job group applies to; empty = any service type.'),
    siteIds: ids.describe('Locations (must have `isSite: true`) this job group applies to; empty = any site. A delivery order matches if either its origin or destination is one of these sites.'),
    materialIds: ids.describe('Materials this job group applies to; empty = any material.'),
    originZoneIds: ids.describe('Origin zones this job group applies to; empty = any origin zone.'),
    destZoneIds: ids.describe('Destination zones this job group applies to; empty = any destination zone.'),
  })
  .default({})
  .describe(
    'Matching criteria (จับคู่กลุ่มงาน): each non-empty list is an OR-of-allowed-values filter, and all non-empty lists must match (AND) for a delivery order to hit this job group. ' +
      'When several job groups match the same order, the one with the most non-empty criteria lists (highest specificity) wins; a tie is reported as ambiguous.',
  );

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
  label: 'job group', labelTh: 'กลุ่มงาน',
  notes: 'Every id in `criteria.siteIds` must reference a location with `isSite: true` (422 `NOT_A_SITE`). See `POST /clients/{clientId}/job-groups/match` for how criteria are matched against a delivery order.',
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
  status: z.enum(['auto', 'ambiguous', 'none']).describe(
    '"auto": exactly one job group had the highest specificity and was picked; "ambiguous": two or more job groups tied for highest specificity, a planner must pick one from `candidates`; "none": no job group matched.',
  ),
  jobGroupId: z.string().nullable().describe('The matched job group id when `status` is "auto", otherwise null.'),
  candidates: z.array(z.string()).describe('For "auto": every job group that matched (winner included). For "ambiguous": only the job groups tied at the highest specificity. For "none": empty.'),
});

export const jobGroupMatchRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/clients/:clientId/job-groups/match',
    {
      schema: {
        tags: ['jobGroup'],
        summary: 'Match a delivery order to a job group',
        description:
          'Finds which job group (กลุ่มงาน) of this client matches the given truck type/service type/material/origin/destination combination, using the same criteria matching applied when delivery orders are created. ' +
          'The job group with the most non-empty matching criteria wins (see `status`); a tie is reported as "ambiguous". Returns 404 `NOT_FOUND` if the client does not exist. Requires role admin, planner, or viewer.',
        params: z.object({ clientId: objectIdString }),
        body: MatchBody,
        response: { 200: MatchResultSchema },
      },
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
