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

  it('treats an explicit null for line fields as missing', () => {
    const lines: PodField[] = [
      { key: 'qty', label: 'จำนวน', type: 'qtyLines', required: true },
      { key: 'pallets', label: 'พาเลท', type: 'palletLines', required: false },
    ];
    expect(codes(validatePodAnswers(lines, { qty: null, pallets: null }, [], 'DELIVERED'))).toEqual(['FIELD_REQUIRED']);
    expect(validatePodAnswers(lines, { qty: null, pallets: null }, [], 'FAILED')).toEqual([]);
  });

  it('requires a required checkbox to be ticked and required text to be more than whitespace (P3-R14)', () => {
    const f: PodField[] = [
      { key: 'sealOk', label: 'ซีล', type: 'checkbox', required: true },
      { key: 'remark', label: 'หมายเหตุ', type: 'text', required: true },
      { key: 'optBox', label: 'ตัวเลือก', type: 'checkbox', required: false },
      { key: 'optText', label: 'ข้อความ', type: 'text', required: false },
    ];
    const issues = validatePodAnswers(f, { sealOk: false, remark: '   ', optBox: false, optText: '  ' }, [], 'DELIVERED');
    expect(issues.map((i) => [i.code, (i.details as { field: string }).field])).toEqual([
      ['FIELD_REQUIRED', 'sealOk'],
      ['FIELD_REQUIRED', 'remark'],
    ]);
    expect(validatePodAnswers(f, { sealOk: true, remark: ' ok ' }, [], 'DELIVERED')).toEqual([]);
    // A failed delivery does not enforce required fields.
    expect(validatePodAnswers(f, { sealOk: false, remark: ' ' }, [], 'FAILED')).toEqual([]);
  });

  it('rejects answer keys that start with $ or contain a dot, at any depth', () => {
    const f: PodField[] = [
      { key: 'receiverName', label: 'ชื่อ', type: 'text', required: false },
      { key: 'qty', label: 'จำนวน', type: 'qtyLines', required: false },
    ];
    const issues = validatePodAnswers(
      f,
      { receiverName: 'x', $where: '1', 'a.b': 1, qty: [{ delivered: 1, extra: { $gt: 1 } }, { delivered: 2, 'x.y': 3 }] },
      [],
      'DELIVERED',
    );
    const bad = issues.filter((i) => i.code === 'INVALID_KEY');
    expect(bad.map((i) => (i.details as { path: (string | number)[] }).path)).toEqual([['$where'], ['a.b'], ['qty', 0, 'extra', '$gt'], ['qty', 1, 'x.y']]);
    expect(codes(issues)).not.toContain('UNKNOWN_FIELD'); // an unsafe key is reported once, as INVALID_KEY
    expect(validatePodAnswers(f, { receiverName: 'a.b $c', qty: [{ delivered: 1, note: '$5.00' }] }, [], 'DELIVERED')).toEqual([]); // values are fine
  });
});
