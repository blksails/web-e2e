import { test, expect } from '../../fixtures/base';

test('@smoke @sop0 console loads with tenant guard', async ({ page, tenantGuard }) => {
  await page.goto('/');
  // Accept any console landing route — we only care the user is past /login and on tenant 1.
  await expect(page).not.toHaveURL(/\/login/);
  await tenantGuard(page);
});
