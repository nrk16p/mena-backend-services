const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const LATE_SYNC_MS = 6 * 3600_000;
export const LOW_ACCURACY_M = 100;

export function gpsFlags(i: {
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  deviceTime: Date;
  receivedAt: Date;
  target?: { lat: number; lng: number; radiusM: number };
}): { flags: string[]; distanceM: number | null } {
  const flags: string[] = [];
  let distanceM: number | null = null;
  if (i.lat === null || i.lng === null) flags.push('NO_GPS');
  else {
    if (i.accuracyM !== null && i.accuracyM > LOW_ACCURACY_M) flags.push('LOW_ACCURACY');
    if (i.target) {
      distanceM = Math.round(haversineM({ lat: i.lat, lng: i.lng }, i.target));
      if (distanceM > i.target.radiusM) flags.push('OUTSIDE_GEOFENCE');
    }
  }
  if (i.receivedAt.getTime() - i.deviceTime.getTime() > LATE_SYNC_MS) flags.push('LATE_SYNC');
  return { flags, distanceM };
}
