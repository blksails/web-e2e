import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface Finding {
  testId: string;
  title: string;
  file: string;
  severity: 'info' | 'warn' | 'error';
  rule: string;
  message: string;
  durationMs?: number;
}

interface TestRecord {
  id: string;
  title: string;
  file: string;
  tags: string[];
  status: TestResult['status'];
  durationMs: number;
  retries: number;
  annotations: { type: string; description?: string }[];
  sopId: string | null;
  recorded: boolean;
}

const SUGGESTION_JSON = 'reports/suggestions.json';
const SUGGESTION_MD = 'reports/suggestions.md';
const TESTS_JSON = 'reports/tests.json';
const TRENDS_JSONL = 'reports/trends.jsonl';
const TRENDS_MAX_LINES = 200;

const SLOW_TEST_MS = 15_000;
const SLOW_STEP_MS = 5_000;

export default class SuggestionReporter implements Reporter {
  private readonly records: TestRecord[] = [];
  private readonly findings: Finding[] = [];

  onBegin(_config: FullConfig, _suite: Suite): void {
    // no-op
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // Tags can live on either the leaf title or any ancestor describe block — scan all of them.
    const tags = extractTags(test.titlePath().join(' '));
    const sopId = tags.find((t) => /^sop\d+/.test(t)) ?? null;
    const record: TestRecord = {
      id: test.id,
      title: test.title,
      file: test.location.file,
      tags,
      status: result.status,
      durationMs: result.duration,
      retries: result.retry,
      annotations: test.annotations.map((a) => ({ type: a.type, description: a.description })),
      sopId,
      recorded: tags.includes('recorded'),
    };
    this.records.push(record);

    if (result.status === 'passed' && result.duration > SLOW_TEST_MS) {
      this.findings.push({
        testId: test.id,
        title: test.title,
        file: test.location.file,
        severity: 'warn',
        rule: 'slow-test',
        durationMs: result.duration,
        message: `Test took ${(result.duration / 1000).toFixed(1)}s (> ${SLOW_TEST_MS / 1000}s). Consider storageState reuse, fewer redundant network waits, or data-testid selectors.`,
      });
    }

    if (result.retry > 0 && result.status === 'passed') {
      this.findings.push({
        testId: test.id,
        title: test.title,
        file: test.location.file,
        severity: 'warn',
        rule: 'flaky',
        message: `Passed after ${result.retry} retry/retries. Investigate race conditions; consider locator.waitFor({state:'attached'}) or expect.poll over waitForTimeout.`,
      });
    }

    if (result.status === 'failed' || result.status === 'timedOut') {
      const message =
        result.error?.message?.split('\n')[0] ??
        (result.status === 'timedOut' ? 'Test timed out' : 'Test failed');
      this.findings.push({
        testId: test.id,
        title: test.title,
        file: test.location.file,
        severity: 'error',
        rule: result.status === 'timedOut' ? 'timeout' : 'failure',
        message,
      });
    }

    for (const step of walkSteps(result)) {
      if (step.duration > SLOW_STEP_MS && step.category !== 'fixture') {
        this.findings.push({
          testId: test.id,
          title: test.title,
          file: test.location.file,
          severity: 'info',
          rule: 'slow-step',
          durationMs: step.duration,
          message: `Step "${step.title}" took ${(step.duration / 1000).toFixed(1)}s — candidate for a tighter locator or pre-seeded state.`,
        });
      }
    }

    const src = safeReadSource(test.location.file);
    if (src?.includes('waitForTimeout(')) {
      this.findings.push({
        testId: test.id,
        title: test.title,
        file: test.location.file,
        severity: 'warn',
        rule: 'anti-pattern:waitForTimeout',
        message: 'waitForTimeout detected. Prefer expect.poll, locator.waitFor, or network/role waits — sleeps are the #1 source of flake.',
      });
    }
  }

