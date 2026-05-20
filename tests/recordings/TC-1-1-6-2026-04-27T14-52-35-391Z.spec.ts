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
  await page.getByRole('textbox', { name: '手机号' }).fill('17358892937');
  await page.getByRole('button', { name: '获取验证码' }).click();
  await page.getByRole('textbox', { name: '验证码' }).click();
  await page.getByRole('textbox', { name: '验证码' }).fill('769228');
  await page.getByRole('button', { name: '登录' }).click();
  await page.goto('https://web-beta.apps.blksails.cn/dashboard');
  await page.getByRole('button', { name: '企业微信' }).click();
  await page.getByRole('button', { name: '企业微信' }).click();
  await page.getByRole('button', { name: '广告帐户' }).click();
  await page.getByRole('link', { name: '广点通', exact: true }).click();
  await page.goto('https://web-beta.apps.blksails.cn/advertiser/gdt?query=&page=1&pageSize=20&sortBy=createdAt');
  await expect(page.getByRole('link', { name: '黑帆投放.ai' })).toBeVisible();
});