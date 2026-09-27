import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialisation used for hashing (equal objects must hash equally regardless
 * of key order). Only plain data — objects/arrays/primitives — round-trips safely: a `Date`,
 * `ObjectId`, `Map` or any other class instance silently drops fields (or serialises differently)
 * across `JSON.stringify` and would make two "equal" documents hash differently, so those throw
 * instead of being coerced.
 */
export function canonicalJson(value: unknown, topLevel = true): string {
  if (value === undefined) {
    if (topLevel) throw new Error('canonicalJson: cannot serialize a top-level undefined value');
    return 'null';
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, false)).join(',')}]`;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const ctorName = (value as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
    throw new Error(`canonicalJson: cannot serialize a non-plain object (${ctorName}); pass a plain object/array/primitive`);
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v, false)}`).join(',')}}`;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
