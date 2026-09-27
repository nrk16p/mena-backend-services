import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { badRequest } from '../../lib/errors.js';

export type ParsedRow = { rowNumber: number; values: Record<string, string> };

const normHeader = (h: string) => h.trim().toLowerCase();

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellText((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('');
    if ('text' in v) return String((v as ExcelJS.CellHyperlinkValue).text);
    return '';
  }
  return String(v);
}

export async function parseTable(buf: Buffer, filename: string): Promise<ParsedRow[]> {
  const name = filename.toLowerCase();
  if (name.endsWith('.csv')) {
    const records = parse(buf, {
      columns: (header: string[]) => header.map(normHeader),
      skip_empty_lines: true,
      trim: true,
      bom: true,
      info: true,
    }) as { record: Record<string, string>; info: { lines: number } }[];
    return records.map((r) => ({ rowNumber: r.info.lines, values: r.record }));
  }
  if (name.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col] = normHeader(cellText(cell.value));
    });
    const rows: ParsedRow[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const values: Record<string, string> = {};
      headers.forEach((h, col) => {
        if (h) values[h] = cellText(row.getCell(col).value).trim();
      });
      if (Object.values(values).some((v) => v !== '')) rows.push({ rowNumber, values });
    });
    return rows;
  }
  throw badRequest('UNSUPPORTED_FILE', 'Upload a .csv or .xlsx file');
}
