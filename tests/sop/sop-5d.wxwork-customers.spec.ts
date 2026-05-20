import { test, expect } from '../../fixtures/base';

/**
 * SOP-5.5 — 客户列表 (customers) — filters, search, group filter.
 */
test.describe('@sop5 wxwork customers', () => {
  test('5.5.a @smoke customers list loads', async ({ page, wxworkPage, tenantGuard }) => {
    await wxworkPage.gotoCustomers();
    await tenantGuard(page);
    await expect(page).toHaveURL(/\/wxwork\/customers/);
  });

  test.fixme('5.5.b search input present', async ({ page, wxworkPage, tenantGuard }) => {
    test.fixme(true, 'Placeholder — /wxwork/customers search input placeholder text needs staging capture.');
    await wxworkPage.gotoCustomers();
    await tenantGuard(page);
    await expect(page.getByPlaceholder(/搜索|search/i).first()).toBeVisible();
  });

  test.skip('5.5.c 分组筛选 (tree multi-select) narrows rows', async () => {
    test.skip(true, 'TODO: depends on W-16 group feature + deterministic customer seed.');
  });
});
