/**
 * 衍生 playwright 配置：供桌面端「立即试跑录制」入口使用。
 *
 * 与 playwright.config.ts 的区别：
 *   1. testDir 由环境变量 E2E_SPEC_DIR 动态决定（默认项目根）。这样原始录制
 *      产物（放在 recordings/ 或任意用户目录）也能直接被 playwright 找到并运行。
 *   2. 只启用 chromium project — 跳过 setup project 对 storageState 的依赖，
 *      录制产物不保证经过 tenantGuard 规范化。如果要正式回归，请用 `pnpm import`
 *      转到 tests/recorded/ 再跑 `pnpm test:recorded`。
 *   3. 当被运行的 spec 含登录行为，自动清空 storageState 并跳过 globalSetup ——
 *      避免预登录态污染登录流程测试。三层判断（任意一层命中即生效）：
 *        a. 环境变量 `E2E_FORCE_ANON=1` —— 桌面端 UI 在自己已经检测到登录后
 *           设置，作为最可靠的硬覆盖通道，不依赖任何回扫。
 *        b. detect-login.ts 启发式扫描 process.argv 的 spec 文件。
 *        c. 退路：扫描 E2E_SPEC_DIR。
 *      在 spec 中加 `// @keep-auth` 可强制保留登录态。
 *
 * 仍然继承 baseURL / locale 等 use 配置。
 */
import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';
import { detectLoginSpec } from './scripts/detect-login';

const SPEC_DIR = process.env.E2E_SPEC_DIR ?? '.';
// 桌面端"带窗口跑"会设置这个 env，保证录制回放能看到；兼容 CLI `--headed`
const HEADED = process.env.E2E_SPEC_HEADED === '1';
const FORCE_ANON = process.env.E2E_FORCE_ANON === '1';

const loginSpec = FORCE_ANON ? null : detectLoginSpec(SPEC_DIR);
const useEmptyAuth = FORCE_ANON || loginSpec !== null;

// 一律打日志，便于调试 —— 用户跑的时候看 stdout 就能确认实际生效的策略
// eslint-disable-next-line no-console
console.log(
  `[any-config] useEmptyAuth=${useEmptyAuth} FORCE_ANON=${FORCE_ANON} loginSpec=${loginSpec ?? 'null'} ` +
    `SPEC_DIR=${SPEC_DIR} cwd=${process.cwd()}`,
);
if (useEmptyAuth) {
  // eslint-disable-next-line no-console
  console.log(
    '[any-config] 已清空 storageState 并跳过 globalSetup。在 spec 中加 `// @keep-auth` 可强制保留登录态。',
  );
}

export default defineConfig({
  ...base,
  testDir: SPEC_DIR,
  globalSetup: useEmptyAuth ? undefined : base.globalSetup,
  // 顶层 use 也覆盖一遍 —— 防止 base.use.storageState 因为合并顺序泄漏到 project。
  use: {
    ...base.use,
    ...(useEmptyAuth ? { storageState: { cookies: [], origins: [] } } : {}),
  },
  projects: [
    {
      name: 'chromium-record-playback',
      use: {
        ...devices['Desktop Chrome'],
        storageState: useEmptyAuth ? { cookies: [], origins: [] } : '.auth/admin.json',
        headless: !HEADED,
        // 带窗口时 slow 一点让人看清楚
        launchOptions: HEADED ? { slowMo: 250 } : {},
      },
    },
  ],
  retries: 0,
  reporter: [['list']],
});
