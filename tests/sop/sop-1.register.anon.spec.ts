import { test, expect } from '@playwright/test';

/**
 * SOP-1 — 注册账户
 *
 * Runs with the `chromium-anonymous` project (storageState = undefined) because registration
 * is by definition an unauthenticated flow. The spec is scoped to verifying entry points and
 * negative paths; a positive end-to-end signup creates real DB rows on staging and is gated
 * behind E2E_ALLOW_REGISTRATION=1 until seed cleanup is wired up (see scripts/seed-staging.ts).
 */
test.describe('@sop1 registration', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('1.1 @smoke signup link reachable from login', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    const signupLink = page.getByRole('button', { name: /注册/ });
    await expect(signupLink).toBeVisible();
  });

  test('1.5 @sop1 rejects invalid email format', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.getByRole('textbox', { name: '邮箱' }).fill('not-an-email');
    await page.getByLabel('密码', { exact: true }).fill('short');
    await page.getByRole('button', { name: '登录', exact: true }).click();

    // HTML5 validity or app-level error — either should keep us on /login.
    await expect(page).toHaveURL(/\/login/);
  });

  test('1.2 sms login surface — captcha interaction', async ({ page }) => {
    test.fixme(
      true,
      'Flaky on web-beta: Radix Tab click does not consistently flip aria-selected; likely React 19 hydration race with the autoplay background video. Revisit once /login no longer autoplays video or once we switch to a dedicated login route without media.',
    );
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    const smsTab = page.getByRole('tab', { name: /短信登录/ });
    await smsTab.click();
    await expect(smsTab).toHaveAttribute('aria-selected', 'true');
    const phone = page.getByRole('textbox', { name: '手机号' });
    await phone.waitFor({ state: 'visible' });
    const sendCode = page.getByRole('button', { name: /获取验证码/ });
    await expect(sendCode).toBeDisabled();
    await phone.fill('13800000000');
    await expect(sendCode).toBeEnabled();
  });

  test.skip('1.3 full signup creates user + default company', async ({ page: _page }) => {
    // Skipped by default. Flip E2E_ALLOW_REGISTRATION=1 and implement DB assertion via a
    // Supabase service-role client to make this runnable. Leaves an audit trail for SOP-1.
    test.skip(
      !process.env.E2E_ALLOW_REGISTRATION,
      'Set E2E_ALLOW_REGISTRATION=1 and wire up apps/web-e2e/scripts/seed-staging.ts cleanup before enabling.',
    );
  });
});
