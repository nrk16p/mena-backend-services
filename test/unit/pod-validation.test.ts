import { describe, expect, it } from 'vitest';
import { DEFAULT_POD_FIELDS, type PodFileRef, validatePodAnswers } from '../../src/modules/pods/pod-validation.js';
import type { PodField } from '../../src/modules/pod-templates/pod-templates.schemas.js';

const file = (fieldKey: string, n = 1): PodFileRef => ({ fieldKey, key: `pods/s/d/${fieldKey}-${n}.jpg`, sha256: 'x', mime: 'image/jpeg', bytes: 1000 });
const codes = (issues: { code: string }[]) => issues.map((i) => i.code).sort();

const fields: PodField[] = [
  ...DEFAULT_POD_FIELDS,
  { key: 'tempC', label: 'อุณหภูมิ', type: 'number', required: true, min: -30, max: 10 },
  { key: 'condition', label: 'สภาพ', type: 'select', required: false, options: ['ปกติ', 'เสียหาย'] },
  { key: 'sealOk', label: 'ซีล', type: 'checkbox', required: false },
  { key: 'qty', label: 'จำนวน', type: 'qtyLines', required: false },
];

describe('validatePodAnswers', () => {
  it('accepts a complete delivered POD', () => {
    const issues = validatePodAnswers(
      fields,
      { receiverName: 'คุณสมศรี', tempC: 4, condition: 'ปกติ', sealOk: true, qty: [{ planned: 30, delivered: 30, unit: 'ton' }] },
      [file('goodsPhoto'), file('receiverSign')],
      'DELIVERED',
    );
    expect(issues).toEqual([]);
  });

  it('reports every problem at once', () => {
    const issues = validatePodAnswers(
      fields,
      { tempC: 20, condition: 'แตก', sealOk: 'yes', extra: 1 },
      [file('goodsPhoto', 1), file('goodsPhoto', 2), file('goodsPhoto', 3), file('goodsPhoto', 4), file('goodsPhoto', 5), file('goodsPhoto', 6), file('unknown')],
      'DELIVERED',
    );
    expect(codes(issues)).toEqual(['FIELD_REQUIRED', 'FILE_FIELD_MISMATCH', 'INVALID_OPTION', 'INVALID_TYPE', 'OUT_OF_RANGE', 'PHOTO_COUNT', 'SIGNATURE_COUNT', 'UNKNOWN_FIELD']);
  });

  it('does not require fields for a failed delivery but still type-checks them', () => {
    expect(validatePodAnswers(fields, {}, [], 'FAILED')).toEqual([]);
    expect(codes(validatePodAnswers(fields, { tempC: 'cold' }, [], 'FAILED'))).toEqual(['INVALID_TYPE']);
  });
});
