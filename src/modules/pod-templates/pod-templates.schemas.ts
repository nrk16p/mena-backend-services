import { z } from 'zod';
import { objectIdString } from '../../lib/ids.js';

export const POD_FIELD_TYPES = ['photo', 'signature', 'text', 'number', 'select', 'checkbox', 'qtyLines', 'palletLines'] as const;
export const EXTRA_STEPS = ['DOCS_SUBMITTED', 'DOCS_RETURNED', 'SEAL_CHECKED', 'TEMP_CHECKED'] as const;

export const PodFieldSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/, 'key must be camelCase letters/digits, starting with a lowercase letter'),
    label: z.string().trim().min(1).max(200),
    type: z.enum(POD_FIELD_TYPES),
    required: z.boolean().default(false),
    min: z.number().optional(),
    max: z.number().optional(),
    unit: z.string().trim().max(20).optional(),
    options: z.array(z.string().trim().min(1)).optional(),
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
  clientId: objectIdString,
  jobGroupId: objectIdString.nullable().default(null),
  name: z.string().trim().min(1).max(200),
  extraSteps: z.array(z.enum(EXTRA_STEPS)).default([]),
  fields: PodFieldsSchema,
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
  status: z.enum(['draft', 'published']),
  version: z.number().nullable(),
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
