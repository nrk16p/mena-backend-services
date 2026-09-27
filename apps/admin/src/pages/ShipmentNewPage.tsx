import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiFetch } from '@shared/api';
import { describeError } from '@shared/errors';
import { fromBkkInput } from '@shared/time';
import type { DeliveryOrder, Driver, Issue, Shipment, Vehicle } from '@shared/types';
import IssueList from '../components/IssueList';
import { useMaster, useNameMap } from '../lib/master';
import { useLatestValidation } from '../lib/useLatest';

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });

/** Completeness codes the builder can still save as a draft over — not yet enough to dispatch, but not a hard error. */
const COMPLETENESS_CODES = ['HEAD_REQUIRED', 'HEAD_DRIVER_REQUIRED', 'TAIL_REQUIRED', 'TAIL_DRIVER_REQUIRED', 'DOS_REQUIRED', 'STOPS_REQUIRED'] as const;

/**
 * Splits validation errors into blocking errors (shown red, block the draft save) and
 * "not yet complete for planning" issues (shown amber; a draft can still be saved with these
 * present). Pure, so it's unit-testable without mounting the page.
 */
export function splitCompletenessIssues(errors: Issue[]): { blocking: Issue[]; completeness: Issue[] } {
  const codes: readonly string[] = COMPLETENESS_CODES;
  return {
    blocking: errors.filter((e) => !codes.includes(e.code)),
    completeness: errors.filter((e) => codes.includes(e.code)),
  };
}

export default function ShipmentNewPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const doIds = (params.get('doIds') ?? '').split(',').filter(Boolean);
  const vehicles = useMaster<Vehicle>('/vehicles').data ?? [];
  const drivers = useMaster<Driver>('/drivers').data ?? [];
  const locations = useNameMap('/locations');
  const dos = useQuery({
    queryKey: ['dos-by-id', doIds],
    queryFn: () => Promise.all(doIds.map((id) => apiFetch<DeliveryOrder>('GET', `/api/v1/delivery-orders/${id}`))),
    enabled: doIds.length > 0,
  });
  const [start, setStart] = useState(`${today}T08:00`);
  const [end, setEnd] = useState(`${today}T17:00`);
  const [headId, setHeadId] = useState('');
  const [tailId, setTailId] = useState('');
  const [driverId, setDriverId] = useState('');
  const [tailDriverId, setTailDriverId] = useState('');
  const head = vehicles.find((v) => v.id === headId);
  const body = useMemo(() => {
    if (!start || !end) return null;
    return {
      plannedStart: fromBkkInput(start),
      plannedEnd: fromBkkInput(end),
      head: headId ? { vehicleId: headId, driverId: driverId || null } : null,
      tail: head?.part === 'head' && tailId ? { vehicleId: tailId, driverId: (tailDriverId || driverId) || null } : null,
      doIds,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, headId, tailId, driverId, tailDriverId, head?.part, doIds.join(',')]);
  const { result, pending } = useLatestValidation(body);
  const save = useMutation({
    mutationFn: () => apiFetch<Shipment>('POST', '/api/v1/shipments', body),
    onSuccess: (sh) => {
      toast.success(`สร้าง ${sh.shipmentNo} แล้ว`);
      nav(`/shipments/${sh.id}`);
    },
    onError: (e) => toast.error(describeError(e, 'บันทึกไม่สำเร็จ')),
  });
  const { blocking: draftErrors, completeness } = splitCompletenessIssues(result?.errors ?? []);
  const VehicleSelect = ({ value, onChange, parts }: { value: string; onChange: (v: string) => void; parts: string[] }) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder="เลือกรถ" />
      </SelectTrigger>
      <SelectContent>
        {vehicles
          .filter((v) => parts.includes(v.part))
          .map((v) => (
            <SelectItem key={v.id} value={v.id}>
              {v.plate} ({v.part})
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>สร้างเที่ยวขนส่ง</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>เริ่ม (เวลาไทย)</Label>
              <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>สิ้นสุด (เวลาไทย)</Label>
              <Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>หัวลาก / รถบรรทุก</Label>
            <VehicleSelect value={headId} onChange={setHeadId} parts={['head', 'rigid']} />
          </div>
          {head?.part === 'head' && (
            <div className="space-y-1">
              <Label>หาง</Label>
              <VehicleSelect value={tailId} onChange={setTailId} parts={['tail']} />
            </div>
          )}
          <div className="space-y-1">
            <Label>พนักงานขับรถ</Label>
            <Select value={driverId} onValueChange={setDriverId}>
              <SelectTrigger>
                <SelectValue placeholder="เลือกคนขับ" />
              </SelectTrigger>
              <SelectContent>
                {drivers.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.code} {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {head?.part === 'head' && (
            <div className="space-y-1">
              <Label>พนักงานขับรถ (หาง)</Label>
              <Select value={tailDriverId} onValueChange={setTailDriverId}>
                <SelectTrigger>
                  <SelectValue placeholder="ค่าเริ่มต้น: คนขับหัวลาก" />
                </SelectTrigger>
                <SelectContent>
                  {drivers.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.code} {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <p className="mb-1 text-sm font-medium">DO ในเที่ยวนี้</p>
            <ul className="space-y-1 text-sm">
              {(dos.data ?? []).map((d) => (
                <li key={d.id} className="font-mono text-xs">
                  {d.doNo} · {locations.get(d.originLocationId)} → {locations.get(d.destLocationId)}
                </li>
              ))}
            </ul>
          </div>
          <Button className="w-full" disabled={pending || !result || draftErrors.length > 0 || save.isPending} onClick={() => save.mutate()}>
            {pending ? 'กำลังตรวจกฎ…' : 'บันทึกเป็นร่าง'}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>ตรวจกฎการวางแผน</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <IssueList errors={draftErrors} warnings={result?.warnings} />
          {completeness.length > 0 && (
            <div>
              <p className="mb-1 text-sm font-medium text-amber-800">ยังไม่ครบสำหรับวางแผน (บันทึกร่างได้)</p>
              <ul className="space-y-1 text-sm">
                {completeness.map((e, i) => (
                  <li key={i} className="rounded bg-amber-50 px-2 py-1 text-amber-800">
                    <span className="font-mono text-xs">{e.code}</span> {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <p className="mb-1 text-sm font-medium">จุดจอด (สร้างอัตโนมัติ)</p>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {(result?.stops ?? []).map((s, i) => (
                <li key={i}>
                  {locations.get(s.locationId)} — รับ {s.pickupDoIds.length} / ส่ง {s.dropDoIds.length}
                </li>
              ))}
            </ol>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
