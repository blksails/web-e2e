import type { Page, Locator } from '@playwright/test';

export abstract class BasePage {
  constructor(protected readonly page: Page) {}

  async goto(path: string): Promise<void> {
    await this.page.goto(path, { waitUntil: 'domcontentloaded' });
  }

  getByText(text: string | RegExp): Locator {
    return this.page.getByText(text);
  }

  async waitForToast(message: string | RegExp): Promise<void> {
    // BlackSail uses `sonner` for toasts (see apps/web dependencies).
    await this.page.getByRole('status').filter({ hasText: message }).first().waitFor({ state: 'visible' });
  }

  /**
   * Wait for BlackSail's "加载中..." loading indicators to go away. Many console pages show
   * this text while fetching from Supabase; asserting content before it clears is a common
   * flake cause.
   */
  async waitForLoaded(timeout = 20_000): Promise<void> {
    const loading = this.page.getByText(/^加载中\.\.\.?$/);
    // If nothing matches in the first 500ms we assume it already loaded.
    if ((await loading.count()) === 0) return;
    await loading.first().waitFor({ state: 'hidden', timeout }).catch(() => void 0);
  }

  async dismissToasts(): Promise<void> {
    const toasts = this.page.getByRole('status');
    const count = await toasts.count();
    for (let i = 0; i < count; i++) {
      await toasts.nth(i).click({ trial: true }).catch(() => void 0);
    }
  }
}
