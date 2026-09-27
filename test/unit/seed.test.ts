import type { Db, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { C } from '../../src/db/collections.js';
import { ensureIndexes } from '../../src/db/indexes.js';
import { verifyPassword } from '../../src/lib/passwords.js';
import { matchJobGroupForDo } from '../../src/modules/master/job-groups.js';
import { findUserByUsername } from '../../src/modules/users/users.repo.js';
import { seedAdmin, seedBase, seedDemo } from '../../src/seed/seed.js';
import { testDb } from '../helpers/db.js';

describe('seed', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await testDb());
    await ensureIndexes(db);
  });
  afterAll(async () => close());

  it('seeds base data idempotently without overwriting edits', async () => {
    await seedBase(db);
    await db.collection(C.truckTypes).updateOne({ code: 'MIXER' }, { $set: { name: 'Mixer 6 คิว' } });
    await seedBase(db);
    expect(await db.collection(C.truckTypes).countDocuments()).toBe(5);
    expect(await db.collection(C.palletMovementTypes).countDocuments()).toBe(4);
    expect((await db.collection(C.truckTypes).findOne({ code: 'MIXER' }))?.name).toBe('Mixer 6 คิว');
  });

  it('creates the admin once', async () => {
    expect(await seedAdmin(db, 'admin', 'Admin-pass-1')).toBe('created');
    expect(await seedAdmin(db, 'admin', 'other')).toBe('exists');
    const admin = await findUserByUsername(db, 'admin');
    expect(admin?.roles).toEqual(['admin']);
    expect(await verifyPassword(admin!.passwordHash, 'Admin-pass-1')).toBe(true);
  });

  it('seeds demo data idempotently and it matches a job group', async () => {
    await seedDemo(db);
    await seedDemo(db);
    expect(await db.collection(C.clients).countDocuments({ code: 'DEMO' })).toBe(1);
    const client = await db.collection(C.clients).findOne({ code: 'DEMO' });
    const byCode = async (coll: string, code: string) => (await db.collection(coll).findOne({ code }))!._id as ObjectId;
    const result = await matchJobGroupForDo(db, client!._id, {
      truckTypeId: await byCode(C.truckTypes, 'MIXER'),
      serviceTypeId: await byCode(C.serviceTypes, 'SINGLE'),
      materialId: await byCode(C.materials, 'READYMIX'),
      originLocationId: await byCode(C.locations, 'DEMO-PLANT'),
      destLocationId: await byCode(C.locations, 'DEMO-SITE-BKK'),
    });
    expect(result.status).toBe('auto');
    expect(await db.collection(C.podTemplates).countDocuments({ clientId: client!._id, status: 'published' })).toBe(1);
  });
});
