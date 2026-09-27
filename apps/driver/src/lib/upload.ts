import { apiFetch } from '@shared/api';
import type { PodFile } from '@shared/types';
import { sha256Hex } from './image';

export async function uploadFile(shipmentId: string, doId: string, fieldKey: string, blob: Blob): Promise<PodFile> {
  const p = await apiFetch<{ key: string; url: string; headers: Record<string, string>; maxBytes: number }>('POST', '/api/v1/uploads/presign', {
    shipmentId,
    doId,
    contentType: 'image/jpeg',
  });
  if (blob.size > p.maxBytes) throw new Error('ไฟล์ใหญ่เกินกำหนด');
  const res = await fetch(p.url, { method: 'PUT', headers: p.headers, body: blob });
  if (!res.ok) throw new Error(`อัปโหลดไม่สำเร็จ (${res.status})`);
  return { fieldKey, key: p.key, sha256: await sha256Hex(blob), mime: 'image/jpeg', bytes: blob.size };
}
