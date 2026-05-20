import { test, expect } from '@playwright/test';

test.use({
  colorScheme: 'light',
  storageState: '.auth/admin.json',
  viewport: {
    height: 900,
    width: 1440
  }
});

test('test', async ({ page }) => {
  await page.goto('https://web-beta.apps.blksails.cn/login');
  await page.getByRole('link', { name: '微信登录' }).click();
  await page.goto('https://web-beta.apps.blksails.cn/login');
  await page.getByRole('tab', { name: '短信登录' }).click();
  await page.getByRole('link', { name: '微信登录' }).click();
  await expect(page.getByText('无法访问此网站')).toBeVisible();
});