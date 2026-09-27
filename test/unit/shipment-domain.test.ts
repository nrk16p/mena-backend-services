import { describe, expect, it } from 'vitest';
import { buildStopsFromDos, deriveLegs, structuralIssues } from '../../src/modules/shipments/shipment.domain.js';

const r = (id: string, o: string, d: string) => ({ id, originLocationId: o, destLocationId: d });

describe('buildStopsFromDos', () => {
  it('chains sequential legs A→B, B→C, C→D', () => {
    const stops = buildStopsFromDos([r('1', 'A', 'B'), r('2', 'B', 'C'), r('3', 'C', 'D')]);
    expect(stops.map((s) => s.locationId)).toEqual(['A', 'B', 'C', 'D']);
    expect(stops[1]).toEqual({ locationId: 'B', pickupDoIds: ['2'], dropDoIds: ['1'] });
  });

  it('co-loads DOs with the same origin', () => {
    const stops = buildStopsFromDos([r('1', 'A', 'B'), r('2', 'A', 'C')]);
    expect(stops.map((s) => s.locationId)).toEqual(['A', 'B', 'C']);
    expect(stops[0]!.pickupDoIds).toEqual(['1', '2']);
  });

  it('handles a return leg to the start', () => {
    expect(buildStopsFromDos([r('1', 'A', 'B'), r('2', 'B', 'A')]).map((s) => s.locationId)).toEqual(['A', 'B', 'A']);
  });
});

describe('deriveLegs', () => {
  it('tracks what is on board and marks empty legs', () => {
    const legs = deriveLegs([
      { locationId: 'A', pickupDoIds: ['1', '2'], dropDoIds: [] },
      { locationId: 'B', pickupDoIds: [], dropDoIds: ['1'] },
      { locationId: 'C', pickupDoIds: [], dropDoIds: ['2'] },
      { locationId: 'D', pickupDoIds: ['3'], dropDoIds: [] },
      { locationId: 'E', pickupDoIds: [], dropDoIds: ['3'] },
    ]);
    expect(legs.map((l) => [l.doIds, l.loaded])).toEqual([
      [['1', '2'], true],
      [['2'], true],
      [[], false],
      [['3'], true],
    ]);
  });
});

describe('structuralIssues', () => {
  it('accepts a valid route', () => {
    const dos = [r('1', 'A', 'B')];
    const out = structuralIssues(buildStopsFromDos(dos), dos);
    expect(out).toEqual({ errors: [], warnings: [] });
  });

  it('flags drop before pickup, wrong locations, missing and duplicated DOs', () => {
    const dos = [r('1', 'A', 'B'), r('2', 'A', 'C'), r('3', 'C', 'D')];
    const { errors } = structuralIssues(
      [
        { locationId: 'B', pickupDoIds: [], dropDoIds: ['1'] },
        { locationId: 'A', pickupDoIds: ['1', '2'], dropDoIds: [] },
        { locationId: 'D', pickupDoIds: [], dropDoIds: ['2', '3'] },
        { locationId: 'D', pickupDoIds: [], dropDoIds: ['3'] },
      ],
      dos,
    );
    const codes = errors.map((e) => e.code).sort();
    expect(codes).toEqual(['DO_DUPLICATED', 'DO_PICKUP_MISSING', 'DROP_BEFORE_PICKUP', 'DROP_LOCATION_MISMATCH']);
  });

  it('warns about two consecutive stops at the same place', () => {
    const dos = [r('1', 'A', 'B')];
    const { warnings } = structuralIssues(
      [
        { locationId: 'A', pickupDoIds: ['1'], dropDoIds: [] },
        { locationId: 'A', pickupDoIds: [], dropDoIds: [] },
        { locationId: 'B', pickupDoIds: [], dropDoIds: ['1'] },
      ],
      dos,
    );
    expect(warnings.map((w) => w.code)).toEqual(['ADJACENT_SAME_LOCATION']);
  });
});
