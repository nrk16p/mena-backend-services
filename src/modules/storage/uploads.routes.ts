import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { AppError, notFound, unprocessable } from '../../lib/errors.js';
import { objectIdString } from '../../lib/ids.js';
import { driverIdOf, loadDriverShipment } from '../shipments/driver-access.js';
import { doIdsOf } from '../shipments/shipment.service.js';
import type { ShipmentStatus } from '../shipments/shipment.types.js';
import { UPLOAD_TYPES, type UploadType, verifyLocalSignature } from './storage.js';

export const ACTIVE_FOR_UPLOAD: ShipmentStatus[] = ['ACCEPTED', 'IN_TRANSIT', 'COMPLETED'];

export const uploadRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/uploads/presign',
    {
      schema: {
        tags: ['driver'],
        body: z.object({
          shipmentId: objectIdString,
          doId: objectIdString,
          contentType: z.enum(Object.keys(UPLOAD_TYPES) as [UploadType, ...UploadType[]]),
        }),
        response: {
          200: z.object({
            key: z.string(),
            url: z.string(),
            method: z.literal('PUT'),
            headers: z.object({ 'Content-Type': z.string() }),
            expiresInSec: z.number(),
            maxBytes: z.number(),
          }),
        },
      },
      preHandler: app.requireRoles('driver'),
    },
    async (req) => {
      const shipment = await loadDriverShipment(app.db, new ObjectId(req.body.shipmentId), driverIdOf(req));
      const doId = req.body.doId.toLowerCase();
      if (!doIdsOf(shipment.stops).some((id) => id.toHexString() === doId)) throw notFound('Delivery order');
      if (!ACTIVE_FOR_UPLOAD.includes(shipment.status)) {
        throw unprocessable('SHIPMENT_NOT_ACTIVE', `Uploads are not allowed for a ${shipment.status} shipment`);
      }
      // `shipment._id`/`doId` are normalised (lowercase hex) here rather than trusting the
      // request body verbatim, since `objectIdString` accepts uppercase hex too.
      const key = `pods/${shipment._id.toHexString()}/${doId}/${randomUUID()}.${UPLOAD_TYPES[req.body.contentType]}`;
      const expiresInSec = 300;
      return {
        key,
        url: await app.storage.presignPut(key, req.body.contentType, expiresInSec),
        method: 'PUT' as const,
        headers: { 'Content-Type': req.body.contentType },
        expiresInSec,
        maxBytes: app.config.UPLOAD_MAX_BYTES,
      };
    },
  );

  // Local upload links (memory storage only) so the browser demo works without Spaces keys.
  if (app.config.STORAGE_DRIVER === 'memory') {
    const LocalQuery = z.object({ key: z.string().min(1), exp: z.string(), sig: z.string() });
    const localRoutes: FastifyPluginAsyncZod = async (local) => {
      local.addContentTypeParser(/^(image|application)\//, { parseAs: 'buffer', bodyLimit: app.config.UPLOAD_MAX_BYTES }, (_req, body, done) => done(null, body));

      local.put('/uploads/local', { schema: { hide: true, querystring: LocalQuery } }, async (req, reply) => {
        const contentType = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
        if (!contentType || !(contentType in UPLOAD_TYPES)) {
          throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', `Content type must be one of: ${Object.keys(UPLOAD_TYPES).join(', ')}`);
        }
        // The signature is bound to method + content type, so a GET link (or a link signed for a
        // different content type) can't be replayed here even if it's otherwise well-formed.
        if (!verifyLocalSignature(app.config.JWT_SECRET, 'PUT', req.query.key, req.query.exp, req.query.sig, contentType)) {
          throw new AppError(403, 'INVALID_SIGNATURE', 'The upload link is invalid or expired');
        }
        const body = req.body as Buffer;
        await app.storage.put(req.query.key, body, contentType);
        return reply.status(204).send();
      });

      local.get('/uploads/local', { schema: { hide: true, querystring: LocalQuery } }, async (req, reply) => {
        if (!verifyLocalSignature(app.config.JWT_SECRET, 'GET', req.query.key, req.query.exp, req.query.sig)) {
          throw new AppError(403, 'INVALID_SIGNATURE', 'The upload link is invalid or expired');
        }
        const obj = await app.storage.get(req.query.key);
        if (!obj) throw notFound('File');
        return reply
          .header('content-type', obj.contentType)
          .header('x-content-type-options', 'nosniff')
          // Photos served back to a browser must never execute as HTML/script: sandbox them.
          .header('content-security-policy', 'sandbox')
          .send(obj.body);
      });
    };
    await app.register(localRoutes);
  }
};
