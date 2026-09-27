import multipart from '@fastify/multipart';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf } from '../../lib/audit.js';
import { badRequest } from '../../lib/errors.js';
import { runImport } from './imports.service.js';
import { parseTable } from './parse.js';
import { IMPORT_ENTITIES } from './specs.js';

const ReportSchema = z.object({
  entity: z.enum(IMPORT_ENTITIES),
  dryRun: z.boolean(),
  total: z.number(),
  created: z.number(),
  updated: z.number(),
  errors: z.number(),
  rows: z.array(z.object({ row: z.number(), key: z.string().nullable(), action: z.enum(['create', 'update', 'error']), errors: z.array(z.string()) })),
});

export const importRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

  app.post(
    '/imports/:entity',
    {
      schema: {
        tags: ['imports'],
        consumes: ['multipart/form-data'],
        params: z.object({ entity: z.enum(IMPORT_ENTITIES) }),
        querystring: z.object({ dryRun: z.enum(['true', 'false']).default('true') }),
        response: { 200: ReportSchema },
      },
      preHandler: app.requireRoles('admin', 'planner'),
    },
    async (req) => {
      const file = await req.file();
      if (!file) throw badRequest('FILE_REQUIRED', 'Attach the file in the "file" form field');
      const rows = await parseTable(await file.toBuffer(), file.filename);
      return runImport(app.mongo, app.db, req.params.entity, rows, { dryRun: req.query.dryRun === 'true', by: actorOf(req) });
    },
  );
};
