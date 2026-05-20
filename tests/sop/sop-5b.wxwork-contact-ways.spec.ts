import { test, expect } from '../../fixtures/base';

/**
 * SOP-5.3 — 获客联系方式 (contact-ways)
 */
test.describe('@sop5 wxwork contact-ways', () => {
  test('5.3.a @smoke contact-ways list loads', async ({ page, wxworkPage, tenantGuard }) => {
    await wxworkPage.gotoContactWays();
    await tenantGuard(page);
    await expect(page).toHaveURL(/\/wxwork\/contact-ways/);
  });

  test.fixme('5.3.b 新建入口存在', async ({ page, wxworkPage, tenantGuard }) => {
    test.fixme(true, 'Placeholder — entry-button text on /wxwork/contact-ways needs staging capture.');
    await wxworkPage.gotoContactWays();
    await tenantGuard(page);
    await expect(page.getByRole('button', { name: /新建|创建/ }).first()).toBeVisible();
  });

  test.skip('5.3.c 生成二维码并下载', async () => {
    test.skip(true, 'TODO: hit 新建 dialog, fill reception, assert QR canvas + 下载 button.');
  });
});
