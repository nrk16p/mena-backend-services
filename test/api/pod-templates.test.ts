import { ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { resolvePodTemplate } from '../../src/modules/pod-templates/pod-templates.service.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';
import { createUserAndLogin } from '../helpers/auth.js';

describe('POD templates', () => {
  let app: App;
  let h: { authorization: string };
  let scg: string;
  let cpac: string;
  let cold: string;
  let cpacGroup: string;
  const post = (url: string, payload?: object) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload });

  const coldFields = [
    { key: 'goodsPhoto', label: 'รูปสินค้า', type: 'photo', required: true, min: 1, max: 5 },
    { key: 'tempC', label: 'อุณหภูมิ (°C)', type: 'number', required: true, min: -30, max: 10, unit: '°C' },
    { key: 'receiverSign', label: 'ลายเซ็นผู้รับ', type: 'signature', required: true },
    { key: 'condition', label: 'สภาพสินค้า', type: 'select', options: ['ปกติ', 'เสียหาย'] },
  ];

  beforeAll(async () => {
    app = await buildTestApp();
    h = (await createUserAndLogin(app, ['planner'])).headers;
    scg = (await post('/clients', { code: 'SCG', name: 'SCG' })).json().id;
    cpac = (await post('/clients', { code: 'CPAC', name: 'CPAC' })).json().id;
    cold = (await post(`/clients/${scg}/job-groups`, { code: 'COLD', name: 'Coldchain', criteria: {} })).json().id;
    cpacGroup = (await post(`/clients/${cpac}/job-groups`, { code: 'RMC', name: 'Ready-mix', criteria: {} })).json().id;
  });
  afterAll(async () => closeTestApp(app));

  it('creates a draft, publishes version 1 then version 2 for the same scope', async () => {
    const d1 = await post('/pod-templates', { clientId: scg, jobGroupId: cold, name: 'Cold POD', extraSteps: ['TEMP_CHECKED'], fields: coldFields });
    expect(d1.statusCode).toBe(201);
    expect(d1.json()).toMatchObject({ status: 'draft', version: null });
    const p1 = await post(`/pod-templates/${d1.json().id}/publish`);
    expect(p1.json()).toMatchObject({ status: 'published', version: 1 });
    const d2 = await post(`/pod-templates/${d1.json().id}/clone`);
    expect(d2.json()).toMatchObject({ status: 'draft', version: null, fields: expect.any(Array) });
    const p2 = await post(`/pod-templates/${d2.json().id}/publish`);
    expect(p2.json().version).toBe(2);
  });

  it('refuses to edit or re-publish a published version', async () => {
    const d = (await post('/pod-templates', { clientId: scg, name: 'Default', fields: coldFields })).json();
    await post(`/pod-templates/${d.id}/publish`);
    const edit = await app.inject({ method: 'PATCH', url: `/api/v1/pod-templates/${d.id}`, headers: h, payload: { name: 'changed' } });
    expect(edit.statusCode).toBe(422);
    expect(edit.json().code).toBe('TEMPLATE_PUBLISHED');
    expect((await post(`/pod-templates/${d.id}/publish`)).json().code).toBe('TEMPLATE_PUBLISHED');
  });

  it('validates fields', async () => {
    const noOptions = await post('/pod-templates', { clientId: scg, name: 'x', fields: [{ key: 'c', label: 'c', type: 'select' }] });
    expect(noOptions.statusCode).toBe(400);
    const dupKeys = await post('/pod-templates', { clientId: scg, name: 'x', fields: [{ key: 'a', label: 'a', type: 'text' }, { key: 'a', label: 'b', type: 'text' }] });
    expect(dupKeys.statusCode).toBe(400);
    const badKey = await post('/pod-templates', { clientId: scg, name: 'x', fields: [{ key: 'Bad Key', label: 'a', type: 'text' }] });
    expect(badKey.statusCode).toBe(400);
  });

  it('rejects a job group from another client and unknown clients', async () => {
    const res = await post('/pod-templates', { clientId: scg, jobGroupId: cpacGroup, name: 'x', fields: coldFields });
    expect(res.json().code).toBe('JOB_GROUP_CLIENT_MISMATCH');
    const unknown = await post('/pod-templates', { clientId: '0123456789abcdef01234567', name: 'x', fields: coldFields });
    expect(unknown.json().code).toBe('INVALID_REFERENCE');
  });

  it('resolves the latest published template for a group, falling back to the client default', async () => {
    const byGroup = await resolvePodTemplate(app.db, new ObjectId(scg), new ObjectId(cold));
    expect(byGroup?.version).toBe(2);
    const fallback = await resolvePodTemplate(app.db, new ObjectId(scg), new ObjectId());
    expect(fallback?.name).toBe('Default');
    expect(await resolvePodTemplate(app.db, new ObjectId(cpac), null)).toBeNull();
  });
});
