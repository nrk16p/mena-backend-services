import { describe, expect, it } from 'vitest';
import { canSubmitReason } from './decline';

describe('canSubmitReason', () => {
  it('rejects empty or whitespace-only input', () => {
    expect(canSubmitReason('')).toBe(false);
    expect(canSubmitReason('   ')).toBe(false);
  });

  it('rejects fewer than 3 trimmed characters', () => {
    expect(canSubmitReason('ab')).toBe(false);
    expect(canSubmitReason('  ab  ')).toBe(false);
  });

  it('accepts 3 or more trimmed characters', () => {
    expect(canSubmitReason('abc')).toBe(true);
    expect(canSubmitReason('  abc  ')).toBe(true);
    expect(canSubmitReason('รถเสีย')).toBe(true);
  });
});
