import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { describeError } from './errors';

describe('describeError', () => {
  it('returns the fallback for a non-Error value', () => {
    expect(describeError('nope')).toBe('ทำรายการไม่สำเร็จ');
    expect(describeError(undefined)).toBe('ทำรายการไม่สำเร็จ');
  });

  it('accepts a custom fallback', () => {
    expect(describeError(null, 'เข้าสู่ระบบไม่สำเร็จ')).toBe('เข้าสู่ระบบไม่สำเร็จ');
  });

  it('returns the message for a plain Error', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('returns just the message for an ApiError with no details', () => {
    const e = new ApiError(500, 'INTERNAL', 'server exploded');
    expect(describeError(e)).toBe('server exploded');
  });

  it('appends up to 5 bulleted messages from details.errors', () => {
    const e = new ApiError(422, 'SHIPMENT_INVALID', 'bad shipment', {
      errors: [1, 2, 3, 4, 5, 6].map((n) => ({ message: `err ${n}` })),
    });
    expect(describeError(e)).toBe('bad shipment\n• err 1\n• err 2\n• err 3\n• err 4\n• err 5');
  });

  it('falls back to details.warnings when there are no errors', () => {
    const e = new ApiError(422, 'SHIPMENT_INVALID', 'bad shipment', { errors: [], warnings: [{ message: 'watch out' }] });
    expect(describeError(e)).toBe('bad shipment\n• watch out');
  });

  it('falls back to details.issues when there are no errors or warnings', () => {
    const e = new ApiError(422, 'SHIPMENT_INVALID', 'bad shipment', { issues: [{ message: 'issue A' }] });
    expect(describeError(e)).toBe('bad shipment\n• issue A');
  });

  it('reads a Fastify-style validation array directly from details', () => {
    const e = new ApiError(400, 'FST_ERR_VALIDATION', 'validation failed', [{ message: 'body.qty must be > 0' }]);
    expect(describeError(e)).toBe('validation failed\n• body.qty must be > 0');
  });

  it('ignores empty detail arrays and non-message items', () => {
    const e = new ApiError(422, 'SHIPMENT_INVALID', 'bad shipment', { errors: [], warnings: [], issues: [{ code: 'X' }] });
    expect(describeError(e)).toBe('bad shipment');
  });
});
