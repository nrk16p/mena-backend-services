import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../../src/lib/canonical.js';
import { MemoryStorage, S3Storage, verifyLocalSignature } from '../../src/modules/storage/storage.js';

describe('canonical hashing', () => {
  it('sorts keys recursively so equal objects hash equally', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
    expect(sha256Hex(canonicalJson({ x: 1, y: 2 }))).toBe(sha256Hex(canonicalJson({ y: 2, x: 1 })));
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('MemoryStorage', () => {
  it('stores and returns objects', async () => {
    const s = new MemoryStorage();
    expect(await s.get('k')).toBeNull();
    await s.put('k', Buffer.from('hi'), 'text/plain');
    expect(await s.get('k')).toEqual({ body: Buffer.from('hi'), contentType: 'text/plain' });
    expect(await s.presignPut('k', 'image/png', 300)).toBe('memory://k');
  });

  it('signs local URLs when given a base URL and secret', async () => {
    const s = new MemoryStorage({ baseUrl: 'http://localhost:3000', secret: 'x'.repeat(32) });
    const url = new URL(await s.presignPut('pods/a/b.jpg', 'image/jpeg', 300));
    expect(url.pathname).toBe('/api/v1/uploads/local');
    const key = url.searchParams.get('key')!;
    const exp = url.searchParams.get('exp')!;
    const sig = url.searchParams.get('sig')!;
    expect(verifyLocalSignature('x'.repeat(32), key, exp, sig)).toBe(true);
    expect(verifyLocalSignature('x'.repeat(32), key, exp, `${sig}0`)).toBe(false);
    expect(verifyLocalSignature('x'.repeat(32), key, String(Math.floor(Date.now() / 1000) - 1), sig)).toBe(false);
  });
});

describe('S3Storage', () => {
  it('presigns PUT and GET URLs for the bucket without network access', async () => {
    const s = new S3Storage({ endpoint: 'https://sgp1.digitaloceanspaces.com', region: 'sgp1', bucket: 'mena-pod', key: 'AKIA', secret: 'secret' });
    const put = await s.presignPut('pods/a/b/c.jpg', 'image/jpeg', 300);
    expect(put).toContain('mena-pod');
    expect(put).toContain('pods/a/b/c.jpg');
    expect(put).toContain('X-Amz-Signature=');
    expect(put).not.toMatch(/x-amz-checksum|x-amz-sdk-checksum/i);
    expect(await s.presignGet('pods/a/b/c.jpg', 300)).toContain('X-Amz-Expires=300');
  });
});
