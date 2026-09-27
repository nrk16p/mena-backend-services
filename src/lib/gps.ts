import { z } from 'zod';

export const GpsFields = z
  .object({
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
    accuracyM: z.number().min(0).nullable(),
    noGpsReason: z.literal('NO_GPS').nullable().default(null),
    deviceTime: z.string().datetime({ offset: true }),
  })
  .refine((g) => (g.lat === null) === (g.lng === null), { message: 'lat and lng must both be set or both be null', path: ['lat'] })
  .refine((g) => (g.lat === null) === (g.accuracyM === null), { message: 'accuracyM must be sent with a position and be null without one', path: ['accuracyM'] })
  .refine((g) => g.lat !== null || g.noGpsReason === 'NO_GPS', { message: 'send noGpsReason "NO_GPS" when the position is missing', path: ['noGpsReason'] });

export type GpsInput = z.infer<typeof GpsFields>;
