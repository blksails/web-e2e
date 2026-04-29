#!/usr/bin/env tsx
/**
 * Tester-facing test recorder.
 *
 * Boots Playwright codegen already authenticated as the E2E admin so testers click through real
 * console flows without re-logging in. Output lands in recordings/<slug>-<timestamp>.spec.ts and
 * can later be normalised via `pnpm import:rec`.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://web-beta.apps.blksails.cn';
const AUTH_FILE = '.auth/admin.json';
const DEFAULT_RECORDINGS_DIR = 'recordings';

function parseArgs(): { slug: string; startPath: string; outDir: string } {
  const args = process.argv.slice(2);
  const getFlag = (name: string, fallback: string): string => {
    const i = args.findIndex((a) => a === `--${name}`);
    return i >= 0 ? args[i + 1] ?? fallback : fallback;
  };
  return {
    slug: getFlag('name', 'recording'),
    startPath: getFlag('path', '/'),
    outDir: getFlag('outDir', process.env.E2E_RECORDINGS_DIR ?? DEFAULT_RECORDINGS_DIR),
  };
}

function main(): void {
  const { slug, startPath, outDir } = parseArgs();

  if (!existsSync(AUTH_FILE)) {
    console.error(
      `[record] ${AUTH_FILE} missing. Run \`pnpm test -- --project=setup\` or populate E2E_ADMIN_* in .env.local first.`,
    );
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = join(outDir, `${slug}-${timestamp}.spec.ts`);
  const startUrl = new URL(startPath, BASE_URL).toString();

  const pwArgs = [
    'playwright',
    'codegen',
    '--target=playwright-test',
    `--load-storage=${AUTH_FILE}`,
    `--output=${outFile}`,
    '--viewport-size=1440,900',
    '--color-scheme=light',
    startUrl,
  ];

  console.log(`[record] Opening codegen → ${outFile}`);
  console.log('[record] When done, close the Playwright Inspector window. Then run:');
  console.log(`[record]   pnpm import:rec -- --file "${outFile}"`);

  const child = spawn('pnpm', ['exec', ...pwArgs], { stdio: 'inherit', shell: true });
  child.on('exit', (code) => process.exit(code ?? 0));
}

main();
