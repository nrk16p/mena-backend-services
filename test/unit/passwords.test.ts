import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/lib/passwords.js';

describe('passwords', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashPassword('s3cret-pass');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 's3cret-pass')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
  });

  it('verifies legacy argon2 variants (backend-tdm used passlib argon2)', async () => {
    const legacy = await argon2.hash('legacy-pass', { type: argon2.argon2i, memoryCost: 65536, timeCost: 3, parallelism: 4 });
    expect(await verifyPassword(legacy, 'legacy-pass')).toBe(true);
  });

  it('returns false instead of throwing on a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});
