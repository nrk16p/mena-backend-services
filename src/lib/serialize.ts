import { ObjectId } from 'mongodb';

// Converts a Mongo document into its API shape. Returns `any` so route handlers
// can return it directly; the route's zod response schema is the real contract.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toApi(value: unknown): any {
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toApi);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k === '_id' ? 'id' : k] = toApi(v);
    return out;
  }
  return value;
}
