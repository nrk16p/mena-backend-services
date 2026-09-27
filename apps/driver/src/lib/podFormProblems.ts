import type { PodField } from '@shared/types';

/** The one FAIL_REASONS value (see PodPage) that additionally requires a note. */
const OTHER_REASON = 'OTHER';

type QtyLine = { planned: number; delivered: number; unit: string };
type PalletLine = { type: string; qty: number };

/** Drops palletLines rows with a blank type or a non-positive qty — used both to trim the
 * payload before upload and, here, to decide whether a required palletLines field is really
 * empty once junk rows are ignored. */
export function keptPalletLines(rows: PalletLine[]): PalletLine[] {
  return rows.filter((r) => r.type.trim() !== '' && r.qty > 0);
}

/**
 * Local, offline completeness check mirroring the POD form rules the server also enforces.
 * Returns Thai messages for every problem found — an empty array means the form is locally
 * complete enough to attempt an upload/submit. The server's POD_INVALID path stays the final
 * authority; this only saves a doomed upload on a driver's limited data/battery.
 *
 * `blobCounts` is the number of captured blobs per photo/signature field key (from the page's
 * `blobs` state). In `failed` mode only `answers.reason` and, when it's OTHER, `answers.note`
 * are checked — the fields shown for a failed delivery are supporting photos, not gated by
 * `required` the way a normal delivery's form is.
 */
export function podFormProblems(fields: PodField[], answers: Record<string, unknown>, blobCounts: Record<string, number>, failed: boolean): string[] {
  if (failed) {
    const problems: string[] = [];
    const reason = ((answers.reason as string | undefined) ?? '').trim();
    if (!reason) problems.push('กรุณาเลือกเหตุผล');
    if (reason === OTHER_REASON && !((answers.note as string | undefined) ?? '').trim()) {
      problems.push('กรุณาระบุรายละเอียด เมื่อเลือกเหตุผลอื่น ๆ (OTHER)');
    }
    return problems;
  }

  const problems: string[] = [];
  for (const f of fields) {
    switch (f.type) {
      case 'photo': {
        const count = blobCounts[f.key] ?? 0;
        const min = Math.max(f.min ?? 0, f.required ? 1 : 0);
        if (count < min) problems.push(`ต้องถ่ายรูปอย่างน้อย ${min} รูป: ${f.label}`);
        if (f.max !== undefined && count > f.max) problems.push(`ถ่ายรูปได้ไม่เกิน ${f.max} รูป: ${f.label}`);
        break;
      }
      case 'signature': {
        if (f.required && (blobCounts[f.key] ?? 0) < 1) problems.push(`ต้องเซ็นชื่อ: ${f.label}`);
        break;
      }
      case 'text': {
        if (f.required && !((answers[f.key] as string | undefined) ?? '').trim()) problems.push(`ต้องกรอก: ${f.label}`);
        break;
      }
      case 'number': {
        const v = answers[f.key];
        const isEmpty = v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v));
        if (f.required && isEmpty) {
          problems.push(`ต้องกรอก: ${f.label}`);
        } else if (typeof v === 'number' && !Number.isNaN(v)) {
          if (f.min !== undefined && v < f.min) problems.push(`${f.label} ต้องไม่น้อยกว่า ${f.min}`);
          if (f.max !== undefined && v > f.max) problems.push(`${f.label} ต้องไม่เกิน ${f.max}`);
        }
        break;
      }
      case 'select': {
        const v = (answers[f.key] as string | undefined) ?? '';
        if (f.required && !v) {
          problems.push(`ต้องเลือก: ${f.label}`);
        } else if (v && f.options && !f.options.includes(v)) {
          problems.push(`ค่าที่เลือกไม่ถูกต้อง: ${f.label}`);
        }
        break;
      }
      case 'checkbox': {
        if (f.required && answers[f.key] !== true) problems.push(`ต้องยืนยัน: ${f.label}`);
        break;
      }
      case 'qtyLines': {
        const lines = (answers[f.key] as QtyLine[] | undefined) ?? [];
        for (const line of lines) {
          if (typeof line.delivered !== 'number' || Number.isNaN(line.delivered) || line.delivered < 0) {
            problems.push(`จำนวนส่งจริงต้องเป็นตัวเลขไม่ติดลบ: ${f.label}`);
          }
        }
        break;
      }
      case 'palletLines': {
        const rows = (answers[f.key] as PalletLine[] | undefined) ?? [];
        if (f.required && keptPalletLines(rows).length === 0) problems.push(`ต้องมีอย่างน้อย 1 แถว: ${f.label}`);
        break;
      }
    }
  }
  return problems;
}
