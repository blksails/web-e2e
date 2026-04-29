import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Heuristic detector for "this spec exercises the login flow itself, so don't
 * pre-warm an admin session into it." Used at two seams:
 *
 *   - playwright.any.config.ts (runtime): empties storageState + skips globalSetup
 *     when the file(s) being run contain login behaviour.
 *   - scripts/import-recording.ts (import time): renames the imported spec to
 *     `*.anon.spec.ts` so the main config's chromium-anonymous project picks it
 *     up, and injects `test.use({ storageState: { cookies: [], origins: [] } })`.
 *
 * Strategy is intentionally aggressive (string match, not AST). False positives
 * are recoverable: drop `// @keep-auth` anywhere in the file to opt out.
 */

const KEEP_AUTH_MARKER = /\/\/\s*@keep-auth\b/;

// "登录" alone is ambiguous (登录 == log in, 退出登录 == log out). The lookahead
// `(?![^'"\`,)]*退出)` skips the match when the button/link's accessible name
// also contains 退出 anywhere up to the next argument boundary — effectively
// excluding logout buttons while keeping 登录 / 重新登录 / 登录您的账户 etc.
//
// Both `button` and `link` roles trigger: codegen records the entry on the
// public landing page as a `link` (e.g. nav item to /login), and the form's
// submit control as a `button`. Either is a strong signal.
const LOGIN_SIGNALS: RegExp[] = [
  /page\.goto\(\s*[`'"][^`'"]*\/login\b/,
  /getByRole\(\s*['"`](?:button|link)['"`]\s*,\s*\{\s*name\s*:\s*['"`/](?![^'"`,)]*退出)[^'"`,)]*登录/,
  /getByLabel\(\s*[`'"]密码/,
  /getByRole\(\s*['"`]textbox['"`]\s*,\s*\{\s*name\s*:\s*['"`/][^'"`,)]*邮箱/,
  /getByRole\(\s*['"`]textbox['"`]\s*,\s*\{\s*name\s*:\s*['"`/][^'"`,)]*手机号/,
];

export function specContainsLogin(source: string): boolean {
  if (KEEP_AUTH_MARKER.test(source)) return false;
  return LOGIN_SIGNALS.some((re) => re.test(source));
}

export function fileContainsLoginSpec(path: string): boolean {
  try {
    return specContainsLogin(readFileSync(path, 'utf-8'));
  } catch {
    return false;
  }
}

function walkSpecs(dir: string, visit: (path: string) => boolean): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      if (!walkSpecs(p, visit)) return false;
    } else if (ent.isFile() && /\.spec\.ts$/.test(ent.name)) {
      if (!visit(p)) return false;
    }
  }
  return true;
}

export function findLoginSpecInDir(dir: string): string | null {
  let found: string | null = null;
  walkSpecs(dir, (path) => {
    if (fileContainsLoginSpec(path)) {
      found = path;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Decide which spec (if any) being executed contains login behaviour.
 *
 * Prefers explicit CLI file args — the desktop "立即试跑" flow always passes
 * the target file path positionally, so this gives per-file precision.
 * Falls back to scanning `dir` only when no spec args are present, and skips
 * the scan when `dir` is "." to avoid sweeping the whole project root.
 */
export function detectLoginSpec(dir: string, argv: string[] = process.argv): string | null {
  const argFiles = argv.filter((a) => /\.spec\.ts$/.test(a) && existsSync(a));
  if (argFiles.length > 0) {
    for (const f of argFiles) {
      if (fileContainsLoginSpec(f)) return f;
    }
    return null;
  }
  if (!dir || dir === '.' || dir === './') return null;
  return findLoginSpecInDir(dir);
}
