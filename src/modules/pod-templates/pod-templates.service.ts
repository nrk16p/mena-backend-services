import type { Db, ObjectId } from 'mongodb';
import { C } from '../../db/collections.js';
import type { EXTRA_STEPS, PodField } from './pod-templates.schemas.js';

export interface PodTemplateDoc {
  _id: ObjectId;
  clientId: ObjectId;
  jobGroupId: ObjectId | null;
  name: string;
  status: 'draft' | 'published';
  version: number | null;
  extraSteps: (typeof EXTRA_STEPS)[number][];
  fields: PodField[];
  publishedAt: Date | null;
  publishedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
}

export const podTemplateKey = (clientId: ObjectId, jobGroupId: ObjectId | null) => `${clientId.toHexString()}|${jobGroupId?.toHexString() ?? ''}`;

/**
 * Latest published template per (client, job group) for many DOs at once, falling back to the
 * client's default (jobGroupId null) template. One query per call (spec §13.2 rule 8); published
 * templates per client are few, so loading them all is bounded.
 */
export async function resolvePodTemplates(
  db: Db,
  pairs: { clientId: ObjectId; jobGroupId: ObjectId | null }[],
): Promise<Map<string, PodTemplateDoc | null>> {
  const out = new Map<string, PodTemplateDoc | null>();
  if (pairs.length === 0) return out;
  const clientIds = [...new Map(pairs.map((p) => [p.clientId.toHexString(), p.clientId])).values()];
  const published = await db.collection<PodTemplateDoc>(C.podTemplates).find({ clientId: { $in: clientIds }, status: 'published' }).toArray();
  const latest = new Map<string, PodTemplateDoc>();
  for (const t of published) {
    const key = podTemplateKey(t.clientId, t.jobGroupId);
    const current = latest.get(key);
    if (!current || (t.version ?? 0) > (current.version ?? 0)) latest.set(key, t);
  }
  for (const p of pairs) {
    const specific = p.jobGroupId ? latest.get(podTemplateKey(p.clientId, p.jobGroupId)) : undefined;
    out.set(podTemplateKey(p.clientId, p.jobGroupId), specific ?? latest.get(podTemplateKey(p.clientId, null)) ?? null);
  }
  return out;
}

export async function resolvePodTemplate(db: Db, clientId: ObjectId, jobGroupId: ObjectId | null): Promise<PodTemplateDoc | null> {
  return (await resolvePodTemplates(db, [{ clientId, jobGroupId }])).get(podTemplateKey(clientId, jobGroupId)) ?? null;
}
