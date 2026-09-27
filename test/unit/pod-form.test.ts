import { ObjectId, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { C } from '../../src/db/collections.js';
import { podFormsFor } from '../../src/modules/pods/pod-form.js';
import { testDb } from '../helpers/db.js';

describe('podFormsFor', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await testDb());
  });
  afterAll(async () => close());

  it('picks the latest published template per client and job group, else the client default, else the built-in form', async () => {
    const clientX = new ObjectId();
    const clientY = new ObjectId();
    const group = new ObjectId();
    const tpl = (clientId: ObjectId, jobGroupId: ObjectId | null, version: number | null, status: 'draft' | 'published') => ({
      _id: new ObjectId(), clientId, jobGroupId, name: `v${version}`, status, version, extraSteps: version === 2 ? ['SEAL_CHECKED'] : [],
      fields: [{ key: `f${version}`, label: 'x', type: 'text', required: true }],
    });
    const defaultV1 = tpl(clientX, null, 1, 'published');
    const defaultV2 = tpl(clientX, null, 2, 'published');
    const groupV1 = tpl(clientX, group, 1, 'published');
    const draft = tpl(clientX, group, null, 'draft');
    for (const t of [defaultV1, defaultV2, groupV1, draft]) await db.collection(C.podTemplates).insertOne(t);
    const doOf = (clientId: ObjectId, jobGroupId: ObjectId | null) => ({ _id: new ObjectId(), clientId, jobGroupId });
    const inGroup = doOf(clientX, group);
    const otherGroup = doOf(clientX, new ObjectId());
    const noGroup = doOf(clientX, null);
    const noTemplates = doOf(clientY, null);
    const forms = await podFormsFor(db, [inGroup, otherGroup, noGroup, noTemplates]);
    expect(forms.get(inGroup._id.toHexString())).toMatchObject({ templateId: groupV1._id, version: 1, extraSteps: [] });
    expect(forms.get(otherGroup._id.toHexString())).toMatchObject({ templateId: defaultV2._id, version: 2, extraSteps: ['SEAL_CHECKED'] });
    expect(forms.get(noGroup._id.toHexString())).toMatchObject({ templateId: defaultV2._id, version: 2 });
    expect(forms.get(noTemplates._id.toHexString())).toMatchObject({ templateId: null, version: 0, extraSteps: [] });
    expect(forms.get(noTemplates._id.toHexString())!.fields.map((f) => f.key)).toEqual(['goodsPhoto', 'receiverName', 'receiverSign']);
  });
});
