import { z } from 'zod';
import { objectIdString } from '../../lib/ids.js';

export const POD_FIELD_TYPES = ['photo', 'signature', 'text', 'number', 'select', 'checkbox', 'qtyLines', 'palletLines'] as const;
export const EXTRA_STEPS = ['DOCS_SUBMITTED', 'DOCS_RETURNED', 'SEAL_CHECKED', 'TEMP_CHECKED'] as const;

export const PodFieldSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/, 'key must be camelCase letters/digits, starting with a lowercase letter').describe('Unique machine key for this field within the template (camelCase); the driver\'s POD submission answers are keyed by this.'),
    label: z.string().trim().min(1).max(200).describe('Label shown to the driver for this field.'),
    type: z.enum(POD_FIELD_TYPES).describe('Input type: photo, signature, free text, number, single-select, checkbox, quantity lines (qtyLines), or pallet lines (palletLines).'),
    required: z.boolean().default(false).describe('Whether the driver must answer this field before submitting the POD.'),
    min: z.number().optional().describe('Minimum allowed value for a "number" field; must be <= `max` when both are set.'),
    max: z.number().optional().describe('Maximum allowed value for a "number" field.'),
    unit: z.string().trim().max(20).optional().describe('Unit label shown next to a "number" field, e.g. "kg".'),
    options: z.array(z.string().trim().min(1)).optional().describe('Choices for a "select" field; required (at least one) when `type` is "select".'),
  })
  .superRefine((f, ctx) => {
    if (f.type === 'select' && !f.options?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'select fields need at least one option' });
    }
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['min'], message: 'min must be <= max' });
    }
  });

export type PodField = z.infer<typeof PodFieldSchema>;

export const PodFieldsSchema = z
  .array(PodFieldSchema)
  .min(1)
  .max(50)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    fields.forEach((f, i) => {
      if (seen.has(f.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'key'], message: `duplicate key ${f.key}` });
      seen.add(f.key);
    });
  });

export const CreatePodTemplateBody = z.object({
  clientId: objectIdString.describe('Client this template belongs to; must exist (422 `INVALID_REFERENCE`).'),
  jobGroupId: objectIdString.nullable().default(null).describe('Job group (กลุ่มงาน) this template is specific to, or null for the client\'s default template. Must belong to `clientId` (422 `JOB_GROUP_CLIENT_MISMATCH`).'),
  name: z.string().trim().min(1).max(200),
  extraSteps: z.array(z.enum(EXTRA_STEPS)).default([]).describe('Optional POD workflow steps to require in addition to the field answers: document submission/return, seal check, temperature check.'),
  fields: PodFieldsSchema.describe('1-50 fields the driver fills in to complete a POD, each with a unique `key`.'),
});

export const PatchPodTemplateBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  extraSteps: z.array(z.enum(EXTRA_STEPS)).optional(),
  fields: PodFieldsSchema.optional(),
});

export const PodTemplateItem = z.object({
  id: z.string(),
  clientId: z.string(),
  jobGroupId: z.string().nullable(),
  name: z.string(),
  status: z.enum(['draft', 'published']).describe('"draft" templates can still be edited; "published" templates are immutable and are what shipments actually use (clone a published template to make a new draft).'),
  version: z.number().nullable().describe('Version number assigned on publish (1, 2, ...), null while still a draft. A newer publish for the same client/job group supersedes an older one.'),
  extraSteps: z.array(z.enum(EXTRA_STEPS)),
  fields: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.enum(POD_FIELD_TYPES),
      required: z.boolean(),
      min: z.number().optional(),
      max: z.number().optional(),
      unit: z.string().optional(),
      options: z.array(z.string()).optional(),
    }),
  ),
  publishedAt: z.string().nullable(),
  publishedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
});
