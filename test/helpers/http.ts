import type { LightMyRequestResponse } from 'fastify';

/** Returns the JSON body when the response has the expected status; otherwise throws with the body so a broken setup step fails loudly. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ok<T = any>(res: LightMyRequestResponse, status = 200): T {
  if (res.statusCode !== status) throw new Error(`expected ${status}, got ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}
