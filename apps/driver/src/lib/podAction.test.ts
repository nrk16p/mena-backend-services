import { describe, expect, it } from 'vitest';
import { podActionState, podPageGuard } from './podAction';

describe('podActionState', () => {
  it('hides the button when the delivery order status is not POD-eligible', () => {
    expect(podActionState(new Set(['ARRIVED', 'UNLOAD_END']), 'DELIVERED')).toBe('hidden');
  });

  it('hides the button before the stop has arrived', () => {
    expect(podActionState(new Set(), 'PLANNED')).toBe('hidden');
  });

  it('waits (disabled, no link) once arrived but before unloading ends', () => {
    expect(podActionState(new Set(['ARRIVED']), 'PLANNED')).toBe('waiting');
    expect(podActionState(new Set(['ARRIVED', 'UNLOAD_START']), 'PICKED_UP')).toBe('waiting');
  });

  it('is ready (a real link) once unloading has ended', () => {
    expect(podActionState(new Set(['ARRIVED', 'UNLOAD_START', 'UNLOAD_END']), 'PICKED_UP')).toBe('ready');
    expect(podActionState(new Set(['ARRIVED', 'UNLOAD_END']), 'POD_REJECTED')).toBe('ready');
  });
});

describe('podPageGuard', () => {
  describe('delivered mode (failed=false)', () => {
    it('blocks the form before the stop has arrived', () => {
      expect(podPageGuard(new Set(), 'PLANNED', false)).toEqual({
        ok: false,
        message: 'ยังส่ง POD ไม่ได้ — กด “ลงสินค้าเสร็จ” ที่จุดส่งก่อน',
      });
    });

    it('blocks the form once arrived but before unloading ends (state "waiting")', () => {
      expect(podPageGuard(new Set(['ARRIVED']), 'PICKED_UP', false)).toEqual({
        ok: false,
        message: 'ยังส่ง POD ไม่ได้ — กด “ลงสินค้าเสร็จ” ที่จุดส่งก่อน',
      });
    });

    it('blocks the form for a DO status that is not POD-eligible at all (state "hidden")', () => {
      expect(podPageGuard(new Set(['ARRIVED', 'UNLOAD_END']), 'DELIVERED', false)).toEqual({
        ok: false,
        message: 'ยังส่ง POD ไม่ได้ — กด “ลงสินค้าเสร็จ” ที่จุดส่งก่อน',
      });
    });

    it('allows the form once unloading has ended (state "ready")', () => {
      expect(podPageGuard(new Set(['ARRIVED', 'UNLOAD_START', 'UNLOAD_END']), 'PICKED_UP', false)).toEqual({ ok: true });
    });
  });

  describe('failed mode (?failed=1)', () => {
    it('blocks reporting a failed delivery before the driver has arrived at the drop stop', () => {
      expect(podPageGuard(new Set(), 'PLANNED', true)).toEqual({
        ok: false,
        message: 'ต้องกด “ถึงจุดแล้ว” ก่อนแจ้งส่งไม่สำเร็จ',
      });
    });

    it('allows it once ARRIVED is recorded, even before unloading has started', () => {
      expect(podPageGuard(new Set(['ARRIVED']), 'PICKED_UP', true)).toEqual({ ok: true });
    });

    it('does not care about DO status — only whether ARRIVED happened at this stop', () => {
      expect(podPageGuard(new Set(['ARRIVED']), 'DELIVERED', true)).toEqual({ ok: true });
    });
  });
});
