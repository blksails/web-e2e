#!/usr/bin/env tsx
/**
 * Normalise a raw Playwright codegen recording into a maintainable spec:
 *   - strip absolute URLs → relative paths (baseURL handles the rest)
 *   - replace sleep-style waits with expect.poll skeletons
 *   - wrap in BlackSail fixtures + tenant guard
 *   - add @recorded tag and auto-slug title
 *   - if the recording exercises the login flow, write it as `*.anon.spec.ts`,
 *     inject an empty storageState, and skip tenantGuard injection
 *
 * Usage: pnpm import:rec -- --file recordings/my-flow-2026-04-23.spec.ts [--sop sop5]
 *   (NOTE: the script is named `import:rec` rather than `import` because pnpm has a built-in
 *    `pnpm import` command that imports lockfiles from npm/yarn — the collision would route
 *    `pnpm import` to the built-in and trigger ERR_PNPM_LOCKFILE_NOT_FOUND.)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { specContainsLogin } from './detect-login';

function parseArgs(): { file: string; sop?: string; outDir: string } {
  const args = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = args.findIndex((a) => a === `--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const file = get('file');
  if (!file) {
    console.error('Usage: pnpm import:rec -- --file <recording.spec.ts> [--sop sop5] [--outDir tests/recorded]');
    process.exit(1);
  }
  return {
    file,
    sop: get('sop'),
    outDir: get('outDir') ?? process.env.E2E_IMPORTS_DIR ?? 'tests/recorded',
  };
}

function normalise(
  source: string,
  baseUrl: string,
  tags: string[],
  options: { anonymous: boolean } = { anonymous: false },
): string {
  let out = source;

  // 1. imports → pull from our fixtures bundle so tenant guard is available.
  out = out.replace(
    /import\s*{\s*test,\s*expect\s*}\s*from\s*['"]@playwright\/test['"];?/g,
    "import { test, expect } from '../../fixtures/base';",
  );
  if (!out.includes("from '../../fixtures/base'")) {
    out = `import { test, expect } from '../../fixtures/base';\n` + out;
  }

  // 1b. anonymous specs need an empty storageState so the .anon project's
  // empty cookies aren't overridden by anything; we inject right after the
  // fixtures import so it applies to every test in the file.
  if (options.anonymous && !/test\.use\(\s*\{[^}]*storageState/.test(out)) {
    out = out.replace(
      /(import \{ test, expect \} from '\.\.\/\.\.\/fixtures\/base';\n)/,
      `$1\ntest.use({ storageState: { cookies: [], origins: [] } });\n`,
    );
  }

  // 2. absolute URL → relative. `page.goto('https://web-beta.../foo')` becomes `page.goto('/foo')`.
  const absRe = new RegExp(`page\\.goto\\(['"]${escapeRegExp(baseUrl)}(/[^'"]*)?['"]\\)`, 'g');
  out = out.replace(absRe, (_m, path) => `page.goto('${path || '/'}')`);

  // 3. warn on sleeps.
  out = out.replace(/await page\.waitForTimeout\(\d+\);?/g, (m) => `// TODO[e2e]: replace ${m.trim()} with expect.poll / locator.waitFor`);

  // 4. inject tags + (for non-anonymous flows) tenant guard. tenantGuard reads the
  // sb-*-auth-token cookie and asserts it's present, which by definition can't hold
  // for a spec that's *performing* the login — so we skip it for anonymous imports.
  out = out.replace(
    /test\(\s*(['"`])([^'"`]+)\1\s*,\s*async\s*\(\s*{\s*([^}]*)\s*}\s*\)\s*=>\s*{/,
    (_m, q, title, destructure) => {
      const tagSuffix = tags.map((t) => `@${t}`).join(' ');
      const newTitle = `${title} ${tagSuffix}`.trim();
      if (options.anonymous) {
        return `test(${q}${newTitle}${q}, async ({ ${destructure} }) => {`;
      }
      const needsGuard = !destructure.includes('tenantGuard');
      const destr = needsGuard ? `${destructure.trim()}${destructure.trim() ? ', ' : ''}tenantGuard, page` : destructure;
      const guardCall = needsGuard ? '\n  await tenantGuard(page);' : '';
      return `test(${q}${newTitle}${q}, async ({ ${destr} }) => {${guardCall}`;
    },
  );

  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function main(): void {
  const { file, sop, outDir } = parseArgs();
  if (!existsSync(file)) {
    console.error(`[import] Not found: ${file}`);
    process.exit(1);
  }
  const baseUrl = process.env.E2E_BASE_URL ?? 'https://web-beta.apps.blksails.cn';
  const source = readFileSync(file, 'utf-8');
  const anonymous = specContainsLogin(source);

  const tags = ['recorded'];
  if (sop) tags.push(sop);
  if (anonymous) tags.push('anon');

  const normalised = normalise(source, baseUrl, tags, { anonymous });

  mkdirSync(outDir, { recursive: true });
  const suffix = anonymous ? '.recorded.anon.spec.ts' : '.recorded.spec.ts';
  const outName = basename(file).replace(/\.spec\.ts$/, suffix);
  const outPath = join(outDir, outName);

  writeFileSync(outPath, normalised);
  console.log(`[import] Wrote ${outPath}`);
  if (anonymous) {
    console.log(
      '[import] 检测到登录行为 — 已写为 .anon.spec.ts（空 storageState、不注入 tenantGuard）。' +
        ' 在 spec 中加 `// @keep-auth` 可强制保留登录态。',
    );
  }
  console.log('[import] Next steps:');
  console.log('  1. Review the spec — address any TODO[e2e] markers.');
  console.log('  2. Run: pnpm test -- ' + outPath);
  console.log('  3. Promote stable selectors into a POM under pages/ where they repeat.');
}

main();
