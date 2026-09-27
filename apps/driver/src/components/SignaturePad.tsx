import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { compressImage } from '../lib/image';

export default function SignaturePad({ onChange }: { onChange: (blob: Blob | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  useEffect(() => {
    const c = ref.current!;
    c.width = c.clientWidth * 2;
    c.height = c.clientHeight * 2;
    const ctx = c.getContext('2d')!;
    ctx.scale(2, 2);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
  }, []);
  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const finish = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (!dirty.current) return;
    // Simplification per the POD form brief: compress the signature to JPEG right when it is
    // captured, so every stored blob (photos and signature alike) is already a JPEG and `submit`
    // never needs a signature-specific branch before upload.
    ref.current!.toBlob((png) => {
      if (!png) return;
      void compressImage(png).then(onChange);
    }, 'image/png');
  };
  const clear = () => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    dirty.current = false;
    onChange(null);
  };
  return (
    <div className="space-y-1">
      <canvas
        ref={ref}
        className="h-40 w-full touch-none rounded border bg-white"
        onPointerDown={(e) => {
          drawing.current = true;
          const { x, y } = point(e);
          const ctx = e.currentTarget.getContext('2d')!;
          ctx.beginPath();
          ctx.moveTo(x, y);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const { x, y } = point(e);
          const ctx = e.currentTarget.getContext('2d')!;
          ctx.lineTo(x, y);
          ctx.stroke();
          dirty.current = true;
        }}
        onPointerUp={finish}
        onPointerLeave={finish}
      />
      <Button type="button" variant="ghost" size="sm" onClick={clear}>
        ล้างลายเซ็น
      </Button>
    </div>
  );
}
