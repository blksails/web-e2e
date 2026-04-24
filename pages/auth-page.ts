import { BasePage } from './base-page';

export class AuthPage extends BasePage {
  async gotoLogin(): Promise<void> {
    await this.goto('/login');
  }

  async loginWithEmail(email: string, password: string): Promise<void> {
    // 邮箱 label text also appears in the placeholder — use role-based locator to avoid
    // Playwright strict-mode violations.
    await this.page.getByRole('textbox', { name: '邮箱' }).fill(email);
    await this.page.getByLabel('密码', { exact: true }).fill(password);
    await this.page.getByRole('button', { name: '登录', exact: true }).click();
    await this.page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  }

  async logout(): Promise<void> {
    // BlackSail console has the user menu in the top-right; adjust once POM for console shell is settled.
    await this.page.getByRole('button', { name: /账户|个人|user/i }).first().click();
    await this.page.getByRole('menuitem', { name: /登出|退出/ }).click();
    await this.page.waitForURL(/\/login/);
  }
}
