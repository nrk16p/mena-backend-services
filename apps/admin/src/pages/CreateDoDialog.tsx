import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiError, apiFetch } from '@shared/api';
import type { DeliveryOrder, LocationItem, MasterItem } from '@shared/types';
import { useMaster } from '../lib/master';

export interface CreateDoForm {
  clientId: string;
  serviceTypeId: string;
  materialId: string;
  originLocationId: string;
  destLocationId: string;
  qty: string;
  clientRef: string;
}

export const emptyCreateDoForm: CreateDoForm = { clientId: '', serviceTypeId: '', materialId: '', originLocationId: '', destLocationId: '', qty: '1', clientRef: '' };

/**
 * Builds the POST /api/v1/delivery-orders body from the dialog's form state.
 * Pure so it can be unit-tested without mounting the dialog. Deliberately omits `unit` —
 * the backend derives it from the selected material (orders.service.ts) when it's absent.
 */
export function buildCreateDoBody(form: CreateDoForm) {
  return {
    clientId: form.clientId,
    serviceTypeId: form.serviceTypeId,
    materialId: form.materialId,
    originLocationId: form.originLocationId,
    destLocationId: form.destLocationId,
    qty: Number(form.qty),
    clientRef: form.clientRef || null,
  };
}

export function isCreateDoFormReady(form: CreateDoForm): boolean {
  return Boolean(form.clientId && form.serviceTypeId && form.materialId && form.originLocationId && form.destLocationId && Number(form.qty) > 0);
}

function Pick({ label, items, value, onChange }: { label: string; items: { id: string; name: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder="เลือก…" />
        </SelectTrigger>
        <SelectContent>
          {items.map((i) => (
            <SelectItem key={i.id} value={i.id}>
              {i.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export default function CreateDoDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const clients = useMaster<MasterItem>('/clients').data ?? [];
  const services = useMaster<MasterItem>('/service-types').data ?? [];
  const materials = useMaster<MasterItem>('/materials').data ?? [];
  const locations = useMaster<LocationItem>('/locations').data ?? [];
  const [form, setForm] = useState<CreateDoForm>(emptyCreateDoForm);
  const set = (k: keyof CreateDoForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const create = useMutation({
    mutationFn: () => apiFetch<DeliveryOrder>('POST', '/api/v1/delivery-orders', buildCreateDoBody(form)),
    onSuccess: (d) => {
      toast.success(`สร้าง ${d.doNo} แล้ว`);
      for (const w of d.warnings ?? []) toast.warning(w.message);
      void qc.invalidateQueries({ queryKey: ['delivery-orders'] });
      setForm(emptyCreateDoForm);
      setOpen(false);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'สร้าง DO ไม่สำเร็จ'),
  });
  const ready = isCreateDoFormReady(form);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>สร้าง DO</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>สร้างใบสั่งส่ง</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Pick label="ลูกค้า" items={clients} value={form.clientId} onChange={set('clientId')} />
          <Pick label="บริการ" items={services} value={form.serviceTypeId} onChange={set('serviceTypeId')} />
          <Pick label="สินค้า" items={materials} value={form.materialId} onChange={set('materialId')} />
          <Pick label="ต้นทาง" items={locations} value={form.originLocationId} onChange={set('originLocationId')} />
          <Pick label="ปลายทาง" items={locations} value={form.destLocationId} onChange={set('destLocationId')} />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>จำนวน</Label>
              <Input type="number" min={0} value={form.qty} onChange={(e) => set('qty')(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>เลขที่อ้างอิงลูกค้า</Label>
              <Input value={form.clientRef} onChange={(e) => set('clientRef')(e.target.value)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button disabled={!ready || create.isPending} onClick={() => create.mutate()}>
            บันทึก
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
