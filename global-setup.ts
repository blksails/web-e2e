import { chromium, type FullConfig } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const AUTH_FILE = '.auth/admin.json';

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  const baseURL = process.env.E2E_BASE_URL ?? 'https://web-beta.apps.blksails.cn';

  if (!email || !password) {
    console.warn(
      '[global-setup] E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD not set — skipping storageState pre-warm. ' +
        'Authenticated specs will fail until you populate .env.local.',
    );
    return;
  }

  if (!existsSync(dirname(AUTH_FILE))) {
    mkdirSync(dirname(AUTH_FILE), { recursive: true });
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  // Login page autoplays a background video — 'load' event doesn't fire within 30s; use DOMContentLoaded.
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  // Use getByRole('textbox') instead of getByLabel — the "邮箱" text also lives in the placeholder,
  // which would cause getByLabel to match two nodes and throw strict-mode violation.
  await page.getByRole('textbox', { name: '邮箱' }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();

  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });

  await context.storageState({ path: AUTH_FILE });
  await browser.close();
}
