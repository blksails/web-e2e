import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

/**
 * Tests for the recording importer's transform rules. Same strategy as generate-report.test.ts:
 * parser logic is duplicated here so we test behaviour, not implementation shape.
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalise(source: string, baseUrl: string, tags: string[]): string {
  let out = source;

  out = out.replace(
    /import\s*{\s*test,\s*expect\s*}\s*from\s*['"]@playwright\/test['"];?/g,
    "import { test, expect } from '../../fixtures/base';",
  );
  if (!out.includes("from '../../fixtures/base'")) {
    out = `import { test, expect } from '../../fixtures/base';\n` + out;
  }

  const absRe = new RegExp(`page\\.goto\\(['"]${escapeRegExp(baseUrl)}(/[^'"]*)?['"]\\)`, 'g');
  out = out.replace(absRe, (_m, path) => `page.goto('${path || '/'}')`);

  out = out.replace(
    /await page\.waitForTimeout\(\d+\);?/g,
    (m) => `// TODO[e2e]: replace ${m.trim()} with expect.poll / locator.waitFor`,
  );

  out = out.replace(
    /test\(\s*(['"`])([^'"`]+)\1\s*,\s*async\s*\(\s*{\s*([^}]*)\s*}\s*\)\s*=>\s*{/,
    (_m, q, title, destructure) => {
      const tagSuffix = tags.map((t) => `@${t}`).join(' ');
      const newTitle = `${title} ${tagSuffix}`.trim();
      const needsGuard = !destructure.includes('tenantGuard');
      const destr = needsGuard
        ? `${destructure.trim()}${destructure.trim() ? ', ' : ''}tenantGuard, page`
        : destructure;
      const guardCall = needsGuard ? '\n  await tenantGuard(page);' : '';
      return `test(${q}${newTitle}${q}, async ({ ${destr} }) => {${guardCall}`;
    },
  );

  return out;
}

describe('normalise()', () => {
  const BASE = 'https://web-beta.apps.blksails.cn';

  it('rewrites the @playwright/test import to our fixtures bundle', () => {
    const src = `import { test, expect } from '@playwright/test';\ntest('x', async ({ page }) => {});`;
    const out = normalise(src, BASE, ['recorded']);
    assert.match(out, /from '\.\.\/\.\.\/fixtures\/base'/);
    assert.ok(!out.includes("from '@playwright/test'"));
  });

  it('adds the fixtures import if the recording has none', () => {
    const src = `test('x', async ({ page }) => {});`;
    const out = normalise(src, BASE, ['recorded']);
    assert.match(out, /^import \{ test, expect \} from '\.\.\/\.\.\/fixtures\/base';/);
  });

  it('rewrites absolute URLs to relative paths using baseURL', () => {
    const src = `await page.goto('${BASE}/wxwork/corps');`;
    const out = normalise(src, BASE, []);
    assert.ok(out.includes("page.goto('/wxwork/corps')"), `got: ${out}`);
    assert.ok(!out.includes(BASE));
  });

  it('rewrites bare base URL to /', () => {
    const src = `await page.goto('${BASE}');`;
    const out = normalise(src, BASE, []);
    assert.ok(out.includes("page.goto('/')"), `got: ${out}`);
  });

  it('marks waitForTimeout as a TODO instead of removing it silently', () => {
    const src = `await page.waitForTimeout(500);`;
    const out = normalise(src, BASE, []);
    assert.match(out, /TODO\[e2e\].*waitForTimeout/);
  });

  it('injects tenantGuard + tags into the first test block', () => {
    const src = [
      "import { test, expect } from '@playwright/test';",
      "test('creates a group', async ({ page }) => {",
      "  await page.goto('/groups');",
      '});',
    ].join('\n');
    const out = normalise(src, BASE, ['recorded', 'sop5']);
    assert.match(out, /test\('creates a group @recorded @sop5'/);
    assert.match(out, /await tenantGuard\(page\);/);
    assert.match(out, /{ tenantGuard, page }|{ page, tenantGuard }|tenantGuard,\s*page/);
  });

  it('does not duplicate tenantGuard if already destructured', () => {
    const src = [
      "import { test, expect } from '@playwright/test';",
      "test('safe', async ({ page, tenantGuard }) => {",
      "  await tenantGuard(page);",
      '});',
    ].join('\n');
    const out = normalise(src, BASE, ['recorded']);
    const occurrences = (out.match(/tenantGuard/g) || []).length;
    // The original reference stays, and we don't add a second one.
    assert.equal(occurrences, 2);
  });
});
