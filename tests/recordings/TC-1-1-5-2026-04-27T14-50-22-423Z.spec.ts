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
  await page.getByRole('tab', { name: '短信登录' }).click();
  await page.getByRole('textbox', { name: '手机号' }).click();
  await page.getByRole('textbox', { name: '手机号' }).fill('18611725210');
  await page.getByRole('textbox', { name: '手机号' }).click();
  await page.getByRole('textbox', { name: '手机号' }).fill('17373198502');
  await page.getByRole('button', { name: '获取验证码' }).click();
  await page.getByRole('textbox', { name: '验证码' }).click();
  await page.getByRole('textbox', { name: '验证码' }).fill('313654');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('textbox', { name: '请输入邮箱' })).toBeVisible();
});