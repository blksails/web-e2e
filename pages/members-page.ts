import { BasePage } from './base-page';

export interface InvitePayload {
  email: string;
  role: 'admin' | 'member' | 'viewer';
}

/**
 * Company members live under `/companies/[company_id]/...`.
 * For the e2e suite we operate exclusively on company_id=1 (enforced by tenantGuard).
 */
export class MembersPage extends BasePage {
  private readonly companyId: number;

  constructor(page: import('@playwright/test').Page, companyId = Number(process.env.E2E_EXPECTED_COMPANY_ID ?? '1')) {
    super(page);
    this.companyId = companyId;
  }

  async gotoCompanyHome(): Promise<void> {
    await super.goto(`/companies/${this.companyId}`);
  }

  async gotoInviteForm(): Promise<void> {
    await super.goto(`/companies/${this.companyId}/invite`);
  }

  async gotoInvitations(): Promise<void> {
    await super.goto(`/companies/${this.companyId}/invitations`);
  }

  async submitInvite({ email, role }: InvitePayload): Promise<void> {
    await this.page.getByLabel(/邮箱|email/i).fill(email);
    // Role may be a combobox (Radix Select) or radio group — try Select first.
    const roleTrigger = this.page.getByRole('combobox').filter({ hasText: /角色|role/i }).first();
    if (await roleTrigger.isVisible().catch(() => false)) {
      await roleTrigger.click();
      await this.page.getByRole('option', { name: new RegExp(role, 'i') }).click();
    } else {
      await this.page.getByLabel(new RegExp(role, 'i')).check();
    }
    await this.page.getByRole('button', { name: /发送邀请|确认|submit/i }).click();
  }

  async hasInvitationFor(email: string): Promise<boolean> {
    await this.gotoInvitations();
    return this.page.getByRole('row', { name: new RegExp(email, 'i') }).isVisible();
  }

  async hasMember(email: string): Promise<boolean> {
    await this.gotoCompanyHome();
    return this.page.getByText(new RegExp(email, 'i')).isVisible();
  }
}
