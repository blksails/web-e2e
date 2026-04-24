import { BasePage } from './base-page';

/**
 * WxWork console routes under /wxwork/*. Confirmed from apps/web/app/(console)/wxwork/:
 *   corps/, kf-accounts/, contact-ways/, acquisition-links/, customers/, configs/, agent-signatures/.
 *
 * sales-groups and 分组 (groups) are part of SOP-5 but:
 *   - 分组 lives at top-level /groups (see (console)/groups/), from the W-16 feature.
 *   - sales-groups does not yet have a dedicated route as of 2026-04-23 — we target the
 *     sales-group section inside /wxwork/configs/[config_id] until it lands.
 */
export class WxWorkPage extends BasePage {
  async gotoCorps(): Promise<void> {
    await super.goto('/wxwork/corps');
  }

  async gotoKfAccounts(): Promise<void> {
    await super.goto('/wxwork/kf-accounts');
  }

  async gotoContactWays(): Promise<void> {
    await super.goto('/wxwork/contact-ways');
  }

  async gotoAcquisitionLinks(): Promise<void> {
    await super.goto('/wxwork/acquisition-links');
  }

  async gotoCustomers(): Promise<void> {
    await super.goto('/wxwork/customers');
  }

  async gotoConfigs(): Promise<void> {
    await super.goto('/wxwork/configs');
  }

  /** W-16 分组 feature — top-level /groups, not inside /wxwork. */
  async gotoGroups(): Promise<void> {
    await super.goto('/groups');
  }

  async corpIsAuthorized(corpName: string | RegExp): Promise<boolean> {
    await this.gotoCorps();
    const row = this.page.getByRole('row', { name: corpName });
    return row.getByText(/已授权|authorized/i).isVisible().catch(() => false);
  }

  async countRows(): Promise<number> {
    // header row excluded via role+name heuristics.
    const rows = this.page.getByRole('row');
    return (await rows.count()) - 1;
  }
}
