import { test, expect } from '../../fixtures/base';

/**
 * SOP-5.2 — 客服账户 (kf-accounts)
 */
test.describe('@sop5 wxwork kf-accounts', () => {
  test('5.2.a @smoke kf-accounts list loads', async ({ page, wxworkPage, tenantGuard }) => {
    await wxworkPage.gotoKfAccounts();
    await tenantGuard(page);
    await expect(page).toHaveURL(/\/wxwork\/kf-accounts/);
  });

  test.fixme('5.2.b 创建按钮可见', async ({ page, wxworkPage, tenantGuard }) => {
    test.fixme(true, 'Placeholder — button text on /wxwork/kf-accounts needs to be captured from staging.');
    await wxworkPage.gotoKfAccounts();
    await tenantGuard(page);
    await expect(page.getByRole('button', { name: /创建|新建|add/i }).first()).toBeVisible();
  });
});
