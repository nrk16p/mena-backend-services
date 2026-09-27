import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { type ResourceDef, resourceRoutes } from './resource.js';
import { clientsDef, materialsDef, palletMovementTypesDef, serviceTypesDef, truckTypesDef, zonesDef } from './simple.js';
import { driversDef, vehiclesDef } from './fleet.js';
import { locationsDef } from './locations.js';

export const ALL_RESOURCE_DEFS: ResourceDef[] = [
  clientsDef,
  zonesDef,
  materialsDef,
  serviceTypesDef,
  truckTypesDef,
  palletMovementTypesDef,
  locationsDef,
  vehiclesDef,
  driversDef,
];

export const masterRoutes: FastifyPluginAsyncZod = async (app) => {
  for (const def of ALL_RESOURCE_DEFS) await app.register(resourceRoutes(def));
};
