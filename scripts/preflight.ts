#!/usr/bin/env tsx
/**
 * Preflight checks run before `pnpm test:smoke` to catch issues that would waste a CI slot:
 *   - focused tests (test.only / describe.only) that would silently skip the rest of the suite
 *   - waitForTimeout hardcoded sleeps (known flake source)
 *   - absolute URLs pointing at the current staging host (should be relative)
 *   - recorded specs still importing from @playwright/test directly
 *
 * Exits non-zero if any hard violation is found. Warnings are printed but don't block.
 *
 * Usage: pnpm preflight   OR   pnpm tsx scripts/preflight.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

interface Finding {
  file: string;
  line: number;
  rule: string;
  message: string;
  severity: 'error' | 'warn';
}

const STAGING_HOST = process.env.E2E_BASE_URL ?? 'https://web-beta.apps.blksails.cn';

function collectSpecs(dir = 'tests'): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile() && full.endsWith('.spec.ts')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

function check(file: string): Finding[] {
  const src = readFileSync(file, 'utf-8');
  const findings: Finding[] = [];
  const isRecorded = file.includes('tests/recorded/') || file.includes('tests\\recorded\\');

  src.split(/\r?\n/).forEach((line, i) => {
    const lineNo = i + 1;

    if (/\btest\.only\b/.test(line)) {
      findings.push({ file, line: lineNo, rule: 'no-focused-tests', severity: 'error', message: 'test.only — would skip the rest of the suite.' });
    }
    if (/\bdescribe\.only\b/.test(line)) {
      findings.push({ file, line: lineNo, rule: 'no-focused-tests', severity: 'error', message: 'describe.only — would skip the rest of the suite.' });
    }
    if (/\bpage\.waitForTimeout\s*\(/.test(line)) {
      findings.push({
        file,
        line: lineNo,
        rule: 'no-sleeps',
        severity: 'error',
        message: 'page.waitForTimeout — use expect.poll, locator.waitFor, or waitForResponse instead.',
      });
    }
    if (line.includes(STAGING_HOST)) {
      findings.push({
        file,
        line: lineNo,
        rule: 'no-absolute-urls',
        severity: 'error',
        message: `Hardcoded ${STAGING_HOST} — use relative paths so baseURL controls the target env.`,
      });
    }
    if (isRecorded && /from\s+['"]@playwright\/test['"]/.test(line)) {
      findings.push({
        file,
        line: lineNo,
        rule: 'recorded-uses-base-fixtures',
        severity: 'error',
        message: 'Recorded spec must import from ../../fixtures/base (for tenantGuard).',
      });
    }
    // Soft warnings — flagged but not blocking.
    if (/test\.skip\s*\(\s*[^,]+\)\s*;?$/.test(line) && !/test\.skip\s*\(\s*[^,]+,/.test(line)) {
      // test.skip(title) without a function body → dangling skip; fine.
      // But test.skip(condition, 'reason') should be used — this catches test.skip() with no reason.
    }
    const skipNoReason = line.match(/test\.skip\s*\(\s*true\s*\)\s*;?/);
    if (skipNoReason) {
      findings.push({
        file,
        line: lineNo,
        rule: 'skip-needs-reason',
        severity: 'warn',
        message: 'test.skip(true) without a reason — add a message so reviewers know why.',
      });
    }
  });

  return findings;
}

function main(): void {
  const specs = collectSpecs();
  if (specs.length === 0) {
    console.log('[preflight] no specs found under tests/ — nothing to check.');
    return;
  }

  const all: Finding[] = [];
  for (const f of specs) {
    all.push(...check(f));
  }

  const errors = all.filter((x) => x.severity === 'error');
  const warns = all.filter((x) => x.severity === 'warn');

  for (const f of all) {
    const rel = relative(process.cwd(), f.file);
    const prefix = f.severity === 'error' ? '✖' : '⚠';
    console.log(`${prefix} ${rel}:${f.line}  [${f.rule}]  ${f.message}`);
  }

  console.log('');
  console.log(`[preflight] ${specs.length} spec(s) scanned — ${errors.length} error(s), ${warns.length} warning(s)`);

  if (errors.length > 0) {
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  console.error('[preflight] unexpected error:', err);
  process.exit(1);
}
