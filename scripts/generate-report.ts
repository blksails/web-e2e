#!/usr/bin/env tsx
/**
 * Build a single HTML dashboard from Playwright JSON + suggestion reporter output + SOP task list.
 *
 * Inputs
 *   reports/playwright.json       — native Playwright json reporter
 *   reports/suggestions.json      — custom suggestion reporter
 *   reports/tests.json            — raw test records
 *   ../../company-docs/specs/testing/blksails-e2e/tasks.md  — SOP task checklist (coverage matrix source)
 *
 * Output
 *   reports/index.html            — open this after a run
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

interface Suggestions {
  finishedAt: string;
  overallStatus: string;
  totals: {
    tests: number;
    passed: number;
    failed: number;
    flaky: number;
    skipped: number;
    p95DurationMs: number;
  };
  findings: Array<{
    testId: string;
    title: string;
    file: string;
    severity: 'info' | 'warn' | 'error';
    rule: string;
    message: string;
    durationMs?: number;
  }>;
}

interface TestRecord {
  id: string;
  title: string;
  file: string;
  tags: string[];
  status: string;
  durationMs: number;
  retries: number;
  sopId: string | null;
  recorded: boolean;
}

interface SopItem {
  sop: string;
  key: string;
  label: string;
  covered: boolean;
  matchedTest?: string;
}

const TASKS_DOC = resolve(process.cwd(), '../../../company-docs/specs/testing/blksails-e2e/tasks.md');

function loadSopItems(): SopItem[] {
  if (!existsSync(TASKS_DOC)) return [];
  const src = readFileSync(TASKS_DOC, 'utf-8');
  const items: SopItem[] = [];
  let sop = '';
  for (const line of src.split(/\r?\n/)) {
    const header = line.match(/^###\s+SOP-(\d+)(?:\s|$)/);
    if (header) {
      sop = `sop${header[1]}`;
      continue;
    }
    const item = line.match(/^\s*-\s+\[\s?\]\s+(\d+\.\d+)\s+(.*)$/);
    if (item && sop) {
      items.push({ sop, key: item[1], label: item[2].trim(), covered: false });
    }
  }
  return items;
}

function correlate(items: SopItem[], tests: TestRecord[]): SopItem[] {
  const bySop = new Map<string, TestRecord[]>();
  for (const t of tests) {
    if (!t.sopId) continue;
    (bySop.get(t.sopId) ?? bySop.set(t.sopId, []).get(t.sopId)!).push(t);
  }
  return items.map((it) => {
    const candidates = bySop.get(it.sop) ?? [];
    const match = candidates.find((t) => t.title.includes(it.key) || t.title.toLowerCase().includes(it.label.toLowerCase().slice(0, 18)));
    return match ? { ...it, covered: true, matchedTest: match.title } : it;
  });
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
}

function loadTrends(): TrendLine[] {
  if (!existsSync('reports/trends.jsonl')) return [];
  return readFileSync('reports/trends.jsonl', 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as TrendLine;
      } catch {
        return null;
      }
    })
    .filter((x): x is TrendLine => x !== null);
}

function renderSparkline(values: number[], width = 120, height = 28): string {
  if (values.length === 0) return '';
  const max = Math.max(...values, 1);
  const step = width / Math.max(values.length - 1, 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * height).toFixed(1)}`).join(' ');
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><polyline fill="none" stroke="#3b82f6" stroke-width="1.5" points="${points}"/></svg>`;
}

function render(suggestions: Suggestions | null, tests: TestRecord[], sopItems: SopItem[]): string {
  const totals = suggestions?.totals ?? { tests: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, p95DurationMs: 0 };
  const recorded = tests.filter((t) => t.recorded).length;
  const coverageBySop = sopItems.reduce<Record<string, { total: number; covered: number }>>((acc, it) => {
    const key = it.sop;
    acc[key] ??= { total: 0, covered: 0 };
    acc[key].total += 1;
    if (it.covered) acc[key].covered += 1;
    return acc;
  }, {});

  const sopRows = Object.entries(coverageBySop)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sop, n]) => {
      const pct = n.total === 0 ? 0 : Math.round((n.covered / n.total) * 100);
      return `<tr><td>${sop}</td><td>${n.covered} / ${n.total}</td><td><div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>${pct}%</td></tr>`;
    })
    .join('');

  const slowest = [...tests].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
  const slowRows = slowest
    .map((t) => `<tr><td>${escape(t.title)}</td><td>${(t.durationMs / 1000).toFixed(2)}s</td><td>${t.status}</td></tr>`)
    .join('');

  const findings = suggestions?.findings ?? [];
  const findingRows = findings
    .map(
      (f) =>
        `<tr class="sev-${f.severity}"><td>${f.severity.toUpperCase()}</td><td>${f.rule}</td><td>${escape(f.title)}</td><td>${escape(f.message)}</td></tr>`,
    )
    .join('');

  const gaps = sopItems.filter((i) => !i.covered);
  const gapRows = gaps
    .map((g) => `<tr><td>${g.sop}</td><td>${g.key}</td><td>${escape(g.label)}</td></tr>`)
    .join('');

  const trends = loadTrends().slice(-20);
  const passRateSpark = renderSparkline(trends.map((t) => (t.total > 0 ? (t.passed / t.total) * 100 : 0)));
  const p95Spark = renderSparkline(trends.map((t) => t.p95DurationMs / 1000));
  const trendCard =
    trends.length > 0
      ? `<div class="grid" style="grid-template-columns: repeat(2, 1fr)"><div class="card"><div class="label">Pass rate (last ${trends.length})</div>${passRateSpark}</div><div class="card"><div class="label">p95 seconds (last ${trends.length})</div>${p95Spark}</div></div>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>BlackSail E2E — Report</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 24px; line-height: 1.45; }
  h1 { margin-bottom: 4px; }
  .muted { color: #777; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 16px; margin: 24px 0; }
  .card { border: 1px solid #ddd3; border-radius: 12px; padding: 16px; }
  .card .value { font-size: 32px; font-weight: 600; }
  .card .label { color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #ddd3; font-size: 14px; }
  th { background: #f8f8f81a; }
  .bar { display: inline-block; width: 120px; height: 8px; background: #ddd6; border-radius: 4px; margin-right: 6px; vertical-align: middle; }
  .bar-fill { height: 100%; background: #22c55e; border-radius: 4px; }
  tr.sev-error td:first-child { color: #ef4444; font-weight: 600; }
  tr.sev-warn td:first-child  { color: #f59e0b; font-weight: 600; }
  tr.sev-info td:first-child  { color: #3b82f6; }
  .link { font-size: 13px; }
</style>
</head>
<body>
  <h1>BlackSail E2E — Report</h1>
  <div class="muted">Generated ${new Date().toISOString()}${suggestions ? ` · Status: <strong>${suggestions.overallStatus}</strong>` : ''}</div>
  <p class="link">Detailed per-test report: <a href="playwright-html/index.html">playwright-html/index.html</a></p>

  <div class="grid">
    <div class="card"><div class="value">${totals.tests}</div><div class="label">Tests</div></div>
    <div class="card"><div class="value" style="color:#22c55e">${totals.passed}</div><div class="label">Passed</div></div>
    <div class="card"><div class="value" style="color:#ef4444">${totals.failed}</div><div class="label">Failed</div></div>
    <div class="card"><div class="value" style="color:#f59e0b">${totals.flaky}</div><div class="label">Flaky</div></div>
    <div class="card"><div class="value">${recorded}</div><div class="label">Recorded</div></div>
  </div>

  <h2>SOP coverage</h2>
  <table><thead><tr><th>SOP</th><th>Covered / Planned</th><th>Progress</th></tr></thead><tbody>${sopRows || '<tr><td colspan="3" class="muted">No SOP tasks found in tasks.md — verify TASKS_DOC path.</td></tr>'}</tbody></table>

  <h2>Uncovered SOP items</h2>
  <table><thead><tr><th>SOP</th><th>Key</th><th>Item</th></tr></thead><tbody>${gapRows || '<tr><td colspan="3" class="muted">All SOP items have a matching test ✅</td></tr>'}</tbody></table>

  <h2>Top 5 slowest</h2>
  <table><thead><tr><th>Test</th><th>Duration</th><th>Status</th></tr></thead><tbody>${slowRows || '<tr><td colspan="3" class="muted">No tests recorded.</td></tr>'}</tbody></table>

  <h2>Suggestions &amp; findings</h2>
  <table><thead><tr><th>Severity</th><th>Rule</th><th>Test</th><th>Message</th></tr></thead><tbody>${findingRows || '<tr><td colspan="4" class="muted">No findings 🎉</td></tr>'}</tbody></table>

  <h2>p95 duration</h2>
  <p><strong>${(totals.p95DurationMs / 1000).toFixed(2)}s</strong> — keep PR smoke under 5 min total (see tasks.md §非功能要求).</p>

  ${trends.length > 0 ? `<h2>Trends</h2>${trendCard}` : ''}
</body>
</html>`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function safeRead<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (err) {
    console.warn(`[report] Failed to parse ${path}: ${(err as Error).message}`);
    return null;
  }
}

function main(): void {
  const suggestions = safeRead<Suggestions>('reports/suggestions.json');
  const tests = safeRead<TestRecord[]>('reports/tests.json') ?? [];
  const sopItems = correlate(loadSopItems(), tests);
  const html = render(suggestions, tests, sopItems);
  writeFileSync('reports/index.html', html);
  console.log('[report] reports/index.html');
  console.log('[report] Open in browser for the dashboard.');
}

main();
