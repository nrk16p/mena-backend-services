import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiFetch } from '@shared/api';
import type { DriverShipment, Issue, PodField, PodFile } from '@shared/types';
import SignaturePad from '../components/SignaturePad';
import { getPosition } from '../lib/gps';
import { compressImage } from '../lib/image';
import { keptPalletLines, podFormProblems } from '../lib/podFormProblems';
import { uploadFile } from '../lib/upload';
import { useWakeLock } from '../lib/useWakeLock';

// A reasonable, driver-facing subset of the backend's reason-code enum (spec: SHORTAGE, OVERAGE,
// DAMAGED, REFUSED_FULL, REFUSED_PARTIAL, CONSIGNEE_CLOSED, NO_RECEIVER, WRONG_ADDRESS,
// DOCS_MISSING, TEMP_OUT_OF_RANGE, TRAFFIC, BREAKDOWN, WEATHER, CHECKPOINT, OTHER) — the
// TRAFFIC/BREAKDOWN/WEATHER/CHECKPOINT/OVERAGE codes describe trip-level events, not a failed
// delivery, so they are left off this list even though the server would accept them.
const FAIL_REASONS = [
  'CONSIGNEE_CLOSED',
  'NO_RECEIVER',
  'REFUSED_FULL',
  'REFUSED_PARTIAL',
  'DAMAGED',
  'SHORTAGE',
  'WRONG_ADDRESS',
  'DOCS_MISSING',
  'TEMP_OUT_OF_RANGE',
  'OTHER',
];

/** A photo thumbnail with its own object URL, revoked when the thumbnail is removed or the page unmounts. */
function Thumb({ blob, onRemove }: { blob: Blob; onRemove: () => void }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <button type="button" onClick={onRemove}>
      <img src={url} alt="" className="h-20 w-20 rounded object-cover" />
    </button>
  );
}

