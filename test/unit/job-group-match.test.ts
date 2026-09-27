import { describe, expect, it } from 'vitest';
import { type JobGroupCriteria, type MatchInput, matchJobGroup } from '../../src/modules/master/job-group-match.js';

const empty: JobGroupCriteria = { truckTypeIds: [], serviceTypeIds: [], siteIds: [], materialIds: [], originZoneIds: [], destZoneIds: [] };
const input: MatchInput = { truckTypeId: 'T1', serviceTypeId: 'S1', materialId: 'M1', siteIds: ['SITE1'], originZoneId: 'Z1', destZoneId: 'Z2' };

describe('matchJobGroup', () => {
  it('returns none when no group matches', () => {
    expect(matchJobGroup(input, [{ id: 'g1', criteria: { ...empty, materialIds: ['M9'] } }])).toEqual({ status: 'none', jobGroupId: null, candidates: [] });
  });

  it('an all-empty group matches anything', () => {
    expect(matchJobGroup(input, [{ id: 'g1', criteria: empty }])).toMatchObject({ status: 'auto', jobGroupId: 'g1' });
  });

  it('the most specific group wins', () => {
    const r = matchJobGroup(input, [
      { id: 'generic', criteria: { ...empty, materialIds: ['M1'] } },
      { id: 'specific', criteria: { ...empty, materialIds: ['M1'], destZoneIds: ['Z2'] } },
    ]);
    expect(r).toEqual({ status: 'auto', jobGroupId: 'specific', candidates: ['generic', 'specific'] });
  });

  it('equal specificity is ambiguous', () => {
    const r = matchJobGroup(input, [
      { id: 'b', criteria: { ...empty, materialIds: ['M1'] } },
      { id: 'a', criteria: { ...empty, serviceTypeIds: ['S1'] } },
    ]);
    expect(r).toEqual({ status: 'ambiguous', jobGroupId: null, candidates: ['a', 'b'] });
  });

  it('a truck-type criterion never matches an unknown truck type', () => {
    const r = matchJobGroup({ ...input, truckTypeId: null }, [{ id: 'g', criteria: { ...empty, truckTypeIds: ['T1'] } }]);
    expect(r.status).toBe('none');
  });

  it('site criterion matches when either end is a listed site', () => {
    expect(matchJobGroup(input, [{ id: 'g', criteria: { ...empty, siteIds: ['OTHER', 'SITE1'] } }]).status).toBe('auto');
    expect(matchJobGroup({ ...input, siteIds: [] }, [{ id: 'g', criteria: { ...empty, siteIds: ['SITE1'] } }]).status).toBe('none');
  });
});
