import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { apiFetch } from '@shared/api';
import { describeError } from '@shared/errors';
import { fmtBkk } from '@shared/time';
import type { Page, Pod } from '@shared/types';
import { hasRole } from '../components/RequireAuth';
import StatusBadge from '../components/StatusBadge';

export default function PodReviewPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const list = useQuery({
    queryKey: ['pods', 'submitted'],
    queryFn: () => apiFetch<Page<Pod>>('GET', '/api/v1/pods?status=submitted&limit=100'),
    refetchInterval: 10_000,
  });
  // Photo links are presigned for 5 minutes; refresh the detail before they expire.
  const detail = useQuery({
    queryKey: ['pod', selected],
    queryFn: () => apiFetch<Pod>('GET', `/api/v1/pods/${selected}`),
    enabled: !!selected,
    refetchInterval: 240_000,
  });
  const review = useMutation({
    mutationFn: ({ action, reason }: { action: 'verify' | 'reject'; reason?: string }) =>
      apiFetch<Pod>('POST', `/api/v1/pods/${selected}/${action}`, action === 'reject' ? { reason } : {}),
    onSuccess: (p) => {
      toast.success(p.status === 'verified' ? 'ผ่านแล้ว' : 'ตีกลับแล้ว');
      setSelected(null);
      setRejectOpen(false);
      setRejectReason('');
      void qc.invalidateQueries({ queryKey: ['pods'] });
    },
    onError: (e) => {
      toast.error(describeError(e, 'ทำรายการไม่สำเร็จ'));
      // Someone else may have reviewed it meanwhile: reload the queue and this POD.
      void qc.invalidateQueries({ queryKey: ['pods'] });
      void qc.invalidateQueries({ queryKey: ['pod', selected] });
    },
  });
  const p = detail.data;
  const canReview = hasRole('admin') || hasRole('planner');
  const submitReject = () => {
    const reason = rejectReason.trim();
    if (reason.length < 3) return;
    review.mutate({ action: 'reject', reason });
  };
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">POD รอตรวจ ({list.data?.items.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {(list.data?.items ?? []).map((x) => (
            <button
              key={x.id}
              onClick={() => setSelected(x.id)}
              className={`w-full rounded border px-2 py-1 text-left text-sm ${selected === x.id ? 'border-blue-600 bg-blue-50' : 'bg-white'}`}
            >
              <span className="font-mono text-xs">{x.id.slice(-6)}</span> · {x.outcome === 'DELIVERED' ? 'ส่งสำเร็จ' : `ไม่สำเร็จ (${x.reasonCode})`}
              {x.flags.length > 0 && <span className="ml-1 text-xs text-amber-700">⚑ {x.flags.join(', ')}</span>}
              <div className="text-xs text-neutral-500">{fmtBkk(x.evidence.deviceTime)}</div>
            </button>
          ))}
          {list.data && list.data.items.length === 0 && <p className="text-sm text-neutral-500">ไม่มี POD รอตรวจ</p>}
        </CardContent>
      </Card>
      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">รายละเอียด</CardTitle>
        </CardHeader>
        <CardContent>
          {!p ? (
            <p className="text-sm text-neutral-500">เลือก POD ทางซ้าย</p>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2">
                <StatusBadge status={p.status} />
                <span>{p.outcome === 'DELIVERED' ? 'ส่งสำเร็จ' : `ส่งไม่สำเร็จ — ${p.reasonCode}${p.note ? `: ${p.note}` : ''}`}</span>
              </div>
              <dl className="grid grid-cols-2 gap-1">
                {Object.entries(p.answers).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-neutral-500">{k}</dt>
                    <dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
                  </div>
                ))}
              </dl>
              <div className="flex flex-wrap gap-2">
                {(p.fileUrls ?? []).map((f) => (
                  <a key={f.key} href={f.url} target="_blank" rel="noreferrer">
                    <img src={f.url} alt={f.key} className="h-32 rounded border object-cover" />
                  </a>
                ))}
              </div>
              <div className="rounded bg-neutral-50 p-2 text-xs">
                <p>
                  เวลาที่เครื่อง: {fmtBkk(p.evidence.deviceTime)} · รับที่เซิร์ฟเวอร์: {fmtBkk(p.evidence.receivedAt)}
                </p>
                <p>
                  ระยะจากจุดส่ง: {p.evidence.geofenceDistanceM ?? '-'} ม. · ความแม่นยำ GPS: {p.evidence.accuracyM ?? '-'} ม. · ออฟไลน์: {p.evidence.offline ? 'ใช่' : 'ไม่'}
                </p>
                {p.flags.length > 0 && <p className="text-amber-700">ข้อสังเกต: {p.flags.join(', ')}</p>}
                <p className="break-all font-mono">hash: {p.hash}</p>
              </div>
              {canReview && p.status === 'submitted' && (
                <div className="flex gap-2">
                  <Button disabled={review.isPending} onClick={() => review.mutate({ action: 'verify' })}>
                    ผ่าน
                  </Button>
                  <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
                    <DialogTrigger asChild>
                      <Button variant="destructive" disabled={review.isPending}>
                        ไม่ผ่าน
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>เหตุผลที่ไม่ผ่าน</DialogTitle>
                      </DialogHeader>
                      <div className="space-y-1">
                        <Label htmlFor="reject-reason">เหตุผล</Label>
                        <Textarea
                          id="reject-reason"
                          autoFocus
                          value={rejectReason}
                          onChange={(e) => setRejectReason(e.target.value)}
                          placeholder="ระบุเหตุผลอย่างน้อย 3 ตัวอักษร"
                        />
                      </div>
                      <DialogFooter>
                        <Button variant="destructive" disabled={rejectReason.trim().length < 3 || review.isPending} onClick={submitReject}>
                          ยืนยันไม่ผ่าน
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
