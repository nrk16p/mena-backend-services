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

export async function resolvePodTemplate(db: Db, clientId: ObjectId, jobGroupId: ObjectId | null): Promise<PodTemplateDoc | null> {
  const coll = db.collection<PodTemplateDoc>(C.podTemplates);
  const latest = (jg: ObjectId | null) =>
    coll.find({ clientId, jobGroupId: jg, status: 'published' }).sort({ version: -1 }).limit(1).next();
  if (jobGroupId) {
    const specific = await latest(jobGroupId);
    if (specific) return specific;
  }
  return latest(null);
}
