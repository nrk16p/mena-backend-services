import { fileURLToPath } from 'node:url';
import pdfmake from 'pdfmake';
import type { Content, TDocumentDefinitions, TFontDictionary } from 'pdfmake/interfaces.js';

/**
 * @types/pdfmake only models the browser `createPdf` bundle (its `index.d.ts` has no default
 * export). pdfmake's actual Node.js entry point (the `main` field in its own package.json) instead
 * exports this `PdfPrinter` class — the one this module actually uses — so the constructor and the
 * one method called on it are typed here rather than trusting the mismatched upstream typings.
 */
interface PdfKitDocument {
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  end(): void;
}
interface PdfPrinterInstance {
  createPdfKitDocument(docDefinition: TDocumentDefinitions, options?: Record<string, unknown>): PdfKitDocument;
}
const PdfPrinter = pdfmake as unknown as new (fonts: TFontDictionary) => PdfPrinterInstance;

const font = (name: string) => fileURLToPath(new URL(`../../../assets/fonts/${name}`, import.meta.url));
const printer = new PdfPrinter({
  Sarabun: { normal: font('Sarabun-Regular.ttf'), bold: font('Sarabun-Bold.ttf'), italics: font('Sarabun-Regular.ttf'), bolditalics: font('Sarabun-Bold.ttf') },
});

export interface SummaryPdfData {
  shipmentNo: string;
  plannedStart: Date;
  closedAt: Date;
  closedBy: string;
  vehicles: string[];
  drivers: string[];
  stops: { seq: number; location: string; events: { code: string; at: Date }[] }[];
  /** One row per shipment leg (spec §5.1 evidence.distances.legs), in stop order. */
  distances: { fromStop: string; toStop: string; loaded: boolean; mapKm: number | null; gpsKm: number | null }[];
  dos: {
    doNo: string; client: string; material: string; qty: number; unit: string; outcome: string; reasonCode: string | null;
    answers: { label: string; value: string }[]; hash: string; images: Buffer[];
    /** Client-reported km for this DO, when the client supplied one; null prints nothing (not "ไม่มีข้อมูล"). */
    clientKm: number | null;
  }[];
  flags: string[];
}

const SIGNATURES: { magic: number[]; mime: 'image/jpeg' | 'image/png' }[] = [
  { magic: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: 'image/png' },
];

/**
 * A data URL pdfmake can embed, or null when the stored bytes are not a decodable JPEG/PNG (WebP,
 * text, truncated or corrupt files). The type comes from the magic bytes, never the declared mime.
 */
export function embeddableImage(buf: Buffer): string | null {
  const sig = SIGNATURES.find((s) => buf.length > s.magic.length && s.magic.every((b, i) => buf[i] === b));
  if (!sig) return null;
  const url = `data:${sig.mime};base64,${buf.toString('base64')}`;
  try {
    // pdfmake decodes images synchronously while laying out; a one-image probe catches corrupt files.
    printer.createPdfKitDocument({ content: [{ image: url, width: 1 }], defaultStyle: { font: 'Sarabun' } }).end();
    return url;
  } catch {
    return null;
  }
}

const bkk = (d: Date) => d.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });

/** `82.4 กม.`, or `ไม่มีข้อมูล` when the distance was never captured (no GPS fix, map lookup failed, …). */
const km = (v: number | null): string => (v === null ? 'ไม่มีข้อมูล' : `${v.toFixed(1)} กม.`);

/**
 * Builds the pdfmake `content` tree straight from the data, with no PDF rendering. Exported so
 * tests can assert on the exact rows (e.g. a null leg prints "ไม่มีข้อมูล") without parsing a
 * rendered PDF's bytes; `buildSummaryPdf` below is the only thing that actually rasterizes it.
 */
export function buildSummaryContent(data: SummaryPdfData): Content[] {
  const content: Content[] = [
    { text: `ใบสรุปเที่ยว ${data.shipmentNo}`, style: 'h1' },
    { text: `วันที่วางแผน ${bkk(data.plannedStart)} · ปิดงาน ${bkk(data.closedAt)} โดย ${data.closedBy}` },
    { text: `รถ: ${data.vehicles.join(' + ')}   คนขับ: ${data.drivers.join(', ')}`, margin: [0, 4, 0, 10] },
    { text: 'ลำดับจุดจอด', style: 'h2' },
    {
      table: {
        widths: [24, '*', '*'],
        body: [
          ['#', 'สถานที่', 'ขั้นตอน'],
          ...data.stops.map((s) => [String(s.seq), s.location, s.events.map((e) => `${e.code} ${bkk(e.at)}`).join('\n')]),
        ],
      },
      margin: [0, 0, 0, 10],
    },
    { text: 'ระยะทาง', style: 'h2' },
    data.distances.length > 0
      ? {
          table: {
            widths: ['*', 'auto', 'auto', 'auto'],
            body: [
              ['จาก → ถึง', 'สถานะ', 'ระยะแผนที่', 'ระยะ GPS'],
              ...data.distances.map((leg) => [
                `${leg.fromStop} → ${leg.toStop}`,
                leg.loaded ? 'มีสินค้า' : 'รถเปล่า',
                km(leg.mapKm),
                km(leg.gpsKm),
              ]),
            ],
          },
          margin: [0, 0, 0, 10],
        }
      : { text: 'ไม่มีข้อมูล', margin: [0, 0, 0, 10] },
    { text: 'หลักฐานการส่งสินค้า (POD)', style: 'h2' },
  ];
  for (const d of data.dos) {
    const images = d.images.map(embeddableImage).filter((u): u is string => u !== null);
    const skipped = d.images.length - images.length;
    const stack: Content[] = [
      { text: `${d.doNo} · ${d.client} · ${d.material} ${d.qty} ${d.unit}`, bold: true },
      { text: d.outcome === 'DELIVERED' ? 'ส่งสำเร็จ' : `ส่งไม่สำเร็จ · เหตุผล ${d.reasonCode ?? '-'}` },
      ...(d.clientKm !== null ? [{ text: `ระยะทางที่ลูกค้าระบุ: ${km(d.clientKm)}` } satisfies Content] : []),
      ...d.answers.map((a): Content => ({ text: `${a.label}: ${a.value}` })),
      { text: `ลายนิ้วมือ POD: ${d.hash}`, fontSize: 7, color: '#555555' },
    ];
    if (images.length > 0) stack.push({ columns: images.map((image) => ({ image, fit: [150, 110] as [number, number] })), columnGap: 8 });
    if (skipped > 0) stack.push({ text: `แสดงรูปไม่ได้ ${skipped} รูป (ไม่ใช่ JPEG/PNG หรือไฟล์เสีย)`, fontSize: 8, color: '#b45309' });
    content.push({ stack, margin: [0, 0, 0, 10] });
  }
  if (data.flags.length > 0) content.push({ text: `ข้อสังเกต: ${data.flags.join(', ')}`, color: '#b45309' });
  return content;
}

export function buildSummaryPdf(data: SummaryPdfData): Promise<Buffer> {
  const doc: TDocumentDefinitions = {
    content: buildSummaryContent(data),
    defaultStyle: { font: 'Sarabun', fontSize: 10 },
    styles: { h1: { fontSize: 16, bold: true, margin: [0, 0, 0, 4] }, h2: { fontSize: 12, bold: true, margin: [0, 6, 0, 4] } },
    pageMargins: [36, 36, 36, 36],
  };
  return new Promise((resolve, reject) => {
    const pdf = printer.createPdfKitDocument(doc);
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.end();
  });
}
