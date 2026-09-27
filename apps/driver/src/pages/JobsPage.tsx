import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiFetch, logout } from '@shared/api';
import { fmtBkk } from '@shared/time';
import type { DriverShipment } from '@shared/types';
import { canSubmitReason } from '@/lib/decline';

const TH: Record<string, string> = { DISPATCHED: 'งานใหม่', ACCEPTED: 'รับงานแล้ว', IN_TRANSIT: 'กำลังวิ่ง' };

export default function JobsPage() {
  const qc = useQueryClient();
  const [declineTarget, setDeclineTarget] = useState<{ id: string; version: number } | null>(null);
  const [declineReason, setDeclineReason] = useState('');
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: async () => (await apiFetch<{ items: DriverShipment[] }>('GET', '/api/v1/driver/shipments')).items, refetchInterval: 20_000 });
  const respond = useMutation({
    mutationFn: ({ id, version, action, reason }: { id: string; version: number; action: 'accept' | 'decline'; reason?: string }) =>
      apiFetch('POST', `/api/v1/driver/shipments/${id}/${action}`, action === 'decline' ? { version, reason } : { version }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['jobs'] }),
    onError: (e) => {
      toast.error(e instanceof ApiError && e.status === 409 ? 'งานถูกแก้ไขแล้ว — โหลดงานใหม่ให้แล้ว กรุณาตรวจสอบอีกครั้ง' : e instanceof ApiError ? e.message : 'ทำรายการไม่สำเร็จ');
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
  const closeDeclineDialog = () => {
    setDeclineTarget(null);
    setDeclineReason('');
  };
  const confirmDecline = () => {
    if (!declineTarget || !canSubmitReason(declineReason)) return;
    respond.mutate({ id: declineTarget.id, version: declineTarget.version, action: 'decline', reason: declineReason.trim() });
    closeDeclineDialog();
  };
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">งานของฉัน</h1>
        <div className="flex gap-2">
          <Button className="h-12" variant="outline" onClick={() => void jobs.refetch()}>
            รีเฟรช
          </Button>
          <Button className="h-12" variant="ghost" onClick={() => void logout()}>
            ออก
          </Button>
        </div>
      </div>
      {(jobs.data ?? []).length === 0 && !jobs.isLoading && <p className="text-center text-neutral-500">ยังไม่มีงาน</p>}
      {(jobs.data ?? []).map((j) => (
        <div key={j.id} className="space-y-2 rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="font-mono">{j.shipmentNo}</span>
            <Badge>{TH[j.status] ?? j.status}</Badge>
          </div>
          <p className="text-sm text-neutral-600">
            {fmtBkk(j.plannedStart)} – {fmtBkk(j.plannedEnd)} · {j.stops.length} จุด
          </p>
          <p className="text-sm">{j.locations.map((l) => l.name).join(' → ')}</p>
          {j.status === 'DISPATCHED' ? (
            <div className="grid grid-cols-2 gap-2">
              <Button className="h-14" onClick={() => respond.mutate({ id: j.id, version: j.version, action: 'accept' })}>
                รับงาน
              </Button>
              <Button className="h-14" variant="outline" onClick={() => setDeclineTarget({ id: j.id, version: j.version })}>
                ปฏิเสธ
              </Button>
            </div>
          ) : (
            <Button asChild className="h-12 w-full">
              <Link to={`/jobs/${j.id}`}>เปิดงาน</Link>
            </Button>
          )}
        </div>
      ))}
      <Dialog open={declineTarget !== null} onOpenChange={(open) => !open && closeDeclineDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ปฏิเสธงาน</DialogTitle>
            <DialogDescription>เหตุผลที่ปฏิเสธ</DialogDescription>
          </DialogHeader>
          <Textarea
            className="text-base md:text-base"
            placeholder="เช่น รถเสีย / ลาป่วย"
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" className="h-12" onClick={closeDeclineDialog}>
              ยกเลิก
            </Button>
            <Button className="h-12" disabled={!canSubmitReason(declineReason)} onClick={confirmDecline}>
              ยืนยัน
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
