import { test, expect } from '../../fixtures/base';

/**
 * SOP-2 — 邀请成员
 *
 * Targets /companies/[company_id]/invite. All writes are guarded to company_id=1 and use
 * e2e- prefixed emails so staging cleanup scripts can purge them by prefix.
 */
test.describe('@sop2 invite member', () => {
  test('2.1 @smoke invite page renders', async ({ page, membersPage, tenantGuard }) => {
    await membersPage.gotoInviteForm();
    await tenantGuard(page);
    await expect(page.getByRole('heading', { name: /邀请|invite/i })).toBeVisible();
  });

  test.skip('2.2 creates invitation record', async () => {
    // Placeholder selectors (getByLabel('role')) don't match the real invite form on staging —
    // role is likely a segmented control or radio group, not a labeled input. Un-skip once we've
    // inspected the form in Playwright UI (or recorded it via `pnpm record`) and updated the POM.
    test.skip(true, 'SOP-2 invite-form POM needs real selectors from staging — use pnpm record to capture.');
  });

  test.skip('2.5 @sop2 blocks duplicate invite', async () => {
    test.skip(true, 'Depends on 2.2 positive path selectors — see above.');
  });

  test.skip('2.3 invitee accepts link and joins company', async () => {
    test.skip(
      !process.env.E2E_MEMBER_EMAIL,
      'Enable once E2E_MEMBER_EMAIL is populated and invite-link retrieval is wired (needs mailbox stub or DB read).',
    );
  });

  test.skip('2.6 remove member / change role reverse flow', async () => {
    test.skip(true, 'TODO: implement once invitee-acceptance test (2.3) is stable.');
  });
});
