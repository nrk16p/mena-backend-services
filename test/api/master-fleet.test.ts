import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { C } from '../../src/db/collections.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';

describe('locations, vehicles, drivers', () => {
  let app: App;
  let h: { authorization: string };
  let zoneId: string;
  let tractorType: string;
  let rigidType: string;

  const post = (url: string, payload: object) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });
  const patch = (url: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/v1${url}`, headers: h, payload });

  beforeAll(async () => {
    app = await buildTestApp();
    h = (await createUserAndLogin(app, ['planner'])).headers;
    zoneId = (await post('/zones', { code: 'CEN', name: 'ภาคกลาง' })).json().id;
    tractorType = (await post('/truck-types', { code: 'TRAILER', name: 'Trailer', category: 'tractor' })).json().id;
    rigidType = (await post('/truck-types', { code: 'MIXER', name: 'Mixer', category: 'rigid' })).json().id;
  });
  afterAll(async () => closeTestApp(app));

  it('stores a location as a GeoJSON point and returns lat/lng', async () => {
    const res = await post('/locations', { code: 'SRB-PLANT', name: 'โรงงานสระบุรี', zoneId, isSite: true, lat: 14.53, lng: 100.91 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ lat: 14.53, lng: 100.91, geofenceRadiusM: 300, isSite: true, clientId: null, address: null });
    const raw = await app.db.collection(C.locations).findOne({ code: 'SRB-PLANT' });
    expect(raw?.geo).toEqual({ type: 'Point', coordinates: [100.91, 14.53] });
    expect(raw).not.toHaveProperty('lat');
    const filtered = await app.inject({ method: 'GET', url: `/api/v1/locations?zoneId=${zoneId}&isSite=true`, headers: h });
    expect(filtered.json().items).toHaveLength(1);
  });

  it('rejects an unknown zone and a lat without lng', async () => {
    const bad = await post('/locations', { code: 'X', name: 'X', zoneId: '0123456789abcdef01234567', lat: 1, lng: 1 });
    expect(bad.json().code).toBe('INVALID_REFERENCE');
    const loc = (await post('/locations', { code: 'Y', name: 'Y', zoneId, lat: 13.7, lng: 100.5 })).json();
    const half = await patch(`/locations/${loc.id}`, { lat: 13.8 });
    expect(half.statusCode).toBe(422);
    expect(half.json().code).toBe('LAT_LNG_PAIR');
    const both = await patch(`/locations/${loc.id}`, { lat: 13.8, lng: 100.6 });
    expect(both.json()).toMatchObject({ lat: 13.8, lng: 100.6 });
  });

  it('normalises plates and treats spacing/case variants as duplicates', async () => {
    const res = await post('/vehicles', { plate: ' 70-1234 ', part: 'head', truckTypeId: tractorType });
    expect(res.statusCode).toBe(201);
    expect(res.json().plate).toBe('70-1234');
    expect((await post('/vehicles', { plate: '70-1234', part: 'head', truckTypeId: tractorType })).statusCode).toBe(409);
    await post('/vehicles', { plate: 'ab 1234', part: 'tail', truckTypeId: tractorType });
    expect((await post('/vehicles', { plate: 'AB  1234', part: 'tail', truckTypeId: tractorType })).statusCode).toBe(409);
  });

  it('enforces part vs truck-type category, including on PATCH', async () => {
    expect((await post('/vehicles', { plate: 'MX-1', part: 'rigid', truckTypeId: tractorType })).json().code).toBe('PART_CATEGORY_MISMATCH');
    expect((await post('/vehicles', { plate: 'MX-2', part: 'head', truckTypeId: rigidType })).json().code).toBe('PART_CATEGORY_MISMATCH');
    const mixer = (await post('/vehicles', { plate: 'MX-3', part: 'rigid', truckTypeId: rigidType })).json();
    expect((await patch(`/vehicles/${mixer.id}`, { part: 'head' })).json().code).toBe('PART_CATEGORY_MISMATCH');
  });

  it('creates drivers and validates licence expiry format', async () => {
    const ok = await post('/drivers', { code: 'D001', name: 'สมชาย ใจดี', phone: '0812345678', licenseType: 'ท.4', licenseExpiry: '2027-05-31' });
    expect(ok.statusCode).toBe(201);
    expect((await post('/drivers', { code: 'D002', name: 'x', licenseExpiry: '31/05/2027' })).statusCode).toBe(400);
  });
});
