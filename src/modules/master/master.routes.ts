import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { type ResourceDef, resourceRoutes } from './resource.js';
import { clientsDef, materialsDef, palletMovementTypesDef, serviceTypesDef, truckTypesDef, zonesDef } from './simple.js';

export const ALL_RESOURCE_DEFS: ResourceDef[] = [
  clientsDef,
  zonesDef,
  materialsDef,
  serviceTypesDef,
  truckTypesDef,
  palletMovementTypesDef,
];

export const masterRoutes: FastifyPluginAsyncZod = async (app) => {
  for (const def of ALL_RESOURCE_DEFS) await app.register(resourceRoutes(def));
};
