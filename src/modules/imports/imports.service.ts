import { ObjectId, type AnyBulkWriteOperation, type ClientSession, type Db, type Document, type MongoClient } from 'mongodb';
import { AppError, unprocessable } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { withTransaction } from '../../lib/tx.js';
import { prepareDoc } from '../master/resource.js';
import type { ParsedRow } from './parse.js';
import { IMPORT_SPECS, type ImportCtx, type ImportEntity, RowError } from './specs.js';

export interface ImportRowResult {
  row: number;
  key: string | null;
  action: 'create' | 'update' | 'error';
  errors: string[];
}

export interface ImportReport {
  entity: ImportEntity;
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  errors: number;
  rows: ImportRowResult[];
}

/**
 * Applies one bulk-write-shaped operation directly (insertOne/updateOne/etc.) rather than
 * through `Collection.bulkWrite()`. The MongoDB driver's `bulkWrite()` resolves its options
 * twice (once in `bulkWrite`, again inside `initializeOrderedBulkOp`/`initializeUnorderedBulkOp`),
 * and the second resolution rejects with "An operation cannot be given a timeoutMS setting
 * when inside a withTransaction call that has a timeoutMS setting" whenever the client has a
 * `timeoutMS` (our `MONGO_TIMEOUT_MS` guardrail) and the write runs inside a convenient
 * `session.withTransaction()` — this is true even though we never pass `timeoutMS` ourselves;
 * it's inherited from the client and only surfaces because of `bulkWrite`'s double resolution.
 * Executing ops one at a time with the plain single-document methods sidesteps that entirely
 * while staying inside the same transaction (so atomicity/rollback is unaffected) and preserves
 * ordered (stop-on-first-error) semantics via the `for` loop below.
 */
async function applyOp(coll: ReturnType<Db['collection']>, op: AnyBulkWriteOperation<Document>, session: ClientSession): Promise<void> {
  if ('insertOne' in op) {
    await coll.insertOne(op.insertOne.document, { session });
  } else if ('updateOne' in op) {
    await coll.updateOne(op.updateOne.filter, op.updateOne.update, { session, upsert: op.updateOne.upsert });
  } else if ('updateMany' in op) {
    await coll.updateMany(op.updateMany.filter, op.updateMany.update, { session, upsert: op.updateMany.upsert });
  } else if ('replaceOne' in op) {
    await coll.replaceOne(op.replaceOne.filter, op.replaceOne.replacement, { session, upsert: op.replaceOne.upsert });
  } else if ('deleteOne' in op) {
    await coll.deleteOne(op.deleteOne.filter, { session });
  } else if ('deleteMany' in op) {
    await coll.deleteMany(op.deleteMany.filter, { session });
  } else {
    throw new Error('Unsupported bulk write operation kind');
  }
}

/**
 * Runs the bulk write and its accompanying audit entry inside one MongoDB
 * transaction, so a mid-batch failure (e.g. a unique-index conflict that
 * only surfaces at write time) leaves no partial writes behind. Exported so
 * the rollback behaviour can be exercised directly in tests with hand-built
 * ops, independent of runImport's own row-level validation.
 */
export async function applyImportWrites(
  mongo: MongoClient,
  db: Db,
  collection: string,
  ops: AnyBulkWriteOperation<Document>[],
  audit: { entity: string; entityId: string; action: string; by: string; after?: unknown },
  opts?: { timeoutMS?: number },
): Promise<void> {
  await withTransaction(
    mongo,
    async (session) => {
      const coll = db.collection(collection);
      for (const op of ops) await applyOp(coll, op, session);
      await writeAudit(db, audit, { session });
    },
    opts,
  );
}

export async function runImport(
  mongo: MongoClient,
  db: Db,
  entity: ImportEntity,
  rows: ParsedRow[],
  opts: { dryRun: boolean; by: string; batchTimeoutMs?: number },
): Promise<ImportReport> {
  const spec = IMPORT_SPECS[entity];
  const coll = db.collection(spec.def.collection);
  const cache = new Map<string, string>();
  const ctx: ImportCtx = {
    async idByCode(collection, code, column) {
      const k = `${collection}:${code}`;
      const hit = cache.get(k);
      if (hit) return hit;
      const doc = await db.collection(collection).findOne({ code }, { projection: { _id: 1 } });
      if (!doc) throw new RowError(`${column}: unknown code "${code}"`);
      const id = doc._id.toHexString();
      cache.set(k, id);
      return id;
    },
  };

  const results: ImportRowResult[] = [];
  const ops: AnyBulkWriteOperation<Document>[] = [];
  const seen = new Set<string>();
  const now = new Date();

  for (const { rowNumber, values } of rows) {
    const get = (column: string) => {
      const v = values[column.toLowerCase()];
      return v === undefined || v === '' ? undefined : v;
    };
    const dupKey = spec.keyOf(get) ?? null;
    const result: ImportRowResult = { row: rowNumber, key: dupKey, action: 'error', errors: [] };
    try {
      if (dupKey !== null) {
        if (seen.has(dupKey)) throw new RowError(`duplicate ${spec.key} "${dupKey}" earlier in this file`);
        seen.add(dupKey);
      }
      const rawBody = await spec.toBody(get, ctx);
      const existing = dupKey === null ? null : await coll.findOne({ [spec.dbKey]: dupKey });
      // CREATE parses the full body so defaults apply (e.g. gpsVendor: null, isSite: false).
      // UPDATE parses only the columns that were actually present and non-blank in this
      // row, via `.partial()`, so a re-import that omits an optional column (or leaves
      // it blank) never resets it back to that column's default.
      const parsed = existing
        ? spec.def.body.partial().safeParse(Object.fromEntries(Object.entries(rawBody).filter(([, v]) => v !== undefined)))
        : spec.def.body.safeParse(rawBody);
      if (!parsed.success) {
        result.errors = parsed.error.issues.map((i) => `${i.path.join('.') || 'row'}: ${i.message}`);
      } else {
        const prepared = await prepareDoc(spec.def, db, parsed.data as Record<string, unknown>, existing);
        if (existing) {
          result.action = 'update';
          ops.push({ updateOne: { filter: { _id: existing._id as ObjectId }, update: { $set: { ...prepared, updatedAt: now } } } });
        } else {
          result.action = 'create';
          ops.push({ insertOne: { document: { ...prepared, active: true, createdAt: now, updatedAt: now } } });
        }
      }
    } catch (e) {
      if (e instanceof RowError || e instanceof AppError) result.errors = [e.message];
      else throw e;
    }
    if (result.errors.length > 0) result.action = 'error';
    results.push(result);
  }

  const report: ImportReport = {
    entity,
    dryRun: opts.dryRun,
    total: results.length,
    created: results.filter((r) => r.action === 'create').length,
    updated: results.filter((r) => r.action === 'update').length,
    errors: results.filter((r) => r.action === 'error').length,
    rows: results,
  };

  if (opts.dryRun) return report;
  if (report.errors > 0) throw unprocessable('IMPORT_HAS_ERRORS', `${report.errors} row(s) have errors; nothing was saved`, report);
  const createdKeys = results.filter((r) => r.action === 'create').map((r) => r.key!);
  const updatedKeys = results.filter((r) => r.action === 'update').map((r) => r.key!);
  await applyImportWrites(
    mongo,
    db,
    spec.def.collection,
    ops,
    { entity: 'import', entityId: entity, action: 'import', by: opts.by, after: { created: createdKeys, updated: updatedKeys } },
    { timeoutMS: opts.batchTimeoutMs },
  );
  return report;
}
