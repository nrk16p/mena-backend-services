import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiFetch } from '@shared/api';
import { fmtBkk } from '@shared/time';
import type { Page, Shipment } from '@shared/types';
import StatusBadge from '../components/StatusBadge';
import { useNameMap } from '../lib/master';

const STATUSES = ['ALL', 'DRAFT', 'PLANNED', 'DISPATCHED', 'ACCEPTED', 'IN_TRANSIT', 'COMPLETED', 'CLOSED', 'CANCELLED'];

export default function ShipmentsPage() {
  const [status, setStatus] = useState('ALL');
  const plates = useNameMap('/vehicles', 'plate');
  const drivers = useNameMap('/drivers');
  const q = useQuery({
    queryKey: ['shipments', status],
    queryFn: () => apiFetch<Page<Shipment>>('GET', `/api/v1/shipments?limit=200${status === 'ALL' ? '' : `&status=${status}`}`),
    refetchInterval: 15_000,
  });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">งานขนส่ง</h1>
        <Select value={status} onValueChange={setStatus}>
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
      </div>
      <Table className="bg-white">
        <TableHeader>
          <TableRow>
            <TableHead>เลขที่</TableHead>
            <TableHead>เวลา</TableHead>
            <TableHead>รถ</TableHead>
            <TableHead>คนขับ</TableHead>
            <TableHead>จุดจอด</TableHead>
            <TableHead>สถานะ</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...(q.data?.items ?? [])].reverse().map((s) => (
            <TableRow key={s.id}>
              <TableCell>
                <Link className="font-mono text-xs text-blue-700 hover:underline" to={`/shipments/${s.id}`}>
                  {s.shipmentNo}
                </Link>
              </TableCell>
              <TableCell className="text-xs">
                {fmtBkk(s.plannedStart)} – {fmtBkk(s.plannedEnd)}
              </TableCell>
              <TableCell>{[s.head?.vehicleId, s.tail?.vehicleId].filter(Boolean).map((id) => plates.get(id!)).join(' + ')}</TableCell>
              <TableCell>{s.head?.driverId ? drivers.get(s.head.driverId) : '-'}</TableCell>
              <TableCell>{s.stops.length}</TableCell>
              <TableCell>
                <StatusBadge status={s.status} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {q.isLoading && <p className="text-sm text-neutral-500">กำลังโหลด…</p>}
    </div>
  );
}
