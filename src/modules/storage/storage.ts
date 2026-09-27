import { createHmac, timingSafeEqual } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../../config.js';

export const UPLOAD_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;
export type UploadType = keyof typeof UPLOAD_TYPES;

export interface StoredObject {
  body: Buffer;
  contentType: string;
}

export interface Storage {
  presignPut(key: string, contentType: string, expiresSec: number): Promise<string>;
  presignGet(key: string, expiresSec: number): Promise<string>;
  get(key: string): Promise<StoredObject | null>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
}

export function signLocal(secret: string, key: string, exp: string): string {
  return createHmac('sha256', secret).update(`${key}\n${exp}`).digest('hex');
}

export function verifyLocalSignature(secret: string, key: string, exp: string, sig: string): boolean {
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < Date.now()) return false;
  const expected = signLocal(secret, key, exp);
  // Compare lengths before hex-decoding: Buffer.from(_, 'hex') silently drops a trailing odd
  // nibble, so a forged signature one character longer than the real one would otherwise decode
  // to the same byte length and could pass timingSafeEqual.
  if (sig.length !== expected.length) return false;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export class MemoryStorage implements Storage {
  readonly objects = new Map<string, StoredObject>();
  constructor(private readonly local?: { baseUrl: string; secret: string }) {}

  private link(key: string, expiresSec: number): string {
    if (!this.local) return `memory://${key}`;
    const exp = String(Math.floor(Date.now() / 1000) + expiresSec);
    const q = new URLSearchParams({ key, exp, sig: signLocal(this.local.secret, key, exp) });
    return `${this.local.baseUrl}/api/v1/uploads/local?${q.toString()}`;
  }
  async presignPut(key: string, _contentType?: string, expiresSec = 300): Promise<string> {
    return this.link(key, expiresSec);
  }
  async presignGet(key: string, expiresSec = 300): Promise<string> {
    return this.link(key, expiresSec);
  }
  async get(key: string): Promise<StoredObject | null> {
    return this.objects.get(key) ?? null;
  }
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }
}

export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(o: { endpoint: string; region: string; bucket: string; key: string; secret: string }) {
    this.bucket = o.bucket;
    this.client = new S3Client({
      endpoint: o.endpoint,
      region: o.region,
      credentials: { accessKeyId: o.key, secretAccessKey: o.secret },
      // SDK ≥ 3.729 otherwise signs a CRC32 of the (empty) body into presigned PUT URLs, which the
      // phone's real upload can never match; only add checksums when an operation requires them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  presignPut(key: string, contentType: string, expiresSec: number): Promise<string> {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }), { expiresIn: expiresSec });
  }

  presignGet(key: string, expiresSec: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresSec });
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) return null;
      return { body: Buffer.from(await res.Body.transformToByteArray()), contentType: res.ContentType ?? 'application/octet-stream' };
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw e;
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }
}

export function createStorage(config: Config): Storage {
  if (config.STORAGE_DRIVER === 'memory') return new MemoryStorage({ baseUrl: config.PUBLIC_BASE_URL, secret: config.JWT_SECRET });
  return new S3Storage({
    endpoint: config.SPACES_ENDPOINT!,
    region: config.SPACES_REGION,
    bucket: config.SPACES_BUCKET!,
    key: config.SPACES_KEY!,
    secret: config.SPACES_SECRET!,
  });
}
