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
        // Mirrors the server's `min = f.min ?? (required ? 1 : 0)` exactly (pod-validation.ts):
        // an explicit `min` always wins over `required`, it isn't combined with it. `max`
        // likewise defaults to the server's 10 when the template doesn't set one.
        const count = blobCounts[f.key] ?? 0;
        const min = f.min ?? (f.required ? 1 : 0);
        const max = f.max ?? 10;
        if (count < min) problems.push(`ต้องถ่ายรูปอย่างน้อย ${min} รูป: ${f.label}`);
        if (count > max) problems.push(`ถ่ายรูปได้ไม่เกิน ${max} รูป: ${f.label}`);
        break;
      }
      case 'signature': {
        if (f.required && (blobCounts[f.key] ?? 0) < 1) problems.push(`ต้องเซ็นชื่อ: ${f.label}`);
        break;
      }
      case 'text': {
        // Server's `missing()` only treats undefined/null/'' as empty — a whitespace-only string
        // is a valid (present) text answer to it, so this doesn't trim before comparing either;
        // trimming here would reject something the server accepts.
        const v = answers[f.key];
        const empty = v === undefined || v === null || v === '';
        if (f.required && empty) problems.push(`ต้องกรอก: ${f.label}`);
        else if (!empty && typeof v !== 'string') problems.push(`ต้องเป็นข้อความ: ${f.label}`);
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
        // Server's required check for checkbox is literally `v === undefined` (pod-validation.ts
        // treats it like any other field's "missing" case) — it does not require the box to
        // actually be checked, only answered. That reads oddly for a confirmation checkbox, but
        // rejecting `false` here would be stricter than the server, so this matches it exactly:
        // once the driver has touched the control at all (true or false), it's "answered".
        if (f.required && answers[f.key] === undefined) problems.push(`ต้องยืนยัน: ${f.label}`);
        break;
      }
      case 'qtyLines': {
        // Pre-existing, deliberately under-strict gap (kept as-is, not part of this alignment
        // pass): an *untouched* qtyLines field is `undefined` here — PodPage only writes to
        // `answers` once the driver edits the input; the row it displays by default (planned ==
        // delivered) is display-only and never lands in `answers` unless edited. The server's
        // `missing()` treats an absent key the same as an explicit empty array and would reject
        // it when required, so an untouched required qtyLines field can still be rejected by the
        // server even though this local check lets it through. Only an explicit empty array is
        // flagged here, to avoid nagging the driver about a field they never had to touch.
        const raw = answers[f.key] as QtyLine[] | undefined;
        if (f.required && Array.isArray(raw) && raw.length === 0) problems.push(`ต้องมีอย่างน้อย 1 แถว: ${f.label}`);
        for (const line of raw ?? []) {
          if (typeof line.delivered !== 'number' || Number.isNaN(line.delivered) || line.delivered < 0) {
            problems.push(`จำนวนส่งจริงต้องเป็นตัวเลขไม่ติดลบ: ${f.label}`);
          }
        }
        break;
      }
      case 'palletLines': {
        // keptPalletLines mirrors what PodPage actually sends (junk rows — blank type or
        // qty <= 0 — are stripped from the payload before it reaches the server), so checking
        // the kept rows here matches what the server will really validate.
        const rows = keptPalletLines((answers[f.key] as PalletLine[] | undefined) ?? []);
        if (f.required && rows.length === 0) problems.push(`ต้องมีอย่างน้อย 1 แถว: ${f.label}`);
        // Server also requires each row's qty to be an integer (Number.isInteger); a fractional
        // qty survives keptPalletLines' `qty > 0` filter but would still fail server validation.
        for (const r of rows) {
          if (!Number.isInteger(r.qty)) problems.push(`จำนวนต้องเป็นจำนวนเต็ม: ${f.label}`);
        }
        break;
      }
    }
  }
  return problems;
}
