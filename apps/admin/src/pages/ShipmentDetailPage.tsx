import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiFetch, openAuthedFile } from '@shared/api';
import { describeError } from '@shared/errors';
import { fmtBkk } from '@shared/time';
import type { EventItem, Shipment, ShipmentStatus } from '@shared/types';
import IssueList from '../components/IssueList';
import { hasRole } from '../components/RequireAuth';
import StatusBadge from '../components/StatusBadge';
import { useNameMap } from '../lib/master';

export type ShipmentAction = 'plan' | 'dispatch' | 'cancel' | 'close' | 'pdf';

/**
 * Which action button(s) the detail page's header should offer for a shipment's current status
 * and the caller's roles. Plan, dispatch, cancel, and close require admin or planner roles.
 * PDF is available to all staff roles. Pure, so it's unit-testable without mounting the page.
 */
export function availableActions(status: ShipmentStatus, roles: string[]): ShipmentAction[] {
  const hasEditRole = roles.includes('admin') || roles.includes('planner');
  const actions: ShipmentAction[] = [];
  if (status === 'DRAFT' && hasEditRole) actions.push('plan');
  if (status === 'PLANNED' && hasEditRole) actions.push('dispatch');
  if (['DRAFT', 'PLANNED', 'DISPATCHED', 'ACCEPTED'].includes(status) && hasEditRole) actions.push('cancel');
  if (status === 'COMPLETED' && hasEditRole) actions.push('close');
  if (status === 'CLOSED') actions.push('pdf');
  return actions;
}

export default function ShipmentDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const plates = useNameMap('/vehicles', 'plate');
  const drivers = useNameMap('/drivers');
  const locations = useNameMap('/locations');
  const sh = useQuery({ queryKey: ['shipment', id], queryFn: () => apiFetch<Shipment>('GET', `/api/v1/shipments/${id}`), refetchInterval: 10_000 });
  const live = sh.data && ['ACCEPTED', 'IN_TRANSIT', 'COMPLETED'].includes(sh.data.status);
  const events = useQuery({
    queryKey: ['events', id],
    queryFn: async () => (await apiFetch<{ items: EventItem[] }>('GET', `/api/v1/shipments/${id}/events`)).items,
    refetchInterval: live ? 10_000 : false,
  });
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: object }) => apiFetch<Shipment>('POST', `/api/v1/shipments/${id}/${path}`, body),
    onSuccess: () => {
      toast.success('บันทึกแล้ว');
      void qc.invalidateQueries({ queryKey: ['shipment', id] });
      void qc.invalidateQueries({ queryKey: ['shipments'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) toast.error('มีคนแก้ไขพร้อมกัน — โหลดข้อมูลใหม่แล้ว');
      else toast.error(describeError(e));
      void qc.invalidateQueries({ queryKey: ['shipment', id] });
    },
  });
  if (!sh.data) return <p>กำลังโหลด…</p>;
  const s = sh.data;
  const doNo = new Map((s.deliveryOrders ?? []).map((d) => [d.id, d.doNo]));
  const v = { version: s.version };
  const roles = [hasRole('admin') ? 'admin' : null, hasRole('planner') ? 'planner' : null].filter((r): r is string => r !== null);
  const actions = availableActions(s.status, roles);
  const submitCancel = () => {
    const reason = cancelReason.trim();
    if (reason.length < 3) return;
    act.mutate({ path: 'cancel', body: { ...v, reason } });
    setCancelOpen(false);
    setCancelReason('');
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h1 className="font-mono text-xl font-semibold">{s.shipmentNo}</h1>
          <StatusBadge status={s.status} />
          <span className="text-xs text-neutral-500">v{s.version}</span>
        </div>
        <div className="flex gap-2">
          {actions.includes('plan') && <Button onClick={() => act.mutate({ path: 'plan', body: v })}>วางแผน</Button>}
          {actions.includes('dispatch') && <Button onClick={() => act.mutate({ path: 'dispatch', body: v })}>ส่งงานให้คนขับ</Button>}
          {actions.includes('cancel') && (
            <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">ยกเลิก</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>ยกเลิกเที่ยวขนส่ง {s.shipmentNo}</DialogTitle>
                </DialogHeader>
                <div className="space-y-1">
                  <Label htmlFor="cancel-reason">เหตุผลที่ยกเลิก</Label>
                  <Textarea id="cancel-reason" autoFocus value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="ระบุเหตุผลอย่างน้อย 3 ตัวอักษร" />
                </div>
                <DialogFooter>
                  <Button variant="destructive" disabled={cancelReason.trim().length < 3 || act.isPending} onClick={submitCancel}>
                    ยืนยันยกเลิก
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
          {actions.includes('close') && <Button onClick={() => act.mutate({ path: 'close', body: v })}>ปิดงาน</Button>}
          {actions.includes('pdf') && (
            <Button variant="secondary" onClick={() => openAuthedFile(`/api/v1/shipments/${id}/summary.pdf`).catch((e) => toast.error(describeError(e, 'เปิดไฟล์ไม่สำเร็จ')))}>
              เปิด PDF หลักฐาน
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">ข้อมูลเที่ยว</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>
              เวลา: {fmtBkk(s.plannedStart)} – {fmtBkk(s.plannedEnd)}
            </p>
            <p>รถ: {[s.head?.vehicleId, s.tail?.vehicleId].filter(Boolean).map((x) => plates.get(x!)).join(' + ') || '-'}</p>
            <p>คนขับ: {s.head?.driverId ? drivers.get(s.head.driverId) : '-'}</p>
            {s.driverResponse && (
              <p>
                คนขับ{s.driverResponse.status === 'ACCEPTED' ? 'รับงาน' : `ปฏิเสธ: ${s.driverResponse.reason}`} ({fmtBkk(s.driverResponse.at)})
              </p>
            )}
            <IssueList warnings={s.warnings} />
          </CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">จุดจอด</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-2 text-sm">
              {s.stops.map((st) => (
                <li key={st.stopId} className="flex items-center justify-between rounded border bg-white px-3 py-2">
                  <span>
                    {st.seq}. {locations.get(st.locationId)}
                    <span className="ml-2 text-xs text-neutral-500">
                      {st.pickupDoIds.length > 0 && `รับ ${st.pickupDoIds.map((d) => doNo.get(d)).join(', ')} `}
                      {st.dropDoIds.length > 0 && `ส่ง ${st.dropDoIds.map((d) => doNo.get(d)).join(', ')}`}
                    </span>
                  </span>
                  <span className="text-xs">{st.status}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">ใบสั่งส่ง</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {(s.deliveryOrders ?? []).map((d) => (
              <div key={d.id} className="flex items-center justify-between">
                <span className="font-mono text-xs">{d.doNo}</span>
                <StatusBadge status={d.status} />
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">ไทม์ไลน์คนขับ</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {(events.data ?? []).map((e) => (
                <li key={e.id} className="flex justify-between">
                  <span>
                    {e.code}
                    {e.reasonCode ? ` (${e.reasonCode})` : ''}
                    {e.flags.length > 0 && <span className="ml-2 text-xs text-amber-700">{e.flags.join(', ')}</span>}
                  </span>
                  <span className="text-xs text-neutral-500">{fmtBkk(e.deviceTime)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
