import { describe, expect, it } from 'vitest';
import { splitCompletenessIssues } from './ShipmentNewPage';

describe('splitCompletenessIssues', () => {
  it('routes the six completeness codes to "completeness" and leaves other errors blocking', () => {
    const errors = [
      { code: 'HEAD_REQUIRED', message: 'a' },
      { code: 'HEAD_DRIVER_REQUIRED', message: 'b' },
      { code: 'TAIL_REQUIRED', message: 'c' },
      { code: 'TAIL_DRIVER_REQUIRED', message: 'd' },
      { code: 'DOS_REQUIRED', message: 'e' },
      { code: 'STOPS_REQUIRED', message: 'f' },
      { code: 'OVERLAPPING_SHIPMENT', message: 'g' },
    ];
    const { blocking, completeness } = splitCompletenessIssues(errors);
    expect(completeness.map((e) => e.code)).toEqual(['HEAD_REQUIRED', 'HEAD_DRIVER_REQUIRED', 'TAIL_REQUIRED', 'TAIL_DRIVER_REQUIRED', 'DOS_REQUIRED', 'STOPS_REQUIRED']);
    expect(blocking.map((e) => e.code)).toEqual(['OVERLAPPING_SHIPMENT']);
  });

  it('returns empty arrays for an empty input', () => {
    expect(splitCompletenessIssues([])).toEqual({ blocking: [], completeness: [] });
  });

  it('treats all-blocking input as fully blocking', () => {
    const errors = [{ code: 'OVERLAPPING_SHIPMENT', message: 'g' }];
    expect(splitCompletenessIssues(errors)).toEqual({ blocking: errors, completeness: [] });
  });
});
