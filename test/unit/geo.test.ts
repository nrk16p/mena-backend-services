import { describe, expect, it } from 'vitest';
import { gpsFlags, haversineM } from '../../src/lib/geo.js';
import { GpsFields } from '../../src/lib/gps.js';

const t0 = new Date('2026-10-05T01:00:00Z');

describe('geo', () => {
  it('computes distances in metres', () => {
    const bkk = { lat: 13.7563, lng: 100.5018 };
    expect(haversineM(bkk, bkk)).toBe(0);
    expect(Math.round(haversineM(bkk, { lat: 13.7563, lng: 100.5118 }) / 10) * 10).toBe(1080);
  });

  it('flags missing GPS, low accuracy, outside geofence and late sync', () => {
    expect(gpsFlags({ lat: null, lng: null, accuracyM: null, deviceTime: t0, receivedAt: t0 })).toEqual({ flags: ['NO_GPS'], distanceM: null });
    const out = gpsFlags({
      lat: 13.76, lng: 100.52, accuracyM: 150, deviceTime: t0, receivedAt: new Date(t0.getTime() + 7 * 3600_000),
      target: { lat: 13.75, lng: 100.5, radiusM: 300 },
    });
    expect(out.flags.sort()).toEqual(['LATE_SYNC', 'LOW_ACCURACY', 'OUTSIDE_GEOFENCE']);
    expect(out.distanceM).toBeGreaterThan(2000);
    expect(gpsFlags({ lat: 13.75, lng: 100.5, accuracyM: 10, deviceTime: t0, receivedAt: t0, target: { lat: 13.75, lng: 100.5, radiusM: 300 } }).flags).toEqual([]);
  });

  it('respects exact boundaries for GPS flags', () => {
    // accuracyM === 100 should NOT trigger LOW_ACCURACY (boundary is >100)
    expect(gpsFlags({
      lat: 13.75, lng: 100.5, accuracyM: 100, deviceTime: t0, receivedAt: t0,
    }).flags).toEqual([]);

    // receivedAt − deviceTime === exactly 6 hours should NOT trigger LATE_SYNC (boundary is >6 hours)
    const t0Plus6h = new Date(t0.getTime() + 6 * 3600_000);
    expect(gpsFlags({
      lat: 13.75, lng: 100.5, accuracyM: 10, deviceTime: t0, receivedAt: t0Plus6h,
    }).flags).toEqual([]);

    // Distance equal to radius should NOT trigger OUTSIDE_GEOFENCE
    const bkk = { lat: 13.7563, lng: 100.5018 };
    const targetDist = haversineM(bkk, { lat: 13.7663, lng: 100.5018 });
    const atBoundary = gpsFlags({
      lat: bkk.lat, lng: bkk.lng, accuracyM: 10, deviceTime: t0, receivedAt: t0,
      target: { lat: 13.7663, lng: 100.5018, radiusM: targetDist },
    });
    expect(atBoundary.flags).toEqual([]);
    expect(atBoundary.distanceM).toBe(Math.round(targetDist));

    // Distance just beyond radius should trigger OUTSIDE_GEOFENCE
    const justBeyond = gpsFlags({
      lat: bkk.lat, lng: bkk.lng, accuracyM: 10, deviceTime: t0, receivedAt: t0,
      target: { lat: 13.7663, lng: 100.5018, radiusM: targetDist - 0.4 },
    });
    expect(justBeyond.flags).toContain('OUTSIDE_GEOFENCE');
    expect(justBeyond.distanceM).toBe(Math.round(targetDist));
  });

  it('validates GPS payloads', () => {
    const ok = GpsFields.safeParse({ lat: 13.7, lng: 100.5, accuracyM: 8, deviceTime: '2026-10-05T08:00:00+07:00' });
    expect(ok.success).toBe(true);
    expect(GpsFields.safeParse({ lat: null, lng: null, accuracyM: null, noGpsReason: 'NO_GPS', deviceTime: '2026-10-05T08:00:00+07:00' }).success).toBe(true);
    expect(GpsFields.safeParse({ lat: null, lng: null, accuracyM: null, deviceTime: '2026-10-05T08:00:00+07:00' }).success).toBe(false);
    expect(GpsFields.safeParse({ lat: 13.7, lng: null, accuracyM: 5, deviceTime: '2026-10-05T08:00:00+07:00' }).success).toBe(false);
    expect(GpsFields.safeParse({ lat: 13.7, lng: 100.5, accuracyM: null, deviceTime: '2026-10-05T08:00:00+07:00' }).success).toBe(false);
    expect(GpsFields.safeParse({ lat: null, lng: null, accuracyM: 12, noGpsReason: 'NO_GPS', deviceTime: '2026-10-05T08:00:00+07:00' }).success).toBe(false);
  });
});
