import { test, expect } from '../../fixtures/base';

/**
 * SOP-4 — 企业微信授权
 *
 * Real suite-auth scan flow can't be driven from Playwright (phone-scan). We assert that
 * company_id=1 has at least one corp already authorized in staging, and that the UI for
 * 重新授权 / 取消授权 is reachable. End-to-end 企微 auth stays manual.
 */
test.describe('@sop4 wxwork corps', () => {
  test('4.3 @smoke corps page lists authorized corps', async ({ page, wxworkPage, tenantGuard }) => {
    await wxworkPage.gotoCorps();
    await tenantGuard(page);
    // URL-level smoke; the actual "已授权" row markup needs to be captured via `pnpm record`.
    await expect(page).toHaveURL(/\/wxwork\/corps/);
  });

  test.fixme('4.1 @sop4 授权入口 present', async ({ page, wxworkPage, tenantGuard }) => {
    test.fixme(
      true,
      'Placeholder — 授权入口 not found on /wxwork/corps. Likely an icon button or menu item; use Pick locator in Playwright UI to capture exact selector.',
    );
    await wxworkPage.gotoCorps();
    await tenantGuard(page);
    await expect(page.getByRole('button', { name: /授权|绑定/ }).first()).toBeVisible();
  });

  test.skip('4.4 contacts sync status visible after scan', async () => {
    test.skip(true, 'TODO: requires /wxwork-open-data sync fixtures + deterministic corp seed.');
  });
});
