import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { toApi } from '../../src/lib/serialize.js';

describe('toApi', () => {
  it('converts _id, ObjectIds and Dates recursively', () => {
    const id = new ObjectId();
    const ref = new ObjectId();
    const at = new Date('2026-09-27T01:02:03.000Z');
    expect(
      toApi({ _id: id, zoneId: ref, createdAt: at, nested: { list: [ref, { at }] }, n: 1, s: 'x', nil: null }),
    ).toEqual({
      id: id.toHexString(),
      zoneId: ref.toHexString(),
      createdAt: '2026-09-27T01:02:03.000Z',
      nested: { list: [ref.toHexString(), { at: '2026-09-27T01:02:03.000Z' }] },
      n: 1,
      s: 'x',
      nil: null,
    });
  });
});
