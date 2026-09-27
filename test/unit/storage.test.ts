import { createHash, createHmac } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../../src/lib/canonical.js';
import { MemoryStorage, S3Storage, deriveLocalUploadKey, signLocal, verifyLocalSignature } from '../../src/modules/storage/storage.js';

describe('canonical hashing', () => {
  it('sorts keys recursively so equal objects hash equally', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
    expect(sha256Hex(canonicalJson({ x: 1, y: 2 }))).toBe(sha256Hex(canonicalJson({ y: 2, x: 1 })));
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('serializes undefined array items as null', () => {
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]');
    expect(canonicalJson({ a: [undefined] })).toBe('{"a":[null]}');
  });

  it('throws for a top-level undefined value', () => {
    expect(() => canonicalJson(undefined)).toThrow(/undefined/);
  });

  it('throws for non-plain objects instead of silently mis-serializing them', () => {
    expect(() => canonicalJson(new Date())).toThrow(/non-plain/);
    expect(() => canonicalJson(new ObjectId())).toThrow(/non-plain/);
    expect(() => canonicalJson(new Map([['a', 1]]))).toThrow(/non-plain/);
    class Foo {
      x = 1;
    }
    expect(() => canonicalJson(new Foo())).toThrow(/non-plain/);
    expect(() => canonicalJson({ nested: { bad: new Date() } })).toThrow(/non-plain/);
    // Plain objects (including a null-prototype one) and arrays are still fine.
    expect(canonicalJson(Object.create(null))).toBe('{}');
    expect(canonicalJson([{ a: 1 }])).toBe('[{"a":1}]');
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
    expect(verifyLocalSignature('x'.repeat(32), 'PUT', key, exp, sig, 'image/jpeg')).toBe(true);
    expect(verifyLocalSignature('x'.repeat(32), 'PUT', key, exp, `${sig}0`, 'image/jpeg')).toBe(false);
    expect(verifyLocalSignature('x'.repeat(32), 'PUT', key, String(Math.floor(Date.now() / 1000) - 1), sig, 'image/jpeg')).toBe(false);
    // The signature covers the method and content type: a GET link can't be replayed as a PUT,
    // and a PUT link signed for one content type can't be reused with another.
    expect(verifyLocalSignature('x'.repeat(32), 'GET', key, exp, sig)).toBe(false);
    expect(verifyLocalSignature('x'.repeat(32), 'PUT', key, exp, sig, 'image/png')).toBe(false);

    const getUrl = new URL(await s.presignGet('pods/a/b.jpg', 300));
    const getSig = getUrl.searchParams.get('sig')!;
    expect(verifyLocalSignature('x'.repeat(32), 'GET', key, getUrl.searchParams.get('exp')!, getSig)).toBe(true);
    expect(verifyLocalSignature('x'.repeat(32), 'PUT', key, getUrl.searchParams.get('exp')!, getSig, 'image/jpeg')).toBe(false);
  });

  it('strips a trailing slash from the configured base URL', async () => {
    const s = new MemoryStorage({ baseUrl: 'http://localhost:3000/', secret: 'x'.repeat(32) });
    const url = await s.presignPut('k', 'image/jpeg', 300);
    expect(url.startsWith('http://localhost:3000/api/v1/uploads/local?')).toBe(true);
    expect(url).not.toContain('3000//api');
  });

  it('derives the local-link HMAC key from JWT_SECRET rather than using it directly', () => {
    const secret = 'x'.repeat(32);
    const expected = createHmac('sha256', secret).update('local-upload').digest();
    expect(deriveLocalUploadKey(secret)).toEqual(expected);
    const exp = String(Math.floor(Date.now() / 1000) + 300);
    const sig = signLocal(secret, 'GET', 'k', exp);
    expect(sig).toBe(createHmac('sha256', expected).update(`GET\nk\n${exp}\n`).digest('hex'));
    // Sanity: the derivation actually changes the key (not a no-op wrapper around the raw secret).
    expect(createHash('sha256').update(secret).digest('hex')).not.toBe(expected.toString('hex'));
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
