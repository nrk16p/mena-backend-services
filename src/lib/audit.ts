import type { FastifyRequest } from 'fastify';
import type { ClientSession, Db } from 'mongodb';
import { C } from '../db/collections.js';

export function actorOf(req: FastifyRequest): string {
  const p = req.principal;
  if (!p) return 'system';
  return p.kind === 'user' ? p.username : `apikey:${p.name}`;
}

export async function writeAudit(
  db: Db,
  entry: { entity: string; entityId: string; action: string; by: string; before?: unknown; after?: unknown },
  opts?: { session?: ClientSession },
): Promise<void> {
  await db.collection(C.auditLog).insertOne(
    {
      entity: entry.entity,
      entityId: entry.entityId,
      action: entry.action,
      by: entry.by,
      before: entry.before ?? null,
      after: entry.after ?? null,
      at: new Date(),
    },
    opts?.session ? { session: opts.session } : undefined,
  );
}
