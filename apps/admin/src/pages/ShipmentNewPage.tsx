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
import type { DeliveryOrder, Driver, Shipment, Vehicle } from '@shared/types';
import IssueList from '../components/IssueList';
import { useMaster, useNameMap } from '../lib/master';
import { useLatestValidation } from '../lib/useLatest';

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });

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
  const head = vehicles.find((v) => v.id === headId);
  const body = useMemo(() => {
    if (!start || !end) return null;
    return {
      plannedStart: fromBkkInput(start),
      plannedEnd: fromBkkInput(end),
      head: headId ? { vehicleId: headId, driverId: driverId || null } : null,
      tail: head?.part === 'head' && tailId ? { vehicleId: tailId, driverId: driverId || null } : null,
      doIds,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, headId, tailId, driverId, head?.part, doIds.join(',')]);
  const { result, pending } = useLatestValidation(body);
  const save = useMutation({
    mutationFn: () => apiFetch<Shipment>('POST', '/api/v1/shipments', body),
    onSuccess: (sh) => {
      toast.success(`สร้าง ${sh.shipmentNo} แล้ว`);
      nav(`/shipments/${sh.id}`);
    },
    onError: (e) => toast.error(describeError(e, 'บันทึกไม่สำเร็จ')),
  });
  const draftErrors = (result?.errors ?? []).filter(
    (e) => !['TAIL_REQUIRED', 'HEAD_REQUIRED', 'HEAD_DRIVER_REQUIRED', 'TAIL_DRIVER_REQUIRED', 'STOPS_REQUIRED', 'DOS_REQUIRED'].includes(e.code),
  );
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
          <IssueList errors={result?.errors} warnings={result?.warnings} />
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
