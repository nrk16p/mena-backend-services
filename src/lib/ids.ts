import { z } from 'zod';

export const objectIdString = z.string().regex(/^[a-f0-9]{24}$/i, 'must be a 24-character hex id');
export const IdParams = z.object({ id: objectIdString });
