export function stopSequence(hasDrops: boolean, hasPickups: boolean): string[] {
  return ['ARRIVED', ...(hasDrops ? ['UNLOAD_START', 'UNLOAD_END'] : []), ...(hasPickups ? ['LOAD_START', 'LOAD_END'] : []), 'DEPARTED'];
}

export function nextStep(stop: { pickupDoIds: string[]; dropDoIds: string[] }, done: Set<string>): string | null {
  return stopSequence(stop.dropDoIds.length > 0, stop.pickupDoIds.length > 0).find((c) => !done.has(c)) ?? null;
}

export const STEP_TH: Record<string, string> = {
  ARRIVED: 'ถึงจุดแล้ว', UNLOAD_START: 'เริ่มลงสินค้า', UNLOAD_END: 'ลงสินค้าเสร็จ', LOAD_START: 'เริ่มขึ้นสินค้า',
  LOAD_END: 'ขึ้นสินค้าเสร็จ', DEPARTED: 'ออกจากจุด', DOCS_SUBMITTED: 'ยื่นเอกสาร', DOCS_RETURNED: 'รับเอกสารคืน',
  SEAL_CHECKED: 'ตรวจซีล', TEMP_CHECKED: 'ตรวจอุณหภูมิ',
};