export default function PodPage() {
  const { id, doId } = useParams();
  const [params] = useSearchParams();
  const failed = params.get('failed') === '1';
  const nav = useNavigate();
  // Created once when the page opens and reused on every retry within this visit, so a resubmit
  // after a failed attempt replays the same clientPodId instead of creating a second POD.
  const clientPodId = useMemo(() => crypto.randomUUID(), []);
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: async () => (await apiFetch<{ items: DriverShipment[] }>('GET', '/api/v1/driver/shipments')).items });
  const job = jobs.data?.find((j) => j.id === id);
  const d = job?.deliveryOrders.find((x) => x.id === doId);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [blobs, setBlobs] = useState<Record<string, Blob[]>>({});
  const [reason, setReason] = useState('CONSIGNEE_CLOSED');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  // Two quick taps can both fire before setBusy(true) is reflected in a re-render, so the
  // authoritative "already submitting" check is this synchronous ref, read at the very top of
  // submit() before any state update or await.
  const inFlightRef = useRef(false);
  // Blobs that already uploaded successfully, so a retry after a failed attempt (e.g. the
  // apiFetch POST failing after uploads succeeded) doesn't re-upload the same photos/signature.
  const uploadedRef = useRef(new Map<Blob, PodFile>());
  useWakeLock(true);
  if (!job || !d) return <p className="p-4">กำลังโหลด…</p>;
  const fields = failed ? d.podForm.fields.filter((f) => f.type === 'photo') : d.podForm.fields;
  const set = (k: string, v: unknown) => setAnswers((a) => ({ ...a, [k]: v }));

  const addPhotos = async (f: PodField, files: FileList | null) => {
    if (!files) return;
    const out: Blob[] = [];
    for (const file of Array.from(files)) out.push(await compressImage(file));
    setBlobs((b) => ({ ...b, [f.key]: [...(b[f.key] ?? []), ...out].slice(0, f.max ?? 10) }));
  };

  const removePhoto = (key: string, i: number) => setBlobs((x) => ({ ...x, [key]: (x[key] ?? []).filter((_, j) => j !== i) }));

  const submit = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setIssues([]);
    try {
      // Drop palletLines rows the driver never really filled in before validating/sending.
      const cleanedAnswers: Record<string, unknown> = { ...answers };
      for (const f of fields) {
        if (f.type === 'palletLines') {
          cleanedAnswers[f.key] = keptPalletLines((answers[f.key] as { type: string; qty: number }[] | undefined) ?? []);
        }
      }

      const blobCounts = Object.fromEntries(Object.entries(blobs).map(([k, v]) => [k, v.length]));
      const problems = podFormProblems(fields, { ...cleanedAnswers, reason, note }, blobCounts, failed);
      if (problems.length > 0) {
        setIssues(problems.map((message) => ({ code: 'POD_LOCAL_INVALID', message })));
        return;
      }

      const files: PodFile[] = [];
      for (const [fieldKey, list] of Object.entries(blobs)) {
        for (const blob of list) {
          let file = uploadedRef.current.get(blob);
          if (!file) {
            file = await uploadFile(job.id, d.id, fieldKey, blob);
            uploadedRef.current.set(blob, file);
          }
          files.push(file);
        }
      }
      const pos = await getPosition();
      await apiFetch('POST', '/api/v1/driver/pods', {
        clientPodId,
        doId: d.id,
        outcome: failed ? 'FAILED' : 'DELIVERED',
        reasonCode: failed ? reason : null,
        note: note || null,
        answers: failed ? {} : cleanedAnswers,
        files,
        ...pos,
        deviceTime: new Date().toISOString(),
        device: navigator.userAgent.slice(0, 100),
        appVersion: '0.1.0',
        offline: !navigator.onLine,
      });
      toast.success('ส่ง POD แล้ว');
      nav(`/jobs/${job.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'POD_INVALID') setIssues((e.details as { issues: Issue[] }).issues ?? []);
      toast.error(e instanceof Error ? e.message : 'ส่งไม่สำเร็จ');
    } finally {
      setBusy(false);
      inFlightRef.current = false;
    }
  };

  const renderField = (f: PodField) => {
    switch (f.type) {
      case 'photo':
        return (
          <div className="space-y-2">
            <Input type="file" accept="image/*" capture="environment" multiple onChange={(e) => void addPhotos(f, e.target.files)} />
            <div className="flex flex-wrap gap-2">
              {(blobs[f.key] ?? []).map((b, i) => (
                <Thumb key={i} blob={b} onRemove={() => removePhoto(f.key, i)} />
              ))}
            </div>
          </div>
        );
      case 'signature':
        return <SignaturePad onChange={(b) => setBlobs((x) => ({ ...x, [f.key]: b ? [b] : [] }))} />;
      case 'text':
        return <Input value={(answers[f.key] as string) ?? ''} onChange={(e) => set(f.key, e.target.value)} />;
      case 'number':
        return (
          <Input
            type="number"
            inputMode="decimal"
            value={(answers[f.key] as number | undefined) ?? ''}
            onChange={(e) => set(f.key, e.target.value === '' ? undefined : Number(e.target.value))}
          />
        );
      case 'select':
        return (
          <Select value={(answers[f.key] as string) ?? ''} onValueChange={(v) => set(f.key, v)}>
            <SelectTrigger>
              <SelectValue placeholder="เลือก" />
            </SelectTrigger>
            <SelectContent>
              {(f.options ?? []).map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      case 'checkbox':
        return <Checkbox checked={answers[f.key] === true} onCheckedChange={(v) => set(f.key, v === true)} />;
      case 'qtyLines': {
        const line = ((answers[f.key] as { planned: number; delivered: number; unit: string }[] | undefined) ?? [{ planned: d.qty, delivered: d.qty, unit: d.unit }])[0]!;
        return (
          <div className="flex items-center gap-2 text-sm">
            <span>
              ตามแผน {line.planned} {line.unit} · ส่งจริง
            </span>
            <Input type="number" className="w-28" value={line.delivered} onChange={(e) => set(f.key, [{ ...line, delivered: Number(e.target.value) }])} />
          </div>
        );
      }
      case 'palletLines': {
        const rows = (answers[f.key] as { type: string; qty: number }[] | undefined) ?? [];
        return (
          <div className="space-y-1">
            {rows.map((r, i) => (
              <div key={i} className="flex gap-2">
                <Input placeholder="ประเภท" value={r.type} onChange={(e) => set(f.key, rows.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))} />
                <Input type="number" className="w-24" value={r.qty} onChange={(e) => set(f.key, rows.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))} />
              </div>
            ))}
            <Button type="button" variant="ghost" size="sm" onClick={() => set(f.key, [...rows, { type: '', qty: 0 }])}>
              + เพิ่มแถว
            </Button>
          </div>
        );
      }
    }
  };

  return (
    <div className="space-y-4 p-4">
      <button onClick={() => nav(`/jobs/${job.id}`)} className="text-blue-700">
        ← กลับ
      </button>
      <h1 className="text-lg font-semibold">
        {failed ? 'ส่งไม่สำเร็จ' : 'หลักฐานการส่ง (POD)'} · <span className="font-mono">{d.doNo}</span>
      </h1>
      {failed && (
        <div className="space-y-2">
          <Label>เหตุผล</Label>
          <Select value={reason} onValueChange={setReason}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FAIL_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea placeholder="รายละเอียด (จำเป็นถ้าเลือก OTHER)" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      )}
      {fields.map((f) => (
        <div key={f.key} className="space-y-1">
          <Label>
            {f.label}
            {!failed && f.required && <span className="text-red-600"> *</span>}
            {f.unit && <span className="text-neutral-500"> ({f.unit})</span>}
          </Label>
          {renderField(f)}
        </div>
      ))}
      {issues.length > 0 && (
        <ul className="rounded bg-red-50 p-2 text-sm text-red-800">
          {issues.map((i, k) => (
            <li key={k}>{i.message}</li>
          ))}
        </ul>
      )}
      <Button className="h-14 w-full text-lg" disabled={busy} onClick={() => void submit()}>
        {busy ? 'กำลังส่ง…' : 'ส่ง POD'}
      </Button>
    </div>
  );
}
