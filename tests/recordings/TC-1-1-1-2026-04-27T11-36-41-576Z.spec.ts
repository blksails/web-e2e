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
  await page.getByRole('textbox', { name: '邮箱' }).click();
  await page.getByRole('textbox', { name: '邮箱' }).fill('jxk2yk@gmail.com');
  await page.getByRole('textbox', { name: '密码' }).click();
  await page.getByRole('textbox', { name: '密码' }).fill('gy5201314');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.locator('div').filter({ hasText: /^邮箱 已绑定$/ })).toBeVisible();
  await page.locator('div').filter({ hasText: /^邮箱 已绑定$/ }).click();
  await expect(page.locator('div').filter({ hasText: /^邮箱 已绑定$/ })).toBeVisible();
});