  async onEnd(result: FullResult): Promise<void> {
    ensureDir(SUGGESTION_JSON);
    writeFileSync(
      SUGGESTION_JSON,
      JSON.stringify(
        {
          finishedAt: new Date().toISOString(),
          overallStatus: result.status,
          totals: {
            tests: this.records.length,
            passed: this.records.filter((r) => r.status === 'passed').length,
            failed: this.records.filter((r) => r.status === 'failed' || r.status === 'timedOut').length,
            flaky: this.records.filter((r) => r.retries > 0 && r.status === 'passed').length,
            skipped: this.records.filter((r) => r.status === 'skipped').length,
            p95DurationMs: percentile(this.records.map((r) => r.durationMs), 95),
          },
          findings: this.findings,
        },
        null,
        2,
      ),
    );

    writeFileSync(TESTS_JSON, JSON.stringify(this.records, null, 2));

    writeFileSync(SUGGESTION_MD, renderMarkdown(this.records, this.findings));

    appendTrendLine({
      runId: process.env.GITHUB_RUN_ID ?? process.env.E2E_RUN_ID ?? new Date().toISOString(),
      timestamp: new Date().toISOString(),
      status: result.status,
      total: this.records.length,
      passed: this.records.filter((r) => r.status === 'passed').length,
      failed: this.records.filter((r) => r.status === 'failed' || r.status === 'timedOut').length,
      flaky: this.records.filter((r) => r.retries > 0 && r.status === 'passed').length,
      p95DurationMs: percentile(this.records.map((r) => r.durationMs), 95),
      ref: process.env.GITHUB_REF ?? null,
      sha: process.env.GITHUB_SHA ?? null,
    });
  }
}

interface TrendLine {
  runId: string;
  timestamp: string;
  status: string;
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  p95DurationMs: number;
  ref: string | null;
  sha: string | null;
}

function appendTrendLine(line: TrendLine): void {
  ensureDir(TRENDS_JSONL);
  // Keep the file bounded — truncate to last TRENDS_MAX_LINES entries when it grows past it.
  let existing: string[] = [];
  if (existsSync(TRENDS_JSONL)) {
    existing = readFileSync(TRENDS_JSONL, 'utf-8').split(/\r?\n/).filter(Boolean);
  }
  existing.push(JSON.stringify(line));
  if (existing.length > TRENDS_MAX_LINES) {
    existing = existing.slice(existing.length - TRENDS_MAX_LINES);
    writeFileSync(TRENDS_JSONL, existing.join('\n') + '\n');
  } else {
    appendFileSync(TRENDS_JSONL, JSON.stringify(line) + '\n');
  }
}

interface WalkableStep {
  title: string;
  category: string;
  duration: number;
}

function walkSteps(result: TestResult): WalkableStep[] {
  const out: WalkableStep[] = [];
  const visit = (steps: TestResult['steps']) => {
    for (const s of steps) {
      out.push({ title: s.title, category: s.category, duration: s.duration });
      if (s.steps?.length) visit(s.steps);
    }
  };
  visit(result.steps);
  return out;
}

function extractTags(title: string): string[] {
  return [...title.matchAll(/@([\w-]+)/g)].map((m) => m[1]);
}

function safeReadSource(file: string): string | null {
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function renderMarkdown(records: TestRecord[], findings: Finding[]): string {
  const bySop = new Map<string, TestRecord[]>();
  for (const r of records) {
    const key = r.sopId ?? 'other';
    const bucket = bySop.get(key) ?? [];
    bucket.push(r);
    bySop.set(key, bucket);
  }

  const bySeverity = new Map<string, Finding[]>();
  for (const f of findings) {
    const bucket = bySeverity.get(f.severity) ?? [];
    bucket.push(f);
    bySeverity.set(f.severity, bucket);
  }

  const lines: string[] = [];
  lines.push('# E2E Suggestions');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Tests: ${records.length}`);
  lines.push(`- Passed: ${records.filter((r) => r.status === 'passed').length}`);
  lines.push(`- Failed/Timeout: ${records.filter((r) => r.status === 'failed' || r.status === 'timedOut').length}`);
  lines.push(`- Flaky (retried and passed): ${records.filter((r) => r.retries > 0 && r.status === 'passed').length}`);
  lines.push(`- Recorded (@recorded): ${records.filter((r) => r.recorded).length}`);
  lines.push('');
  lines.push('## SOP coverage');
  lines.push('');
  for (const [sop, group] of [...bySop.entries()].sort()) {
    lines.push(`### ${sop}`);
    for (const r of group) {
      const status = r.status === 'passed' ? '✅' : r.status === 'skipped' ? '⏭' : '❌';
      lines.push(`- ${status} ${r.title} (${(r.durationMs / 1000).toFixed(2)}s)`);
    }
    lines.push('');
  }

  for (const severity of ['error', 'warn', 'info'] as const) {
    const items = bySeverity.get(severity) ?? [];
    if (items.length === 0) continue;
    lines.push(`## ${severity.toUpperCase()} findings (${items.length})`);
    lines.push('');
    for (const f of items) {
      lines.push(`- **[${f.rule}]** ${f.title} — ${f.message}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
