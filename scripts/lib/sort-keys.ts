/**
 * Recursively sorts object keys (ascending) so two runs of the same OpenAPI document produce
 * byte-identical JSON — the property insertion order of a JS object built from a `Map`-backed
 * route registry isn't guaranteed to be stable across runs/processes, but the point of committing
 * this file is a clean, reviewable `git diff`, so key order must be. Array order is left alone:
 * arrays (route parameter lists, `tags`, enum values, ...) are already meaningful sequences, not
 * unordered bags of keys.
 */
export function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => sortKeysDeep(v)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out as unknown as T;
  }
  return value;
}
