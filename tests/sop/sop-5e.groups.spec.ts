import { test, expect } from '../../fixtures/base';

/**
 * SOP-5.7 — 分组管理 (W-16). Top-level /groups.
 */
test.describe('@sop5 groups (W-16)', () => {
  test('5.7.a @smoke groups page loads', async ({ page, wxworkPage, tenantGuard }) => {
    await wxworkPage.gotoGroups();
    await tenantGuard(page);
    await expect(page).toHaveURL(/\/groups/);
  });

  test.skip('5.7.b 新建分组 with parent', async () => {
    test.skip(true, 'TODO: wire once W-16 group create dialog selectors are stable.');
  });

  test.skip('5.7.c 删除非空分组 → 校验阻断', async () => {
    test.skip(true, 'TODO: requires deterministic group tree seed.');
  });
});
