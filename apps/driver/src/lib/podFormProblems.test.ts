import { describe, expect, it } from 'vitest';
import type { PodField } from '@shared/types';
import { keptPalletLines, podFormProblems } from './podFormProblems';

const field = (overrides: Partial<PodField> & Pick<PodField, 'key' | 'label' | 'type'>): PodField => ({
  required: false,
  ...overrides,
});

describe('podFormProblems — normal delivery', () => {
  it('is empty when there are no fields', () => {
    expect(podFormProblems([], {}, {}, false)).toEqual([]);
  });

  it('requires at least one photo when a photo field is required (no explicit min)', () => {
    const f = field({ key: 'productPhoto', label: 'รูปสินค้า', type: 'photo', required: true });
    expect(podFormProblems([f], {}, {}, false)).toEqual(['ต้องถ่ายรูปอย่างน้อย 1 รูป: รูปสินค้า']);
    expect(podFormProblems([f], {}, { productPhoto: 1 }, false)).toEqual([]);
  });

  it('honors an explicit min greater than 1', () => {
    const f = field({ key: 'productPhoto', label: 'รูปสินค้า', type: 'photo', required: true, min: 2 });
    expect(podFormProblems([f], {}, { productPhoto: 1 }, false)).toEqual(['ต้องถ่ายรูปอย่างน้อย 2 รูป: รูปสินค้า']);
  });

  it('rejects more photos than max', () => {
    const f = field({ key: 'productPhoto', label: 'รูปสินค้า', type: 'photo', max: 3 });
    expect(podFormProblems([f], {}, { productPhoto: 4 }, false)).toEqual(['ถ่ายรูปได้ไม่เกิน 3 รูป: รูปสินค้า']);
    expect(podFormProblems([f], {}, { productPhoto: 3 }, false)).toEqual([]);
  });

  it('does not require an optional photo field', () => {
    const f = field({ key: 'extraPhoto', label: 'รูปเพิ่มเติม', type: 'photo' });
    expect(podFormProblems([f], {}, {}, false)).toEqual([]);
  });

  it('requires a signature when the field is required', () => {
    const f = field({ key: 'sig', label: 'ลายเซ็น', type: 'signature', required: true });
    expect(podFormProblems([f], {}, {}, false)).toEqual(['ต้องเซ็นชื่อ: ลายเซ็น']);
    expect(podFormProblems([f], {}, { sig: 1 }, false)).toEqual([]);
  });

  it('requires a non-blank text field', () => {
    const f = field({ key: 'note', label: 'หมายเหตุ', type: 'text', required: true });
    expect(podFormProblems([f], {}, {}, false)).toEqual(['ต้องกรอก: หมายเหตุ']);
    expect(podFormProblems([f], { note: '   ' }, {}, false)).toEqual(['ต้องกรอก: หมายเหตุ']);
    expect(podFormProblems([f], { note: 'ok' }, {}, false)).toEqual([]);
  });

  it('checks a required number and its min/max bounds', () => {
    const f = field({ key: 'temp', label: 'อุณหภูมิ', type: 'number', required: true, min: 0, max: 10 });
    expect(podFormProblems([f], {}, {}, false)).toEqual(['ต้องกรอก: อุณหภูมิ']);
    expect(podFormProblems([f], { temp: -1 }, {}, false)).toEqual(['อุณหภูมิ ต้องไม่น้อยกว่า 0']);
    expect(podFormProblems([f], { temp: 11 }, {}, false)).toEqual(['อุณหภูมิ ต้องไม่เกิน 10']);
    expect(podFormProblems([f], { temp: 5 }, {}, false)).toEqual([]);
  });

  it('treats an unparsed number (NaN) as empty for the required check', () => {
    const f = field({ key: 'temp', label: 'อุณหภูมิ', type: 'number', required: true });
    expect(podFormProblems([f], { temp: Number.NaN }, {}, false)).toEqual(['ต้องกรอก: อุณหภูมิ']);
  });

  it('requires a select value and checks option membership', () => {
    const f = field({ key: 'grade', label: 'เกรด', type: 'select', required: true, options: ['A', 'B'] });
    expect(podFormProblems([f], {}, {}, false)).toEqual(['ต้องเลือก: เกรด']);
    expect(podFormProblems([f], { grade: 'C' }, {}, false)).toEqual(['ค่าที่เลือกไม่ถูกต้อง: เกรด']);
    expect(podFormProblems([f], { grade: 'A' }, {}, false)).toEqual([]);
  });

  it('requires a checked checkbox when required', () => {
    const f = field({ key: 'ack', label: 'ยืนยัน', type: 'checkbox', required: true });
    expect(podFormProblems([f], { ack: false }, {}, false)).toEqual(['ต้องยืนยัน: ยืนยัน']);
    expect(podFormProblems([f], { ack: true }, {}, false)).toEqual([]);
  });

  it('flags a negative or non-numeric qtyLines delivered value', () => {
    const f = field({ key: 'lines', label: 'รายการ', type: 'qtyLines' });
    expect(podFormProblems([f], { lines: [{ planned: 10, delivered: -1, unit: 'kg' }] }, {}, false)).toEqual([
      'จำนวนส่งจริงต้องเป็นตัวเลขไม่ติดลบ: รายการ',
    ]);
    expect(podFormProblems([f], { lines: [{ planned: 10, delivered: Number.NaN, unit: 'kg' }] }, {}, false)).toEqual([
      'จำนวนส่งจริงต้องเป็นตัวเลขไม่ติดลบ: รายการ',
    ]);
    expect(podFormProblems([f], { lines: [{ planned: 10, delivered: 0, unit: 'kg' }] }, {}, false)).toEqual([]);
  });

  it('does not flag qtyLines when the driver never touched it (page supplies its own default)', () => {
    const f = field({ key: 'lines', label: 'รายการ', type: 'qtyLines', required: true });
    expect(podFormProblems([f], {}, {}, false)).toEqual([]);
  });

  it('requires at least one real row for a required palletLines field, ignoring blank/zero-qty rows', () => {
    const f = field({ key: 'pallets', label: 'พาเลท', type: 'palletLines', required: true });
    expect(podFormProblems([f], { pallets: [] }, {}, false)).toEqual(['ต้องมีอย่างน้อย 1 แถว: พาเลท']);
    expect(
      podFormProblems([f], { pallets: [{ type: '', qty: 5 }, { type: 'ไม้', qty: 0 }] }, {}, false),
    ).toEqual(['ต้องมีอย่างน้อย 1 แถว: พาเลท']);
    expect(podFormProblems([f], { pallets: [{ type: 'ไม้', qty: 2 }] }, {}, false)).toEqual([]);
  });

  it('collects problems from multiple fields in order', () => {
    const fields: PodField[] = [
      field({ key: 'a', label: 'A', type: 'text', required: true }),
      field({ key: 'b', label: 'B', type: 'number', required: true }),
    ];
    expect(podFormProblems(fields, {}, {}, false)).toEqual(['ต้องกรอก: A', 'ต้องกรอก: B']);
  });
});

