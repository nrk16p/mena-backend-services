import type { Db, ObjectId } from 'mongodb';
import { unprocessable } from './errors.js';
import type { Issue } from './issues.js';

export interface RefCheck {
  field: string;
  collection: string;
  ids: (ObjectId | null | undefined)[];
}

export async function checkActiveRefs(db: Db, checks: RefCheck[]): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const check of checks) {
    const unique = [...new Map(check.ids.filter((i): i is ObjectId => !!i).map((i) => [i.toHexString(), i])).values()];
    if (unique.length === 0) continue;
    const docs = await db.collection(check.collection).find({ _id: { $in: unique } }, { projection: { active: 1 } }).toArray();
    const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
    const missing = unique.map((i) => i.toHexString()).filter((h) => !byId.has(h));
    const inactive = unique.map((i) => i.toHexString()).filter((h) => byId.get(h)?.active === false);
    if (missing.length > 0) {
      issues.push({ code: 'INVALID_REFERENCE', message: `${check.field} references unknown ${check.collection}`, details: { field: check.field, ids: missing } });
    }
    if (inactive.length > 0) {
      issues.push({ code: 'INACTIVE_REFERENCE', message: `${check.field} references deactivated ${check.collection}`, details: { field: check.field, ids: inactive } });
    }
  }
  return issues;
}

export async function assertActiveRefs(db: Db, checks: RefCheck[]): Promise<void> {
  const [first] = await checkActiveRefs(db, checks);
  if (first) throw unprocessable(first.code, first.message, first.details);
}
