import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

/**
 * Tests for the recording importer's transform rules. Same strategy as generate-report.test.ts:
 * parser logic is duplicated here so we test behaviour, not implementation shape.
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalise(
  source: string,
  baseUrl: string,
  tags: string[],
  options: { anonymous: boolean } = { anonymous: false },
): string {
  let out = source;

  out = out.replace(
    /import\s*{\s*test,\s*expect\s*}\s*from\s*['"]@playwright\/test['"];?/g,
    "import { test, expect } from '../../fixtures/base';",
  );
  if (!out.includes("from '../../fixtures/base'")) {
    out = `import { test, expect } from '../../fixtures/base';\n` + out;
  }

  if (options.anonymous && !/test\.use\(\s*\{[^}]*storageState/.test(out)) {
    out = out.replace(
      /(import \{ test, expect \} from '\.\.\/\.\.\/fixtures\/base';\n)/,
      `$1\ntest.use({ storageState: { cookies: [], origins: [] } });\n`,
    );
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
      if (options.anonymous) {
        return `test(${q}${newTitle}${q}, async ({ ${destructure} }) => {`;
      }
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

const KEEP_AUTH_MARKER = /\/\/\s*@keep-auth\b/;
const LOGIN_SIGNALS: RegExp[] = [
  /page\.goto\(\s*[`'"][^`'"]*\/login\b/,
  /getByRole\(\s*['"`](?:button|link)['"`]\s*,\s*\{\s*name\s*:\s*['"`/](?![^'"`,)]*退出)[^'"`,)]*登录/,
  /getByLabel\(\s*[`'"]密码/,
  /getByRole\(\s*['"`]textbox['"`]\s*,\s*\{\s*name\s*:\s*['"`/][^'"`,)]*邮箱/,
  /getByRole\(\s*['"`]textbox['"`]\s*,\s*\{\s*name\s*:\s*['"`/][^'"`,)]*手机号/,
];
function specContainsLogin(source: string): boolean {
  if (KEEP_AUTH_MARKER.test(source)) return false;
  return LOGIN_SIGNALS.some((re) => re.test(source));
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

  it('skips tenantGuard injection for anonymous specs', () => {
    const src = [
      "import { test, expect } from '@playwright/test';",
      "test('logs in', async ({ page }) => {",
      "  await page.goto('/login');",
      '});',
    ].join('\n');
    const out = normalise(src, BASE, ['recorded', 'anon'], { anonymous: true });
    assert.ok(!out.includes('tenantGuard'), `expected no tenantGuard, got:\n${out}`);
  });

  it('injects empty storageState for anonymous specs', () => {
    const src = [
      "import { test, expect } from '@playwright/test';",
      "test('logs in', async ({ page }) => {",
      "  await page.goto('/login');",
      '});',
    ].join('\n');
    const out = normalise(src, BASE, ['recorded', 'anon'], { anonymous: true });
    assert.match(out, /test\.use\(\{ storageState: \{ cookies: \[\], origins: \[\] \} \}\);/);
  });
});

describe('specContainsLogin()', () => {
  it('flags page.goto(/login)', () => {
    assert.equal(specContainsLogin(`await page.goto('/login');`), true);
  });

  it('flags absolute /login URLs', () => {
    assert.equal(specContainsLogin(`await page.goto('https://web-beta.apps.blksails.cn/login');`), true);
  });

  it('flags 邮箱 textbox + 密码 label combo', () => {
    const src = [
      "await page.getByRole('textbox', { name: '邮箱' }).fill('a@b.cn');",
      "await page.getByLabel('密码', { exact: true }).fill('hunter2');",
    ].join('\n');
    assert.equal(specContainsLogin(src), true);
  });

  it('flags 手机号 (SMS login) textbox', () => {
    assert.equal(specContainsLogin(`page.getByRole('textbox', { name: '手机号' })`), true);
  });

  it('flags 登录 button with regex name', () => {
    assert.equal(specContainsLogin(`page.getByRole('button', { name: /登录/ })`), true);
  });

  it('flags 登录 link (codegen records nav entry as link, not button)', () => {
    assert.equal(specContainsLogin(`await page.getByRole('link', { name: '登录' }).click();`), true);
  });

  it('does not flag 退出登录 (logout) button', () => {
    assert.equal(specContainsLogin(`page.getByRole('button', { name: '退出登录' })`), false);
  });

  it('does not flag generic specs', () => {
    const src = [
      "await page.goto('/groups');",
      "await page.getByRole('button', { name: '新建' }).click();",
    ].join('\n');
    assert.equal(specContainsLogin(src), false);
  });

  it('respects the // @keep-auth escape hatch', () => {
    const src = [
      "// @keep-auth — verifying the login surface, not exercising it",
      "await page.goto('/login');",
      "await expect(page.getByText('登录您的账户')).toBeVisible();",
    ].join('\n');
    assert.equal(specContainsLogin(src), false);
  });
});
