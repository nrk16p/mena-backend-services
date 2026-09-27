export interface Position {
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  noGpsReason: 'NO_GPS' | null;
}

export function getPosition(timeoutMs = 10_000): Promise<Position> {
  const none: Position = { lat: null, lng: null, accuracyM: null, noGpsReason: 'NO_GPS' };
  if (!('geolocation' in navigator)) return Promise.resolve(none);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy), noGpsReason: null }),
      () => resolve(none),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 15_000 },
    );
  });
}
