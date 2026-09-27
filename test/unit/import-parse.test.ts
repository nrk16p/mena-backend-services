import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseTable } from '../../src/modules/imports/parse.js';

describe('parseTable', () => {
  it('parses CSV with BOM and Thai text, lower-casing headers', async () => {
    const csv = '﻿Code,Name\nBKK,กรุงเทพ\n\nNE,อีสาน\n';
    const rows = await parseTable(Buffer.from(csv, 'utf8'), 'zones.csv');
    expect(rows.map((r) => r.values)).toEqual([{ code: 'BKK', name: 'กรุงเทพ' }, { code: 'NE', name: 'อีสาน' }]);
  });

  it('parses xlsx numbers, formulas and dates as display strings', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('data');
    ws.addRow(['code', 'lat', 'radius', 'expiry']);
    ws.addRow(['SRB', 14.53, null, new Date('2027-05-31T00:00:00Z')]);
    ws.getCell('C2').value = { formula: '100*3', result: 300 };
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const rows = await parseTable(buf, 'x.xlsx');
    expect(rows).toEqual([{ rowNumber: 2, values: { code: 'SRB', lat: '14.53', radius: '300', expiry: '2027-05-31' } }]);
  });

  it('rejects other file types', async () => {
    await expect(parseTable(Buffer.from('x'), 'x.txt')).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
  });
});
