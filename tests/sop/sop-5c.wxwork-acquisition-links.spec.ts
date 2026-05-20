import { test, expect } from '../../fixtures/base';

/**
 * SOP-5.4 — 获客链接 (acquisition-links)
 */
test.describe('@sop5 wxwork acquisition-links', () => {
  test('5.4.a @smoke acquisition-links list loads', async ({ page, wxworkPage, tenantGuard }) => {
    await wxworkPage.gotoAcquisitionLinks();
    await tenantGuard(page);
    await expect(page).toHaveURL(/\/wxwork\/acquisition-links/);
  });

  test.skip('5.4.b 新建链接 → 启用/停用 切换', async () => {
    test.skip(true, 'TODO: pre-seed link and toggle 启用/停用, assert badge color + list refresh.');
  });
});
