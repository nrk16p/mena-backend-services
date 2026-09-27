import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiFetch } from '@shared/api';
import type { DeliveryOrder, Page } from '@shared/types';
import StatusBadge from '../components/StatusBadge';
import { useNameMap } from '../lib/master';
import CreateDoDialog from './CreateDoDialog';

const STATUSES = ['UNASSIGNED', 'PLANNED', 'PICKED_UP', 'DELIVERED', 'POD_VERIFIED', 'FAILED', 'CANCELLED'];

/** Toggles an id in/out of a selection list. Pure, so it's unit-testable without mounting the page. */
export function toggleSelected(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

export default function DeliveryOrdersPage() {
  const nav = useNavigate();
  const [status, setStatus] = useState('UNASSIGNED');
  const [selected, setSelected] = useState<string[]>([]);
  const clients = useNameMap('/clients');
  const locations = useNameMap('/locations');
  const materials = useNameMap('/materials');
  const q = useQuery({
    queryKey: ['delivery-orders', status],
    queryFn: () => apiFetch<Page<DeliveryOrder>>('GET', `/api/v1/delivery-orders?status=${status}&limit=200`),
  });
  const toggle = (id: string) => setSelected((s) => toggleSelected(s, id));
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">ใบสั่งส่ง (DO)</h1>
        <div className="flex gap-2">
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              setSelected([]);
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <CreateDoDialog />
          <Button variant="secondary" disabled={selected.length === 0} onClick={() => nav(`/shipments/new?doIds=${selected.join(',')}`)}>
            สร้างเที่ยวจาก DO ที่เลือก ({selected.length})
          </Button>
        </div>
      </div>
      <Table className="bg-white">
        <TableHeader>
          <TableRow>
            <TableHead />
            <TableHead>เลขที่</TableHead>
            <TableHead>ลูกค้า</TableHead>
            <TableHead>สินค้า</TableHead>
            <TableHead>ต้นทาง → ปลายทาง</TableHead>
            <TableHead>กลุ่มงาน</TableHead>
            <TableHead>สถานะ</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(q.data?.items ?? []).map((d) => (
            <TableRow key={d.id}>
              <TableCell>{d.status === 'UNASSIGNED' && <Checkbox checked={selected.includes(d.id)} onCheckedChange={() => toggle(d.id)} />}</TableCell>
              <TableCell className="font-mono text-xs">{d.doNo}</TableCell>
              <TableCell>{clients.get(d.clientId)}</TableCell>
              <TableCell>
                {materials.get(d.materialId)} {d.qty} {d.unit}
              </TableCell>
              <TableCell>
                {locations.get(d.originLocationId)} → {locations.get(d.destLocationId)}
              </TableCell>
              <TableCell className="text-xs">{d.jobGroupMatch.status === 'none' ? <span className="text-amber-700">ไม่พบกลุ่มงาน</span> : d.jobGroupMatch.status}</TableCell>
              <TableCell>
                <StatusBadge status={d.status} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {q.isLoading && <p className="text-sm text-neutral-500">กำลังโหลด…</p>}
    </div>
  );
}
