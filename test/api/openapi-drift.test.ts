import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { sortKeysDeep } from '../../scripts/lib/sort-keys.js';
import { buildTestApp, closeTestApp } from '../helpers/app.js';

const COMMITTED_FILE = fileURLToPath(new URL('../../docs/api/openapi.json', import.meta.url));

describe('OpenAPI drift guard', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => closeTestApp(app));

  it('matches the committed docs/api/openapi.json (run `npm run openapi` and commit the result if this fails)', async () => {
    const generated = `${JSON.stringify(sortKeysDeep(app.swagger()), null, 2)}\n`;
    let committed: string;
    try {
      committed = readFileSync(COMMITTED_FILE, 'utf8');
    } catch {
      throw new Error('docs/api/openapi.json is missing — run `npm run openapi` and commit the result');
    }
    expect(generated, 'docs/api/openapi.json is out of date — run `npm run openapi` and commit the result').toBe(committed);
  });
});
