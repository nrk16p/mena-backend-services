import { z } from 'zod';

export interface Issue {
  code: string;
  message: string;
  details?: unknown;
}

export const IssueSchema = z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() });
