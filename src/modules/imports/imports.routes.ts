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
  dryRun: z.boolean().describe('Whether this run only validated the file (true) or actually wrote the changes (false).'),
  total: z.number().describe('Number of data rows parsed from the file.'),
  created: z.number(),
  updated: z.number(),
  errors: z.number().describe('Number of rows with validation errors; if greater than 0 and `dryRun` was false, nothing was written (422 `IMPORT_HAS_ERRORS`).'),
  rows: z.array(
    z.object({
      row: z.number().describe('1-based row number in the source file (excluding the header).'),
      key: z.string().nullable().describe('The row\'s business key (code, or normalized plate for vehicles), or null if it could not be read.'),
      action: z.enum(['create', 'update', 'error']).describe('What this row would do / did: "create" a new record, "update" an existing one matched by key, or "error" (see `errors`).'),
      errors: z.array(z.string()).describe('Human-readable validation error messages for this row, empty when `action` is not "error".'),
    }),
  ),
});

export const importRoutes: FastifyPluginAsyncZod = async (app) => {
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

  app.post(
    '/imports/:entity',
    {
      schema: {
        tags: ['imports'],
        summary: 'Bulk import master data from a file',
        description:
          'Uploads a CSV/Excel file (multipart form field `file`, max 5MB, header-based columns) of one master-data entity (client/zone/material/service type/truck type/location/vehicle/driver) and creates or updates ' +
          'records by business key (code, or normalized plate for vehicles). Runs as `dryRun=true` by default (validates only, writes nothing); pass `?dryRun=false` to commit, which happens in one transaction and is all-or-nothing — ' +
          'if any row has errors nothing is written (422 `IMPORT_HAS_ERRORS`). Fails with 400 `FILE_REQUIRED` if no file is attached. Requires role admin or planner.',
        consumes: ['multipart/form-data'],
        params: z.object({ entity: z.enum(IMPORT_ENTITIES) }),
        querystring: z.object({ dryRun: z.enum(['true', 'false']).default('true').describe('"true" (default) validates only; "false" commits the create/update writes.') }),
        response: { 200: ReportSchema },
      },
      preHandler: app.requireRoles('admin', 'planner'),
    },
    async (req) => {
      const file = await req.file();
      if (!file) throw badRequest('FILE_REQUIRED', 'Attach the file in the "file" form field');
      const rows = await parseTable(await file.toBuffer(), file.filename);
      return runImport(app.mongo, app.db, req.params.entity, rows, {
        dryRun: req.query.dryRun === 'true',
        by: actorOf(req),
        batchTimeoutMs: app.config.MONGO_BATCH_TIMEOUT_MS,
      });
    },
  );
};
