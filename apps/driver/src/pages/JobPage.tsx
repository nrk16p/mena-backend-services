import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiFetch } from '@shared/api';
import { STEP_TH, nextStep } from '@shared/steps';
import type { DriverShipment, EventItem } from '@shared/types';
import PermissionBanner from '@/components/PermissionBanner';
import { createTapSender, type EventResult } from '../lib/events';
import { getPosition } from '../lib/gps';
import { podActionState } from '../lib/podAction';
import { useWakeLock } from '../lib/useWakeLock';

const REASONS = ['TRAFFIC', 'BREAKDOWN', 'WEATHER', 'CHECKPOINT', 'CONSIGNEE_CLOSED', 'NO_RECEIVER', 'WRONG_ADDRESS', 'OTHER'];
const tap = createTapSender((body) => apiFetch<{ results: EventResult[] }>('POST', '/api/v1/driver/events', body));

export default function JobPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ code: string; reason: string; note: string } | null>(null);
  useWakeLock(true);
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: async () => (await apiFetch<{ items: DriverShipment[] }>('GET', '/api/v1/driver/shipments')).items });
  const events = useQuery({ queryKey: ['job-events', id], queryFn: async () => (await apiFetch<{ items: EventItem[] }>('GET', `/api/v1/driver/shipments/${id}/events`)).items });
  const job = jobs.data?.find((j) => j.id === id);
  const done = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of events.data ?? []) if (e.stopId) m.set(e.stopId, new Set([...(m.get(e.stopId) ?? []), e.code]));
    return m;
  }, [events.data]);
  if (!job) return <p className="p-4">กำลังโหลด… {jobs.isFetched && <Link to="/" className="text-blue-700">กลับ</Link>}</p>;
  const locName = new Map(job.locations.map((l) => [l.id, l.name]));
  const dos = new Map(job.deliveryOrders.map((d) => [d.id, d]));
  const current = job.stops.find((s) => !(done.get(s.stopId)?.has('DEPARTED')));
  const currentDone = current ? (done.get(current.stopId) ?? new Set<string>()) : new Set<string>();
  const currentNext = current ? nextStep(current, currentDone) : null;

  const send = async (stopId: string | null, code: string, extra: { reasonCode?: string; note?: string } = {}) => {
    setBusy(true);
    try {
      const pos = await getPosition();
      const r = await tap({ shipmentId: job.id, stopId, code, ...pos, deviceTime: new Date().toISOString(), reasonCode: extra.reasonCode ?? null, note: extra.note ?? null });
      if (r.status === 'rejected') toast.error(r.message ?? r.code ?? 'ไม่สำเร็จ');
      else toast.success(`${STEP_TH[code] ?? code}${r.flags.length ? ` (${r.flags.join(', ')})` : ''}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'ส่งไม่สำเร็จ — ลองกดอีกครั้ง');
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['job-events', id] });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    }
  };

  return (
    <div className="space-y-3 p-4">
      <PermissionBanner />
      <div className="flex items-center justify-between">
        <button onClick={() => nav('/')} className="text-blue-700">
          ← งานของฉัน
        </button>
        <span className="font-mono text-sm">{job.shipmentNo}</span>
      </div>
      {job.stops.map((s) => {
        const d = done.get(s.stopId) ?? new Set<string>();
        const isCurrent = current?.stopId === s.stopId;
        const extras = [...new Set([...s.dropDoIds, ...s.pickupDoIds].flatMap((x) => dos.get(x)?.podForm.extraSteps ?? []))].filter((c) => !d.has(c));
        return (
          <div key={s.stopId} className={`space-y-2 rounded-lg border p-4 ${isCurrent ? 'border-blue-600 bg-white shadow' : 'bg-neutral-100'}`}>
            <div className="flex items-center justify-between">
              <span className="font-medium">
                {s.seq}. {locName.get(s.locationId)}
              </span>
              <span className="text-xs text-neutral-500">{[...d].map((c) => STEP_TH[c] ?? c).join(' · ')}</span>
            </div>
            <p className="text-sm text-neutral-600">
              {s.pickupDoIds.length > 0 && `รับ: ${s.pickupDoIds.map((x) => dos.get(x)?.doNo).join(', ')} `}
              {s.dropDoIds.length > 0 && `ส่ง: ${s.dropDoIds.map((x) => dos.get(x)?.doNo).join(', ')}`}
            </p>
            {isCurrent &&
              s.dropDoIds.map((doId) => {
                const o = dos.get(doId);
                if (!o) return null;
                const podState = podActionState(d, o.status);
                if (podState === 'hidden') return null;
                return (
                  <div key={doId} className="grid grid-cols-2 gap-2">
                    {podState === 'ready' ? (
                      <Button asChild className="h-12">
                        <Link to={`/jobs/${job.id}/pod/${doId}`}>POD {o.doNo}</Link>
                      </Button>
                    ) : (
                      <Button className="h-12" disabled>
                        POD {o.doNo}
                      </Button>
                    )}
                    <Button asChild variant="outline" className="h-12">
                      <Link to={`/jobs/${job.id}/pod/${doId}?failed=1`}>ส่งไม่สำเร็จ</Link>
                    </Button>
                  </div>
                );
              })}
            {isCurrent && d.has('ARRIVED') && !d.has('DEPARTED') && extras.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {extras.map((c) => (
                  <Button key={c} className="h-12" variant="secondary" disabled={busy} onClick={() => void send(s.stopId, c)}>
                    {STEP_TH[c] ?? c}
                  </Button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {current && currentNext && (
        <div className="sticky bottom-0 -mx-4 border-t bg-white p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <Button className="h-14 w-full text-lg" disabled={busy} onClick={() => void send(current.stopId, currentNext)}>
            {STEP_TH[currentNext] ?? currentNext}
          </Button>
        </div>
      )}
      <Button variant="outline" className="h-12 w-full" onClick={() => setProblem({ code: 'DELAYED', reason: 'TRAFFIC', note: '' })}>
        แจ้งปัญหา / ล่าช้า
      </Button>
      <Dialog open={!!problem} onOpenChange={(o) => !o && setProblem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>แจ้งปัญหา</DialogTitle>
          </DialogHeader>
          {problem && (
            <div className="space-y-3">
              <Select value={problem.code} onValueChange={(v) => setProblem({ ...problem, code: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DELAYED">ล่าช้า</SelectItem>
                  <SelectItem value="BREAKDOWN">รถเสีย</SelectItem>
                  <SelectItem value="EXCEPTION">เหตุอื่น</SelectItem>
                </SelectContent>
              </Select>
              <Select value={problem.reason} onValueChange={(v) => setProblem({ ...problem, reason: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Textarea placeholder="รายละเอียด" value={problem.note} onChange={(e) => setProblem({ ...problem, note: e.target.value })} />
              {problem.reason === 'OTHER' && !problem.note.trim() && <p className="text-sm text-red-600">เหตุอื่น (OTHER) ต้องระบุรายละเอียด</p>}
            </div>
          )}
          <DialogFooter>
            <Button
              className="h-12"
              disabled={busy || (problem?.reason === 'OTHER' && !problem.note.trim())}
              onClick={() => {
                if (!problem) return;
                void send(null, problem.code, { reasonCode: problem.reason, note: problem.note || undefined });
                setProblem(null);
              }}
            >
              ส่ง
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
