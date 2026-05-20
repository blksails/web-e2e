# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Standalone pnpm workspace (`web-e2e`) — Playwright E2E suite for the BlackSail webapp. Default target is the staging host `https://web-beta.apps.blksails.cn`, scoped to `company_id=1`. The suite is shipped two ways: as a CLI for engineers/CI, and wrapped in a Tauri desktop app (`src-tauri/` is generated at build time by `stage-template`; not present in the source tree) for non-CLI testers.

Before running anything that hits the network, `.env.local` must exist with `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` for a `company_id=1` admin — `global-setup.ts` uses them once to log in and persist `.auth/admin.json`, which every authed spec then reuses via `storageState`.

## Commands

```bash
pnpm install                  # also runs `playwright install chromium` via postinstall
pnpm install-browsers         # full install with OS deps (CI / first-time)

pnpm test                     # full run (preflight gate runs first)
pnpm test:smoke               # @smoke tag only — PR gate, must stay <5 min
pnpm test:sop                 # tests/sop only
pnpm test:recorded            # tests/recorded only
pnpm test:any                 # uses playwright.any.config.ts — for specs outside tests/
pnpm test:headed              # with browser window
pnpm test:ui                  # Playwright UI mode
pnpm test -g "5.2"            # filter by title substring
pnpm test path/to/file.spec.ts # single file

pnpm lint                     # eslint (lint:fix to auto-fix)
pnpm typecheck                # tsc --noEmit
pnpm test:unit                # node:test on scripts/__tests__/*

pnpm preflight                # standalone — runs automatically before test/test:smoke
pnpm record -- --name X --path /route   # codegen with logged-in storageState
pnpm import -- --file recordings/X.spec.ts --sop sop5   # normalise recording into tests/recorded/

pnpm report                   # open Playwright HTML report
pnpm report:dashboard         # build reports/index.html (custom dashboard)
```

## Architecture

### Two Playwright configs, by design

- **`playwright.config.ts`** — main config. Three projects: `setup` (runs `global-setup.ts` to capture storageState), `chromium` (depends on setup, uses `.auth/admin.json`, ignores `*.anon.spec.ts`), and `chromium-anonymous` (only `*.anon.spec.ts`, empty cookies). All custom reporters wired here.
- **`playwright.any.config.ts`** — for running specs *outside* `tests/`, like raw codegen output in `recordings/`. Inherits from the main config but: `testDir` comes from `E2E_SPEC_DIR`; only `chromium-record-playback` project; `retries: 0`; minimal reporter. The desktop "立即试跑" button uses this so testers can verify a recording without first importing it.

Both configs collaborate with **`scripts/detect-login.ts`**: when a spec being executed exercises the login flow itself (heuristic: `/login` goto, `登录`/`密码`/`邮箱` selectors), the auth config branch is skipped — storageState is forced empty, `globalSetup` is bypassed, and (at import time) the spec is renamed `*.anon.spec.ts` so it routes through the `chromium-anonymous` project. Override with `// @keep-auth` in the spec, or hard-force via `E2E_FORCE_ANON=1`.

### Fixtures and tenantGuard

`fixtures/base.ts` is the import everyone in `tests/` uses (`import { test, expect } from '../../fixtures/base'`). It extends Playwright's `test` with the POM instances (`authPage`, `membersPage`, `advertisersPage`, `wxworkPage`) and the **`tenantGuard`** fixture.

`tenantGuard(page)` must be called before any destructive action. It does **not** read `company_id` from the browser — BlackSail stores tenant identity in the Supabase `profiles` table, not in cookies/localStorage. Instead it enforces two proxies:

1. `E2E_BASE_URL`'s host must look non-prod (must NOT match production-ish `.apps.blksails.cn` without a `beta|staging|dev|test` token).
2. A valid `sb-*-auth-token` cookie exists, proving we're acting as the declared admin.

The "this admin belongs to company_id=1" mapping is a contract of `.env.local` — if you point the suite at the wrong account, the guard cannot catch it.

### Page Object Model

Specs must not hold raw selectors. All selectors live in `pages/*.ts` (each extends `BasePage`). New module → new POM file → register it in `fixtures/base.ts`.

