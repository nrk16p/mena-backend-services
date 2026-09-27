export type GpsState = 'granted' | 'prompt' | 'denied' | 'unsupported';

export async function gpsState(): Promise<GpsState> {
  if (!('geolocation' in navigator)) return 'unsupported';
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    return (status?.state as GpsState | undefined) ?? 'prompt';
  } catch {
    return 'prompt';
  }
}
