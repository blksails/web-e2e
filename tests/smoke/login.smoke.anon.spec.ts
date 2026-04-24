import { test, expect } from '@playwright/test';

test.describe('@smoke login surface', () => {
  test('login page renders email + password fields @smoke', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    // shadcn CardTitle doesn't always render as <h3> so use a text locator for the title.
    await expect(page.getByText('登录您的账户')).toBeVisible();
    // getByRole is more robust than getByLabel here — "邮箱" appears in both <label> and placeholder.
    await expect(page.getByRole('textbox', { name: '邮箱' })).toBeVisible();
    await expect(page.getByLabel('密码', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  });

  test('wechat login entry exists @smoke', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('link', { name: /微信登录/ })).toBeVisible();
  });
});
