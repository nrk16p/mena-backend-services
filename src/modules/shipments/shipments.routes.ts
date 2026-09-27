import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ObjectId } from 'mongodb';
import { ValidateBody, ValidateResponse } from './shipment.schemas.js';
import { toDraft, validateShipment } from './shipment.validation.js';

export const shipmentRoutes: FastifyPluginAsyncZod = async (app) => {
  const write = app.requireRoles('admin', 'planner');

  app.post('/shipments/validate', { schema: { tags: ['shipments'], body: ValidateBody, response: { 200: ValidateResponse } }, preHandler: write }, async (req) => {
    const { shipmentId, mode, ...input } = req.body;
    const draft = await toDraft(app.db, input);
    const result = await validateShipment(app.db, draft, { shipmentId: shipmentId ? new ObjectId(shipmentId) : undefined, mode });
    return {
      errors: result.errors,
      warnings: result.warnings,
      stops: draft.stops.map((s) => ({ ...s, plannedArrival: s.plannedArrival?.toISOString() ?? null })),
      legs: result.legs,
    };
  });
};
