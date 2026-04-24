#!/usr/bin/env tsx
/**
 * Normalise a raw Playwright codegen recording into a maintainable spec:
 *   - strip absolute URLs → relative paths (baseURL handles the rest)
 *   - replace sleep-style waits with expect.poll skeletons
 *   - wrap in BlackSail fixtures + tenant guard
 *   - add @recorded tag and auto-slug title
 *
 * Usage: tsx scripts/import-recording.ts --file recordings/my-flow-2026-04-23.spec.ts [--sop sop5]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

function parseArgs(): { file: string; sop?: string; outDir: string } {
  const args = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = args.findIndex((a) => a === `--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const file = get('file');
  if (!file) {
    console.error('Usage: pnpm import --file <recording.spec.ts> [--sop sop5] [--outDir tests/recorded]');
    process.exit(1);
  }
  return {
    file,
    sop: get('sop'),
    outDir: get('outDir') ?? process.env.E2E_IMPORTS_DIR ?? 'tests/recorded',
  };
}

function normalise(source: string, baseUrl: string, tags: string[]): string {
  let out = source;

  // 1. imports → pull from our fixtures bundle so tenant guard is available.
  out = out.replace(
    /import\s*{\s*test,\s*expect\s*}\s*from\s*['"]@playwright\/test['"];?/g,
    "import { test, expect } from '../../fixtures/base';",
  );
  if (!out.includes("from '../../fixtures/base'")) {
    out = `import { test, expect } from '../../fixtures/base';\n` + out;
  }

  // 2. absolute URL → relative. `page.goto('https://web-beta.../foo')` becomes `page.goto('/foo')`.
  const absRe = new RegExp(`page\\.goto\\(['"]${escapeRegExp(baseUrl)}(/[^'"]*)?['"]\\)`, 'g');
  out = out.replace(absRe, (_m, path) => `page.goto('${path || '/'}')`);

  // 3. warn on sleeps.
  out = out.replace(/await page\.waitForTimeout\(\d+\);?/g, (m) => `// TODO[e2e]: replace ${m.trim()} with expect.poll / locator.waitFor`);

  // 4. inject tenant guard after first `test(` block opens.
  out = out.replace(
    /test\(\s*(['"`])([^'"`]+)\1\s*,\s*async\s*\(\s*{\s*([^}]*)\s*}\s*\)\s*=>\s*{/,
    (_m, q, title, destructure) => {
      const tagSuffix = tags.map((t) => `@${t}`).join(' ');
      const newTitle = `${title} ${tagSuffix}`.trim();
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

  const tags = ['recorded'];
  if (sop) tags.push(sop);

  const normalised = normalise(source, baseUrl, tags);

  mkdirSync(outDir, { recursive: true });
  const outName = basename(file).replace(/\.spec\.ts$/, '.recorded.spec.ts');
  const outPath = join(outDir, outName);

  writeFileSync(outPath, normalised);
  console.log(`[import] Wrote ${outPath}`);
  console.log('[import] Next steps:');
  console.log('  1. Review the spec — address any TODO[e2e] markers.');
  console.log('  2. Run: pnpm test -- ' + outPath);
  console.log('  3. Promote stable selectors into a POM under pages/ where they repeat.');
}

main();
