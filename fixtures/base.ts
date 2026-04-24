import { test as base, expect, type Page } from '@playwright/test';
import { AuthPage } from '../pages/auth-page';
import { MembersPage } from '../pages/members-page';
import { AdvertisersPage } from '../pages/advertisers-page';
import { WxWorkPage } from '../pages/wxwork-page';

export interface BlackSailFixtures {
  authPage: AuthPage;
  membersPage: MembersPage;
  advertisersPage: AdvertisersPage;
  wxworkPage: WxWorkPage;
  tenantGuard: (page: Page) => Promise<void>;
}

const EXPECTED_COMPANY_ID = Number(process.env.E2E_EXPECTED_COMPANY_ID ?? '1');

export const test = base.extend<BlackSailFixtures>({
  authPage: async ({ page }, use) => {
    await use(new AuthPage(page));
  },
  membersPage: async ({ page }, use) => {
    await use(new MembersPage(page));
  },
  advertisersPage: async ({ page }, use) => {
    await use(new AdvertisersPage(page));
  },
  wxworkPage: async ({ page }, use) => {
    await use(new WxWorkPage(page));
  },
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture API requires object destructuring even when no fixtures are needed.
  tenantGuard: async ({}, use, testInfo) => {
    await use(async (page: Page) => {
      // BlackSail resolves active tenant from the authed Supabase user's profile (not a cookie
      // or localStorage key). Probing the browser state for company_id is unreliable; instead
      // we enforce two guarantees that together give us the same safety:
      //   1. The E2E_BASE_URL must look like a non-production host (staging / beta / localhost).
      //   2. A Supabase auth session exists (user is logged in, so we're acting as the declared
      //      admin account — by .env.local contract that account belongs to company_id=1).
      // The correspondence between credentials and company_id is a property of .env.local; if
      // you point the suite at the wrong account, the wrong-tenant problem is upstream.
      const baseUrl = process.env.E2E_BASE_URL ?? '';
      const host = safeHost(baseUrl);
      const productionHost = /\.apps\.blksails\.cn$/.test(host) && !/(^|[^a-z])(beta|staging|dev|test)/.test(host);
      expect(
        productionHost,
        `Refusing to run against apparent production host "${host}". E2E_BASE_URL must be a staging/beta/dev URL.`,
      ).toBe(false);

      const cookies = await page.context().cookies();
      const authed = cookies.some((c) => /^sb-.*-auth-token/.test(c.name) && c.value.length > 20);
      expect(
        authed,
        'No Supabase auth cookie present — storageState is empty. Check E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD in .env.local and that global-setup ran.',
      ).toBe(true);

      // Log the declared tenant so traces/reports capture it for audit.
      testInfo.annotations.push({ type: 'tenant', description: `company_id=${EXPECTED_COMPANY_ID} (declared)` });
    });
  },
});

export { expect };

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
