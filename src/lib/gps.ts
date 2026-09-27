import { z } from 'zod';

export const GpsFields = z
  .object({
    lat: z.number().min(-90).max(90).nullable().describe('Device latitude at the moment of this action; null only when no fix was available (send noGpsReason "NO_GPS" in that case).'),
    lng: z.number().min(-180).max(180).nullable().describe('Device longitude; must be set together with lat, or both null.'),
    accuracyM: z.number().min(0).nullable().describe('Reported GPS accuracy radius in metres; must be sent together with a position. Above 100m flags LOW_ACCURACY.'),
    noGpsReason: z.literal('NO_GPS').nullable().default(null).describe('Set to "NO_GPS" when lat/lng could not be obtained; required whenever lat/lng are null.'),
    deviceTime: z.string().datetime({ offset: true }).describe('When this happened on the phone (ISO-8601 with offset), which may differ from server receipt time — a large gap flags LATE_SYNC.'),
  })
  .refine((g) => (g.lat === null) === (g.lng === null), { message: 'lat and lng must both be set or both be null', path: ['lat'] })
  .refine((g) => (g.lat === null) === (g.accuracyM === null), { message: 'accuracyM must be sent with a position and be null without one', path: ['accuracyM'] })
  .refine((g) => g.lat !== null || g.noGpsReason === 'NO_GPS', { message: 'send noGpsReason "NO_GPS" when the position is missing', path: ['noGpsReason'] });

export type GpsInput = z.infer<typeof GpsFields>;
