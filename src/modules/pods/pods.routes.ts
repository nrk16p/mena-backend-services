import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf } from '../../lib/audit.js';
import { toApi } from '../../lib/serialize.js';
import { driverIdOf } from '../shipments/driver-access.js';
import { PodInput, submitPod } from './pods.service.js';

/** API shape of `PodDoc` (ids as hex, dates as ISO strings). */
export const PodItem = z.object({
  id: z.string(),
  clientPodId: z.string(),
  doId: z.string(),
  shipmentId: z.string(),
  stopId: z.string(),
  templateId: z.string().nullable(),
  templateVersion: z.number(),
  outcome: z.enum(['DELIVERED', 'FAILED']),
  reasonCode: z.string().nullable(),
  note: z.string().nullable(),
  answers: z.record(z.unknown()),
  files: z.array(z.object({ fieldKey: z.string(), key: z.string(), sha256: z.string(), mime: z.string(), bytes: z.number() })),
  evidence: z.object({
    deviceTime: z.string(),
    receivedAt: z.string(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    accuracyM: z.number().nullable(),
    noGpsReason: z.string().nullable(),
    geofenceDistanceM: z.number().nullable(),
    device: z.string().nullable(),
    appVersion: z.string().nullable(),
    offline: z.boolean(),
  }),
  hash: z.string(),
  flags: z.array(z.string()),
  status: z.enum(['submitted', 'verified', 'rejected']),
  review: z.object({ by: z.string(), at: z.string(), reason: z.string().nullable() }).nullable(),
  supersedesPodId: z.string().nullable(),
  by: z.string(),
});

export const podRoutes: FastifyPluginAsyncZod = async (app) => {
  // 201 for a new POD; 200 with the stored POD when this clientPodId was already used (offline replay).
  app.post(
    '/driver/pods',
    { schema: { tags: ['driver'], body: PodInput, response: { 200: PodItem, 201: PodItem } }, preHandler: app.requireRoles('driver') },
    async (req, reply) => {
      const { pod, duplicate } = await submitPod(app, actorOf(req), driverIdOf(req), req.body);
      return reply.status(duplicate ? 200 : 201).send(toApi(pod));
    },
  );
};
