export interface JobGroupCriteria {
  truckTypeIds: string[];
  serviceTypeIds: string[];
  siteIds: string[];
  materialIds: string[];
  originZoneIds: string[];
  destZoneIds: string[];
}

export interface MatchInput {
  truckTypeId: string | null;
  serviceTypeId: string;
  materialId: string;
  siteIds: string[];
  originZoneId: string;
  destZoneId: string;
}

export interface MatchableGroup {
  id: string;
  criteria: JobGroupCriteria;
}

export type MatchResult =
  | { status: 'auto'; jobGroupId: string; candidates: string[] }
  | { status: 'ambiguous'; jobGroupId: null; candidates: string[] }
  | { status: 'none'; jobGroupId: null; candidates: [] };

const allows = (list: string[], value: string | null) => list.length === 0 || (value !== null && list.includes(value));

function matches(c: JobGroupCriteria, i: MatchInput): boolean {
  return (
    allows(c.truckTypeIds, i.truckTypeId) &&
    allows(c.serviceTypeIds, i.serviceTypeId) &&
    allows(c.materialIds, i.materialId) &&
    allows(c.originZoneIds, i.originZoneId) &&
    allows(c.destZoneIds, i.destZoneId) &&
    (c.siteIds.length === 0 || i.siteIds.some((s) => c.siteIds.includes(s)))
  );
}

function specificity(c: JobGroupCriteria): number {
  return Object.values(c).filter((list) => list.length > 0).length;
}

export function matchJobGroup(input: MatchInput, groups: MatchableGroup[]): MatchResult {
  const hits = groups.filter((g) => matches(g.criteria, input));
  if (hits.length === 0) return { status: 'none', jobGroupId: null, candidates: [] };
  const candidates = hits.map((g) => g.id).sort();
  const best = Math.max(...hits.map((g) => specificity(g.criteria)));
  const top = hits.filter((g) => specificity(g.criteria) === best);
  if (top.length === 1) return { status: 'auto', jobGroupId: top[0]!.id, candidates };
  return { status: 'ambiguous', jobGroupId: null, candidates: top.map((g) => g.id).sort() };
}
