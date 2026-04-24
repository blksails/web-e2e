# BlackSail webapp — E2E (Playwright)

端对端回归 + 测试人员录制 + 自动化报告。目标环境默认锁定
`https://web-beta.apps.blksails.cn`，`company_id=1`。

> 详见 SOP 任务清单：`company-docs/specs/testing/blksails-e2e/tasks.md`

---

## 快速开始

```bash
cd apps/web-e2e

# 1. 安装依赖
pnpm install
pnpm install-browsers

# 2. 配置环境变量（一次性）
cp .env.example .env.local
# 编辑 .env.local，填入 E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD (company_id=1 管理员)

# 3. 跑全量
pnpm test

# 4. 查看报告
pnpm report:dashboard && start reports/index.html       # Windows
pnpm report:dashboard && open  reports/index.html       # macOS
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm test` | 全量跑当前机器能跑的 projects |
| `pnpm test:smoke` | 只跑 `@smoke` 标签（PR 用） |
| `pnpm test:sop` | 只跑 `tests/sop/` |
| `pnpm test:recorded` | 只跑测试人员录制后导入的用例 |
| `pnpm test:ui` | Playwright UI Mode（交互调试） |
| `pnpm test:headed` | 带浏览器跑 |
| `pnpm record -- --name my-flow --path /settings/members` | 启动 codegen，已登录状态开始录制 |
| `pnpm import -- --file recordings/xxx.spec.ts --sop sop5` | 把录制结果规范化到 `tests/recorded/` |
| `pnpm report:dashboard` | 生成 `reports/index.html` 综合报告 |
| `pnpm report` | 打开 Playwright 原生 HTML 报告 |

## 目录约定

```
apps/web-e2e/
├── playwright.config.ts     # 入口配置（baseURL / reporters / projects）
├── global-setup.ts          # 启动一次性登录，写 .auth/admin.json
├── fixtures/base.ts         # BlackSail fixtures（POM + tenantGuard）
├── pages/                   # Page Object Models，按业务模块拆
├── scripts/                 # 工具脚本：录制、导入、报告
├── reporters/               # 自定义 reporter（建议 / 耗时分析）
├── tests/
│   ├── smoke/               # PR 快速冒烟
│   ├── sop/                 # 业务 SOP 回归（sop-1..5）
│   └── recorded/            # 测试人员录制后导入的用例（@recorded）
├── recordings/              # codegen 原始产物（gitignored）
├── reports/                 # 跑完后产出（gitignored）
└── .auth/                   # storageState（gitignored）
```

## 用例标签

| 标签 | 含义 |
|------|------|
| `@smoke` | PR 必跑，必须 < 5 min |
| `@sop1` … `@sop5` | 对应 SOP 分组 |
| `@recorded` | 由测试人员通过 codegen 录制导入 |
| `@flaky` | 已知不稳定，隔离运行，不阻塞主流程 |

## 多租户安全红线

**本套件默认只允许在 `company_id=1` 下执行任何写入操作。**
所有破坏性用例必须先通过 `tenantGuard` fixture：

```ts
import { test, expect } from '../../fixtures/base';

test('@sop2 invite member', async ({ page, tenantGuard, membersPage }) => {
  await membersPage.goto();
  await tenantGuard(page);           // 必须在写入前调用
  await membersPage.openInviteDialog();
  // ...
});
```

`tenantGuard` 会读取 cookie / localStorage / data-company-id，任何一个落到不是 1 的租户就会直接 fail，
防止误连生产或他人租户。

## 测试人员录制流程

详见 [`docs/RECORDING.md`](./docs/RECORDING.md)。

## 桌面端（图形化控制台）

测试专员可直接双击 `.msi` / `.dmg` / `.AppImage` 安装使用，无需命令行。
首次打开会自动弹出「一键准备测试环境」向导，把 Playwright 浏览器装好。详见
[`docs/DESKTOP-APP.md`](./docs/DESKTOP-APP.md)。

开发者本地：

```bash
pnpm install        # 自动带 playwright install chromium（postinstall 钩子）
pnpm desktop        # 开发模式启动
pnpm desktop:build  # 打包分发
```

## CI

- PR 触发：`@smoke` 标签，失败阻断合并
- 夜间：全量回归，失败发飞书
- 详见 `.github/workflows/e2e.yml`

## 报告产物

每次跑完后：

| 文件 | 用途 |
|------|------|
| `reports/index.html` | **综合仪表盘**：SOP 覆盖率 / 耗时 / 建议 |
| `reports/playwright-html/index.html` | 官方 HTML，点进失败用例看 trace |
| `reports/playwright.json` | 机器可读，供 CI 消费 |
| `reports/suggestions.json` \| `suggestions.md` | 建议与代码异味（慢步骤 / waitForTimeout / 重试） |
| `reports/junit.xml` | 给 GitHub Actions 测试汇总 |
| `test-results/` | 失败时的 trace / video / screenshot |
