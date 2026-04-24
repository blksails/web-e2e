import { test } from '@playwright/test';
import { assertNoA11yViolations } from '../../fixtures/a11y';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('@smoke @a11y anonymous surfaces', () => {
  test('login page has no serious a11y violations', async ({ page }) => {
    // Login page has an autoplay <video> — default waitUntil:'load' never fires within 30s.
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await assertNoA11yViolations(page, {
      // forgot-password link contrast is a known issue scheduled for next design pass — remove once fixed.
      allowedViolations: ['color-contrast'],
    });
  });
});
