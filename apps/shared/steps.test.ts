import { describe, expect, it } from 'vitest';
import { STEP_TH, STOP_STATUS_TH, stepLabel, stopStatusLabel } from './steps';

describe('Thai labels for driver steps and stop statuses', () => {
  it('labels stop steps and trip-level events, falling back to the raw code', () => {
    expect(stepLabel('ARRIVED')).toBe(STEP_TH.ARRIVED);
    expect(stepLabel('DELAYED')).toBe('ล่าช้า');
    expect(stepLabel('BREAKDOWN')).toBe('รถเสีย');
    expect(stepLabel('EXCEPTION')).toBe('เหตุอื่น');
    expect(stepLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('labels stop statuses, falling back to the raw status', () => {
    expect(STOP_STATUS_TH).toEqual({ PENDING: 'รอ', ARRIVED: 'ถึงแล้ว', WORKING: 'กำลังทำงาน', DONE: 'เสร็จ' });
    expect(stopStatusLabel('WORKING')).toBe('กำลังทำงาน');
    expect(stopStatusLabel('ODD')).toBe('ODD');
  });
});
