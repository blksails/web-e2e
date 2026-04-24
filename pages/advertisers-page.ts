import { BasePage } from './base-page';

export type Platform = 'gdt' | 'ocean';

export class AdvertisersPage extends BasePage {
  async gotoList(platform: Platform): Promise<void> {
    await super.goto(`/advertiser/${platform}`);
  }

  async startOAuth(platform: Platform): Promise<void> {
    await this.gotoList(platform);
    await this.page.getByRole('button', { name: /授权|绑定/ }).first().click();
  }

  async countAuthorizedAccounts(platform: Platform): Promise<number> {
    await this.gotoList(platform);
    return this.page.getByRole('row').filter({ hasNot: this.page.locator('thead tr') }).count();
  }

  async hasAccountRow(platform: Platform, accountId: string): Promise<boolean> {
    await this.gotoList(platform);
    return this.page.getByRole('row', { name: accountId }).isVisible();
  }
}
