import { ObjectId, type Collection, type Document, type Filter, type WithId } from 'mongodb';
import { z } from 'zod';
import { objectIdString } from './ids.js';

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: objectIdString.optional(),
});

export type PageParams = { limit: number; cursor?: string };

export function pageResponse<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

export async function paginate<T extends Document>(
  coll: Collection<T>,
  filter: Filter<T>,
  page: PageParams,
): Promise<{ items: WithId<T>[]; nextCursor: string | null }> {
  const f = (page.cursor ? { $and: [filter, { _id: { $gt: new ObjectId(page.cursor) } }] } : filter) as Filter<T>;
  const docs = await coll.find(f).sort({ _id: 1 }).limit(page.limit + 1).toArray();
  const hasMore = docs.length > page.limit;
  const items = hasMore ? docs.slice(0, page.limit) : docs;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? (last._id as unknown as ObjectId).toHexString() : null };
}
