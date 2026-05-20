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
  await page.getByRole('textbox', { name: '邮箱' }).click();
  await page.getByRole('textbox', { name: '邮箱' }).fill('785242926@qq.com');
  await page.getByRole('textbox', { name: '密码' }).click();
  await page.getByRole('textbox', { name: '密码' }).fill('13579dcbaaa');
  await page.locator('div').nth(4).click();
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByText('邮箱或密码错误，请重试')).toBeVisible();
});