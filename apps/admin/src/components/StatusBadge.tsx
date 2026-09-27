import { Badge } from '@/components/ui/badge';

const TH: Record<string, string> = {
  DRAFT: 'ร่าง', PLANNED: 'วางแผนแล้ว', DISPATCHED: 'ส่งงานแล้ว', ACCEPTED: 'คนขับรับงาน', IN_TRANSIT: 'กำลังขนส่ง',
  COMPLETED: 'ส่งครบ รอปิด', CLOSED: 'ปิดงาน', CANCELLED: 'ยกเลิก', UNASSIGNED: 'รอจัดรถ', PICKED_UP: 'รับของแล้ว',
  DELIVERED: 'ส่งแล้ว', POD_VERIFIED: 'POD ผ่าน', POD_REJECTED: 'POD ไม่ผ่าน', FAILED: 'ส่งไม่สำเร็จ',
  submitted: 'รอตรวจ', verified: 'ผ่าน', rejected: 'ไม่ผ่าน',
};

export default function StatusBadge({ status }: { status: string }) {
  const variant = ['CANCELLED', 'FAILED', 'POD_REJECTED', 'rejected'].includes(status)
    ? 'destructive'
    : ['CLOSED', 'POD_VERIFIED', 'verified'].includes(status)
      ? 'default'
      : 'secondary';
  return <Badge variant={variant}>{TH[status] ?? status}</Badge>;
}