describe('podFormProblems — failed delivery', () => {
  it('requires a reason', () => {
    expect(podFormProblems([], { reason: '' }, {}, true)).toEqual(['กรุณาเลือกเหตุผล']);
    expect(podFormProblems([], { reason: '  ' }, {}, true)).toEqual(['กรุณาเลือกเหตุผล']);
  });

  it('requires a note only when the reason is OTHER', () => {
    expect(podFormProblems([], { reason: 'CONSIGNEE_CLOSED', note: '' }, {}, true)).toEqual([]);
    expect(podFormProblems([], { reason: 'OTHER', note: '' }, {}, true)).toEqual([
      'กรุณาระบุรายละเอียด เมื่อเลือกเหตุผลอื่น ๆ (OTHER)',
    ]);
    expect(podFormProblems([], { reason: 'OTHER', note: '  ' }, {}, true)).toEqual([
      'กรุณาระบุรายละเอียด เมื่อเลือกเหตุผลอื่น ๆ (OTHER)',
    ]);
    expect(podFormProblems([], { reason: 'OTHER', note: 'สินค้าเสียหายเพิ่มเติม' }, {}, true)).toEqual([]);
  });

  it('ignores template field rules entirely in failed mode', () => {
    const f = field({ key: 'productPhoto', label: 'รูปสินค้า', type: 'photo', required: true });
    expect(podFormProblems([f], { reason: 'CONSIGNEE_CLOSED', note: '' }, {}, true)).toEqual([]);
  });
});

describe('keptPalletLines', () => {
  it('drops rows with a blank type or a non-positive qty', () => {
    expect(
      keptPalletLines([
        { type: '', qty: 5 },
        { type: '  ', qty: 3 },
        { type: 'ไม้', qty: 0 },
        { type: 'ไม้', qty: -1 },
        { type: 'ไม้', qty: 2 },
      ]),
    ).toEqual([{ type: 'ไม้', qty: 2 }]);
  });

  it('keeps every valid row', () => {
    const rows = [
      { type: 'ไม้', qty: 2 },
      { type: 'พลาสติก', qty: 1 },
    ];
    expect(keptPalletLines(rows)).toEqual(rows);
  });
});