Selector priority: `getByRole({name})` → `getByLabel(text, {exact: true})` → `getByText` → `getByTestId` → CSS as last resort.

Known pitfalls baked into the existing POMs:
- The login `邮箱` text appears in both label and placeholder; `getByLabel('邮箱')` throws strict-mode. Use `getByRole('textbox', { name: '邮箱' })`.
- The login page autoplays a background video; `waitUntil: 'load'` won't fire in 30s. Use `domcontentloaded`.
- BlackSail uses `sonner` for toasts → assert via `getByRole('status')`.
- Many pages show "加载中..." while fetching from Supabase. `BasePage.waitForLoaded()` exists for this — call it before asserting content.

### Preflight + ESLint enforcement (two layers)

**`scripts/preflight.ts`** runs as `pretest` / `pretest:smoke` and exits non-zero on:
- `test.only` / `describe.only`
- `page.waitForTimeout(...)`
- Absolute URLs matching `E2E_BASE_URL` (selectors should be relative so `baseURL` controls env)
- Specs in `tests/recorded/` importing from `@playwright/test` directly (must import from `fixtures/base`)

**`eslint.config.js`** layers more rules per directory: forbids `waitForTimeout`/`.only`/`console.*` in specs, and forbids `@playwright/test` imports in `tests/recorded/**`. Scripts and reporters have looser rules (node-only, can use `console`).

### Tag conventions

Tags are inline in titles (`test('@sop2 invite member', ...)`); the suggestion reporter scans the full titlePath, so tags on `describe()` propagate.

| Tag | Meaning |
|---|---|
| `@smoke` | PR gate — must stay fast |
| `@sop1`…`@sop5` | SOP business groups (matches `tests/sop/sop-N*.spec.ts`) |
| `@recorded` | Imported from tester codegen — lives in `tests/recorded/` |
| `@flaky` | Known-flaky, isolated from main flow |
| `@a11y` | Runs axe-core (see `fixtures/a11y.ts`) |

Don't use `test.skip(true)` to silence flakes — use `test.fixme(true, 'reason')` or the `@flaky` tag.

### Reporters and reports

`reporters/suggestion-reporter.ts` runs alongside the standard reporters and produces:
- `reports/suggestions.json` / `suggestions.md` — slow tests, retried-but-passed (flake signals), failures with one-line context
- `reports/tests.json` — per-test record (id, file, tags, status, sopId, duration)
- `reports/trends.jsonl` — appended once per run, capped at 200 lines

`pnpm report:dashboard` runs `scripts/generate-report.ts` which consumes those plus `playwright.json` to render `reports/index.html` (the SOP coverage matrix). `pnpm report` opens the standard Playwright HTML at `reports/playwright-html/`.

### Recording → import workflow

1. `pnpm record -- --name X --path /route` opens Chromium with logged-in storageState and starts codegen; output lands in `recordings/X-<timestamp>.spec.ts` (gitignored).
2. `pnpm import -- --file recordings/X.spec.ts --sop sop5` (in `scripts/import-recording.ts`) rewrites the imports to `fixtures/base`, replaces absolute URLs with relative paths, comments out `waitForTimeout` with a TODO, injects the `@recorded` (and any `@sopN`) tag, and adds `tenantGuard` to the destructuring — unless it's a login spec, in which case it's saved as `*.anon.spec.ts` with empty storageState and no guard.
3. Once stable, promote from `tests/recorded/` to `tests/sop/`, drop `@recorded`, lift selectors into a POM.

## Common gotchas when editing

- Don't change `playwright.config.ts` projects without considering `playwright.any.config.ts` — they share `base.use`.
- Adding a new POM requires registering it in `fixtures/base.ts`'s `BlackSailFixtures` interface AND the `test.extend<>()` call — otherwise specs can't destructure it.
- The desktop app's `stage-template` script (`scripts/stage-template.ts`) has an `INCLUDE` whitelist that ships files into the bundled template; new top-level files won't be reachable by desktop-app users unless added there.
- `.auth/admin.json` going stale shows up as confusing failures in unrelated specs. Delete it and rerun — global-setup will rebuild.
- Reporter outputs and traces are gitignored under `reports/` and `test-results/`. Don't commit them.
