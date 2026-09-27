import { z } from 'zod';
import { C } from '../../db/collections.js';
import { unprocessable } from '../../lib/errors.js';
import type { ResourceDef } from '../master/resource.js';
import { Name } from '../master/simple.js';

export const LEVEL1 = ['working', 'not_working'] as const;
export type Level1 = (typeof LEVEL1)[number];
export const APPLIES_TO = ['vehicle', 'driver', 'both'] as const;
export type AppliesTo = (typeof APPLIES_TO)[number];

const StatusCodeBody = z.object({
  code: z.string().trim().min(1).max(20),
  name: Name,
  level1: z.enum(LEVEL1).describe('Whether a resource under this status is "working" (available) or "not_working" (unavailable) at a business level.'),
  appliesTo: z.enum(APPLIES_TO).describe('Which resource type this status code can be used for: "vehicle", "driver", or "both".'),
  blocksAssignment: z.boolean().default(false).describe('Whether a resource block using this code prevents assigning the resource to a shipment. Cannot be true when `level1` is "working".'),
});

export const statusCodesDef: ResourceDef = {
  name: 'statusCode',
  path: '/status-codes',
  collection: C.statusCodes,
  body: StatusCodeBody,
  item: StatusCodeBody,
  searchFields: ['code', 'name'],
  filterFields: [{ name: 'level1' }, { name: 'appliesTo' }],
  writeRoles: ['admin'],
  label: 'status code', labelTh: 'รหัสสถานะ',
  notes: 'A "working" (`level1`) status code cannot have `blocksAssignment: true` (422 `INVALID_STATUS_CODE`). Used by resource blocks (see /resource-blocks) to mark a vehicle or driver unavailable.',
  validate: async (merged) => {
    if (merged.level1 === 'working' && merged.blocksAssignment === true) {
      throw unprocessable('INVALID_STATUS_CODE', 'A working status cannot block assignment');
    }
  },
};

const HolidayBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').describe('Holiday date as `YYYY-MM-DD`.'),
  name: Name,
});

export const holidaysDef: ResourceDef = {
  name: 'holiday',
  path: '/holidays',
  collection: C.holidays,
  body: HolidayBody,
  item: HolidayBody,
  searchFields: ['name', 'date'],
  label: 'holiday', labelTh: 'วันหยุด',
};
