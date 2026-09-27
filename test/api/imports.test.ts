import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
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

  it('update path only changes columns present and non-blank in the row: vehicles keep gpsId/gpsVendor', async () => {
    await upload('truck-types', 'code,name,category\nTTGPS,Trailer GPS,tractor\n', false);
    const first = await upload('vehicles', 'plate,part,truckTypeCode,gpsVendor,gpsId\nGPS-1,head,TTGPS,hino,GPS001\n', false);
    expect(first.json()).toMatchObject({ created: 1, updated: 0, errors: 0 });
    const second = await upload('vehicles', 'plate\nGPS-1\n', false);
    expect(second.json()).toMatchObject({ created: 0, updated: 1, errors: 0 });
    const doc = await app.db.collection(C.vehicles).findOne({ plate: 'GPS-1' });
    expect(doc?.gpsVendor).toBe('hino');
    expect(doc?.gpsId).toBe('GPS001');
    expect(doc?.part).toBe('head');
  });

  it('update path only changes columns present and non-blank in the row: locations keep isSite/address/geofenceRadiusM', async () => {
    await upload('zones', 'code,name\nZKEEP,Zone Keep\n', false);
    const first = await upload(
      'locations',
      'code,name,zoneCode,isSite,address,lat,lng,geofenceRadiusM\nLOC-KEEP,Loc Keep,ZKEEP,yes,123 Main St,13.7,100.5,500\n',
      false,
    );
    expect(first.json()).toMatchObject({ created: 1, updated: 0, errors: 0 });
    const second = await upload('locations', 'code,name,zoneCode\nLOC-KEEP,Loc Keep Renamed,ZKEEP\n', false);
    expect(second.json()).toMatchObject({ created: 0, updated: 1, errors: 0 });
    const doc = await app.db.collection(C.locations).findOne({ code: 'LOC-KEEP' });
    expect(doc?.isSite).toBe(true);
    expect(doc?.address).toBe('123 Main St');
    expect(doc?.geofenceRadiusM).toBe(500);
    expect(doc?.name).toBe('Loc Keep Renamed');
  });

  it('a blank cell for an optional column on update keeps the old value', async () => {
    await upload('zones', 'code,name\nZBLANK,Zone Blank\n', false);
    const first = await upload(
      'locations',
      'code,name,zoneCode,address,lat,lng\nLOC-BLANK,Loc Blank,ZBLANK,Original Address,13.7,100.5\n',
      false,
    );
    expect(first.json()).toMatchObject({ created: 1, errors: 0 });
    const second = await upload('locations', 'code,name,zoneCode,address\nLOC-BLANK,Loc Blank,ZBLANK,\n', false);
    expect(second.json()).toMatchObject({ created: 0, updated: 1, errors: 0 });
    const doc = await app.db.collection(C.locations).findOne({ code: 'LOC-BLANK' });
    expect(doc?.address).toBe('Original Address');
  });

  it('a lone lat (blank lng) on update still 422s with LAT_LNG_PAIR', async () => {
    await upload('zones', 'code,name\nZLL,Zone LL\n', false);
    await upload('locations', 'code,name,zoneCode,lat,lng\nLOC-LL,Loc LL,ZLL,13.7,100.5\n', false);
    const bad = await upload('locations', 'code,name,zoneCode,lat,lng\nLOC-LL,Loc LL,ZLL,13.8,\n', false);
    expect(bad.statusCode).toBe(422);
    expect(bad.json().details.rows[0].errors[0]).toMatch(/lat and lng must be provided together/);
  });

  it('matches an existing vehicle created via the API under a different plate separator, by plateKey', async () => {
    const ttRes = await upload('truck-types', 'code,name,category\nTTSEP,Trailer Sep,tractor\n', false);
    expect(ttRes.json()).toMatchObject({ created: 1 });
    const tt = await app.db.collection(C.truckTypes).findOne({ code: 'TTSEP' });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/vehicles',
      headers: h,
      payload: { plate: '80-5678', part: 'head', truckTypeId: tt!._id.toHexString() },
    });
    expect(created.statusCode).toBe(201);
    const createdId = created.json().id;
    const res = await upload('vehicles', 'plate,part,truckTypeCode,gpsId\n80 5678,head,TTSEP,SEP-1\n', false);
    expect(res.json()).toMatchObject({ created: 0, updated: 1 });
    // Matched by plateKey, not by exact display text — same vehicle (same _id), now
    // with the display plate and gpsId from the import row.
    const doc = await app.db.collection(C.vehicles).findOne({ _id: new ObjectId(createdId) });
    expect(doc?.gpsId).toBe('SEP-1');
    expect(doc?.plate).toBe('80 5678');
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
