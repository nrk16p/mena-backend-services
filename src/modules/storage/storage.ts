import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
  /** The stored size without downloading the object; null when it does not exist. */
  head(key: string): Promise<{ bytes: number } | null>;
  /** The object's bytes as a stream (the caller reads it to the end or destroys it); null when it does not exist. */
  getStream(key: string): Promise<Readable | null>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
}

/**
 * SHA-256 of a stream, reading at most `maxBytes`: once more than that has flowed it stops, destroys
 * the stream (so the rest is never downloaded) and returns null. The stream is always released.
 */
export async function sha256OfStream(stream: Readable, maxBytes: number): Promise<{ sha256: string; bytes: number } | null> {
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buf: Buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
      bytes += buf.length;
      if (bytes > maxBytes) return null;
      hash.update(buf);
    }
  } finally {
    if (!stream.destroyed) stream.destroy();
  }
  return { sha256: hash.digest('hex'), bytes };
}

const MEMORY_CHUNK = 64 * 1024;

/**
 * The local upload link's HMAC key is a subkey derived from JWT_SECRET (never the secret itself
 * used directly as a MAC key), so a leaked link-signing key can't be replayed against anything
 * that uses JWT_SECRET directly (e.g. access tokens).
 */
export function deriveLocalUploadKey(jwtSecret: string): Buffer {
  return createHmac('sha256', jwtSecret).update('local-upload').digest();
}

/** The signature covers the method and (for PUT) the content type, so a link can't be replayed
 * for a different HTTP method or with a different content type than it was issued for. */
export function signLocal(secret: string, method: string, key: string, exp: string, contentType?: string): string {
  return createHmac('sha256', deriveLocalUploadKey(secret)).update(`${method}\n${key}\n${exp}\n${contentType ?? ''}`).digest('hex');
}

export function verifyLocalSignature(secret: string, method: string, key: string, exp: string, sig: string, contentType?: string): boolean {
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < Date.now()) return false;
  const expected = signLocal(secret, method, key, exp, contentType);
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
  private readonly local?: { baseUrl: string; secret: string };

  constructor(local?: { baseUrl: string; secret: string }) {
    // Strip a trailing slash so `${baseUrl}/api/v1/...` never doubles up on `//`.
    this.local = local ? { baseUrl: local.baseUrl.replace(/\/+$/, ''), secret: local.secret } : undefined;
  }

  private link(method: 'PUT' | 'GET', key: string, expiresSec: number, contentType?: string): string {
    if (!this.local) return `memory://${key}`;
    const exp = String(Math.floor(Date.now() / 1000) + expiresSec);
    const sig = signLocal(this.local.secret, method, key, exp, contentType);
    const q = new URLSearchParams({ key, exp, sig });
    return `${this.local.baseUrl}/api/v1/uploads/local?${q.toString()}`;
  }
  async presignPut(key: string, contentType: string, expiresSec = 300): Promise<string> {
    return this.link('PUT', key, expiresSec, contentType);
  }
  async presignGet(key: string, expiresSec = 300): Promise<string> {
    return this.link('GET', key, expiresSec);
  }
  async get(key: string): Promise<StoredObject | null> {
    return this.objects.get(key) ?? null;
  }
  async head(key: string): Promise<{ bytes: number } | null> {
    const obj = this.objects.get(key);
    return obj ? { bytes: obj.body.length } : null;
  }
  async getStream(key: string): Promise<Readable | null> {
    const obj = this.objects.get(key);
    if (!obj) return null;
    // Served in chunks like a network body, so a byte cap can stop part-way.
    const { body } = obj;
    return Readable.from(
      (function* () {
        for (let i = 0; i < body.length; i += MEMORY_CHUNK) yield body.subarray(i, i + MEMORY_CHUNK);
      })(),
    );
  }
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }
}

const isNotFound = (e: unknown) => {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err.name === 'NoSuchKey' || err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404;
};

export interface S3StorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  key: string;
  secret: string;
  /** Limit for a call to get its response, and for any silence on the socket while a body streams (default 10 s). */
  requestTimeoutMs?: number;
  /** TCP connect limit (default 3 s). */
  connectionTimeoutMs?: number;
  /** SDK attempts per call including retries (SDK default 3). */
  maxAttempts?: number;
  /** Path-style URLs (`endpoint/bucket/key`); only needed for S3 stand-ins in tests. */
  forcePathStyle?: boolean;
}

export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(o: S3StorageOptions) {
    this.bucket = o.bucket;
    this.client = new S3Client({
      endpoint: o.endpoint,
      region: o.region,
      credentials: { accessKeyId: o.key, secretAccessKey: o.secret },
      // The SDK builds its NodeHttpHandler from these options. requestTimeout only runs until the response
      // headers arrive (and without throwOnRequestTimeout it merely logs a warning); socketTimeout is an
      // inactivity limit that also covers a body that stalls part-way through a download.
      requestHandler: {
        connectionTimeout: o.connectionTimeoutMs ?? 3_000,
        requestTimeout: o.requestTimeoutMs ?? 10_000,
        throwOnRequestTimeout: true,
        socketTimeout: o.requestTimeoutMs ?? 10_000,
      },
      ...(o.maxAttempts !== undefined ? { maxAttempts: o.maxAttempts } : {}),
      ...(o.forcePathStyle ? { forcePathStyle: true } : {}),
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
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async head(key: string): Promise<{ bytes: number } | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { bytes: res.ContentLength ?? 0 };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async getStream(key: string): Promise<Readable | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) return null;
      // On Node the body is the response stream itself; other runtimes hand back a web stream.
      if (res.Body instanceof Readable) return res.Body;
      return Readable.fromWeb(res.Body.transformToWebStream() as unknown as WebReadableStream);
    } catch (e) {
      if (isNotFound(e)) return null;
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
