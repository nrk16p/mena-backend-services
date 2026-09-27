import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { applyImportWrites } from '../../src/modules/imports/imports.service.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';
import { multipartFile } from '../helpers/multipart.js';

describe('imports', () => {
  let app: App;
  let h: { authorization: string };

  const upload = (entity: string, csv: string, dryRun: boolean) => {
    const mp = multipartFile(`${entity}.csv`, csv, 'text/csv');
    return app.inject({ method: 'POST', url: `/api/v1/imports/${entity}?dryRun=${dryRun}`, headers: { ...h, ...mp.headers }, payload: mp.payload });
  };

  const lastImportAudit = (entityId: string) =>
    app.db.collection(C.auditLog).findOne({ entity: 'import', entityId }, { sort: { at: -1 } });

  beforeAll(async () => {
    app = await buildTestApp();
    h = (await createUserAndLogin(app, ['planner'])).headers;
  });
  afterAll(async () => closeTestApp(app));

  it('dry run reports creates without writing; real run writes and audits the affected keys', async () => {
    const csv = 'code,name\nBKK,กรุงเทพ\nNE,อีสาน\n';
    const dry = await upload('zones', csv, true);
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ dryRun: true, total: 2, created: 2, updated: 0, errors: 0 });
    expect(await app.db.collection(C.zones).countDocuments()).toBe(0);
    const real = await upload('zones', csv, false);
    expect(real.json()).toMatchObject({ dryRun: false, created: 2 });
    expect(await app.db.collection(C.zones).countDocuments()).toBe(2);
    const createAudit = await lastImportAudit('zones');
    expect(createAudit?.after).toMatchObject({ created: expect.arrayContaining(['BKK', 'NE']), updated: [] });

    const again = await upload('zones', 'code,name\nBKK,Bangkok\n', false);
    expect(again.json()).toMatchObject({ created: 0, updated: 1 });
    expect((await app.db.collection(C.zones).findOne({ code: 'BKK' }))?.name).toBe('Bangkok');
    const updateAudit = await lastImportAudit('zones');
    expect(updateAudit?.after).toMatchObject({ created: [], updated: ['BKK'] });
  });

  it('resolves codes to ids and reports unknown codes per row without saving anything', async () => {
    const csv = [
      'code,name,zoneCode,isSite,lat,lng',
      'SRB,โรงงานสระบุรี,BKK,yes,14.53,100.91',
      'XXX,Unknown zone,NOPE,no,13,100',
      'BAD,Bad lat,BKK,no,abc,100',
    ].join('\n');
    const res = await upload('locations', csv, false);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('IMPORT_HAS_ERRORS');
    const rows = res.json().details.rows;
    expect(rows[0]).toMatchObject({ row: 2, action: 'create', errors: [] });
    expect(rows[1].errors[0]).toMatch(/zoneCode.*NOPE/);
    expect(rows[2].errors[0]).toMatch(/lat/);
    expect(await app.db.collection(C.locations).countDocuments()).toBe(0);
  });

  it('matches vehicles by normalised plate and flags duplicates within a file', async () => {
    await upload('truck-types', 'code,name,category\nTRAILER,Trailer,tractor\n', false);
    const first = await upload('vehicles', 'plate,part,truckTypeCode\n 70-1234 ,head,TRAILER\n', false);
    expect(first.json().created).toBe(1);
    const second = await upload('vehicles', 'plate,part,truckTypeCode,gpsId\n70-1234,head,TRAILER,G-1\n', false);
    expect(second.json()).toMatchObject({ created: 0, updated: 1 });
    const dup = await upload('vehicles', 'plate,part,truckTypeCode\n71-1,head,TRAILER\n72-2,head,TRAILER\n 71-1 ,head,TRAILER\n', true);
    expect(dup.json().rows[1].errors).toEqual([]);
    expect(dup.json().rows[2].errors[0]).toMatch(/duplicate/i);
  });

  it('rejects unknown entities', async () => {
    const mp = multipartFile('x.csv', 'code,name\n', 'text/csv');
    expect((await app.inject({ method: 'POST', url: '/api/v1/imports/nope', headers: { ...h, ...mp.headers }, payload: mp.payload })).statusCode).toBe(400);
  });

  it('rejects a multipart request with no file part', async () => {
    const boundary = `----test${randomUUID()}`;
    const payload = Buffer.from(`--${boundary}--\r\n`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/imports/zones?dryRun=true',
      headers: { ...h, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('FILE_REQUIRED');
  });

  it('rolls back the whole batch (bulk write + audit) when a write conflicts on a unique index', async () => {
    const now = new Date();
    const conflictingOps = [
      { insertOne: { document: { code: 'DUPZ', name: 'First', active: true, createdAt: now, updatedAt: now } } },
      { insertOne: { document: { code: 'DUPZ', name: 'Second', active: true, createdAt: now, updatedAt: now } } },
    ];
    await expect(
      applyImportWrites(app.mongo, app.db, C.zones, conflictingOps, {
        entity: 'import',
        entityId: 'zones-rollback-test',
        action: 'import',
        by: 'tester',
        after: { created: ['DUPZ', 'DUPZ'], updated: [] },
      }),
    ).rejects.toThrow();
    // The first insertOne would have succeeded on its own; prove the transaction
    // rolled it back together with the second (conflicting) one and the audit entry.
    expect(await app.db.collection(C.zones).countDocuments({ code: 'DUPZ' })).toBe(0);
    expect(await app.db.collection(C.auditLog).countDocuments({ entityId: 'zones-rollback-test' })).toBe(0);
  });
});
