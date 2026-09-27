import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const base = {
  MONGO_URI: 'mongodb://localhost:27017',
  MONGO_DB: 'x',
  JWT_SECRET: 'a'.repeat(32),
  API_KEY_PEPPER: 'p'.repeat(16),
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.PORT).toBe(3000);
    expect(c.ACCESS_TOKEN_TTL_SEC).toBe(3600);
    expect(c.REFRESH_TOKEN_TTL_DAYS).toBe(30);
    expect(c.REFRESH_REUSE_GRACE_SEC).toBe(30);
    expect(c.NODE_ENV).toBe('development');
  });

  it('rejects a missing JWT_SECRET', () => {
    const { JWT_SECRET: _omit, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/JWT_SECRET/);
  });

  it('rejects a short JWT_SECRET', () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
  });

  it('coerces numeric env values', () => {
    expect(loadConfig({ ...base, PORT: '8080' }).PORT).toBe(8080);
  });

  it('TRUST_PROXY defaults to "false" and accepts "true" or a positive hop-count string', () => {
    expect(loadConfig(base).TRUST_PROXY).toBe('false');
    expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe('true');
    expect(loadConfig({ ...base, TRUST_PROXY: '2' }).TRUST_PROXY).toBe('2');
  });

  it('rejects an invalid TRUST_PROXY value', () => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ ...base, TRUST_PROXY: '0' })).toThrow(/TRUST_PROXY/);
  });
});
