import type { Issue } from '../../lib/issues.js';
import type { PodField } from '../pod-templates/pod-templates.schemas.js';

export const DEFAULT_POD_FIELDS: PodField[] = [
  { key: 'goodsPhoto', label: 'รูปสินค้า', type: 'photo', required: true, min: 1, max: 5 },
  { key: 'receiverName', label: 'ชื่อผู้รับ', type: 'text', required: true },
  { key: 'receiverSign', label: 'ลายเซ็นผู้รับ', type: 'signature', required: true },
];

export interface PodFileRef {
  fieldKey: string;
  key: string;
  sha256: string;
  mime: string;
  bytes: number;
}

const issue = (code: string, key: string, message: string): Issue => ({ code, message, details: { field: key } });
const missing = (v: unknown) => v === undefined || v === null || v === '';
/** Required text must say something: whitespace alone counts as missing (P3-R14). */
const missingText = (v: unknown) => missing(v) || (typeof v === 'string' && v.trim() === '');

/** Keys MongoDB treats as operators or paths; stored answers must never contain them. */
const unsafeKey = (k: string) => k.startsWith('$') || k.includes('.');

/**
 * Every object key in `answers` (at any depth, arrays included) that starts with `$` or contains
 * `.`, as its path from the answers root, in document order. Iterative, so deep nesting cannot
 * overflow the stack.
 */
function unsafeKeyPaths(answers: Record<string, unknown>): (string | number)[][] {
  const found: (string | number)[][] = [];
  const stack: { value: unknown; path: (string | number)[] }[] = [{ value: answers, path: [] }];
  while (stack.length > 0) {
    const { value, path } = stack.pop()!;
    if (!value || typeof value !== 'object') continue;
    const children: { value: unknown; path: (string | number)[] }[] = [];
    if (Array.isArray(value)) value.forEach((v, i) => children.push({ value: v, path: [...path, i] }));
    else {
      for (const [k, v] of Object.entries(value)) {
        if (unsafeKey(k)) found.push([...path, k]);
        else children.push({ value: v, path: [...path, k] });
      }
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return found;
}

export function validatePodAnswers(fields: PodField[], answers: Record<string, unknown>, files: PodFileRef[], outcome: 'DELIVERED' | 'FAILED'): Issue[] {
  const issues: Issue[] = [];
  const enforce = outcome === 'DELIVERED';
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const path of unsafeKeyPaths(answers)) {
    issues.push({ code: 'INVALID_KEY', message: `Answer keys may not start with $ or contain a dot (${path.join(' › ')})`, details: { field: String(path[0]), path } });
  }
  for (const key of Object.keys(answers)) {
    if (unsafeKey(key)) continue; // already reported as INVALID_KEY
    const f = byKey.get(key);
    if (!f || f.type === 'photo' || f.type === 'signature') issues.push(issue('UNKNOWN_FIELD', key, `${key} is not an answer field of this form`));
  }
  for (const file of files) {
    const f = byKey.get(file.fieldKey);
    if (!f || (f.type !== 'photo' && f.type !== 'signature')) issues.push(issue('FILE_FIELD_MISMATCH', file.fieldKey, `${file.fieldKey} is not a photo or signature field`));
  }
  for (const f of fields) {
    const v = answers[f.key];
    const n = files.filter((x) => x.fieldKey === f.key).length;
    switch (f.type) {
      case 'photo': {
        const min = enforce ? (f.min ?? (f.required ? 1 : 0)) : 0;
        const max = f.max ?? 10;
        if (n < min || n > max) issues.push(issue('PHOTO_COUNT', f.key, `${f.label}: ${n} photo(s), expected ${min}–${max}`));
        break;
      }
      case 'signature':
        if (n > 1 || (enforce && f.required && n !== 1)) issues.push(issue('SIGNATURE_COUNT', f.key, `${f.label}: exactly one signature is required`));
        break;
      case 'text':
        if (missingText(v)) {
          if (enforce && f.required) issues.push(issue('FIELD_REQUIRED', f.key, `${f.label} is required`));
        } else if (typeof v !== 'string') issues.push(issue('INVALID_TYPE', f.key, `${f.label} must be text`));
        break;
      case 'number':
        if (missing(v)) {
          if (enforce && f.required) issues.push(issue('FIELD_REQUIRED', f.key, `${f.label} is required`));
        } else if (typeof v !== 'number' || !Number.isFinite(v)) issues.push(issue('INVALID_TYPE', f.key, `${f.label} must be a number`));
        else if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) issues.push(issue('OUT_OF_RANGE', f.key, `${f.label} must be between ${f.min ?? '−∞'} and ${f.max ?? '∞'}`));
        break;
      case 'select':
        if (missing(v)) {
          if (enforce && f.required) issues.push(issue('FIELD_REQUIRED', f.key, `${f.label} is required`));
        } else if (typeof v !== 'string' || !(f.options ?? []).includes(v)) issues.push(issue('INVALID_OPTION', f.key, `${f.label} must be one of the options`));
        break;
      case 'checkbox':
        // A required checkbox is a confirmation: only a tick (`true`) satisfies it (P3-R14).
        if (v !== undefined && typeof v !== 'boolean') issues.push(issue('INVALID_TYPE', f.key, `${f.label} must be true or false`));
        else if (v !== true && enforce && f.required) issues.push(issue('FIELD_REQUIRED', f.key, `${f.label} must be ticked`));
        break;
      case 'qtyLines':
      case 'palletLines': {
        const lineOk =
          f.type === 'qtyLines'
            ? (l: unknown) => !!l && typeof l === 'object' && typeof (l as { delivered?: unknown }).delivered === 'number' && (l as { delivered: number }).delivered >= 0
            : (l: unknown) => !!l && typeof l === 'object' && typeof (l as { type?: unknown }).type === 'string' && Number.isInteger((l as { qty?: unknown }).qty) && (l as { qty: number }).qty >= 0;
        if (missing(v) || (Array.isArray(v) && v.length === 0)) {
          if (enforce && f.required) issues.push(issue('FIELD_REQUIRED', f.key, `${f.label} is required`));
        } else if (!Array.isArray(v) || !v.every(lineOk)) issues.push(issue('INVALID_TYPE', f.key, `${f.label} has invalid lines`));
        break;
      }
    }
  }
  return issues;
}
