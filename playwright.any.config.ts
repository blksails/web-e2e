/**
 * 衍生 playwright 配置：供桌面端「立即试跑录制」入口使用。
 *
 * 与 playwright.config.ts 的区别：
 *   1. testDir 由环境变量 E2E_SPEC_DIR 动态决定（默认项目根）。这样原始录制
 *      产物（放在 recordings/ 或任意用户目录）也能直接被 playwright 找到并运行。
 *   2. 只启用 chromium project — 跳过 setup project 对 storageState 的依赖，
 *      录制产物不保证经过 tenantGuard 规范化。如果要正式回归，请用 `pnpm import`
 *      转到 tests/recorded/ 再跑 `pnpm test:recorded`。
 *
 * 仍然继承 baseURL / locale / storageState 等 use 配置，保持登录态。
 */
import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

const SPEC_DIR = process.env.E2E_SPEC_DIR ?? '.';
// 桌面端"带窗口跑"会设置这个 env，保证录制回放能看到；兼容 CLI `--headed`
const HEADED = process.env.E2E_SPEC_HEADED === '1';

export default defineConfig({
  ...base,
  testDir: SPEC_DIR,
  globalSetup: base.globalSetup,
  projects: [
    {
      name: 'chromium-record-playback',
      use: {
        ...devices['Desktop Chrome'],
        storageState: '.auth/admin.json',
        headless: !HEADED,
        // 带窗口时 slow 一点让人看清楚
        launchOptions: HEADED ? { slowMo: 250 } : {},
      },
    },
  ],
  retries: 0,
  reporter: [['list']],
});
