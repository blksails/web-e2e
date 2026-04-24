# 工程师操作手册 — BlackSail E2E（Playwright）

面向维护 `apps/web-e2e` 的后端/全栈工程师。目标：5 分钟内能本地跑一遍回归，30 分钟内能加一条新 SOP 用例并合入。

---

## 1. 这套东西是什么

一个独立的 pnpm workspace：`apps/web-e2e/`。包含：

- **Playwright 回归用例**：按业务 SOP 分组的 spec（`tests/sop/**`）
- **冒烟子集**：PR 触发用（`@smoke` 标签）
- **测试人员录制导入机制**：codegen 录制 → 脚本规范化 → 纳入 `tests/recorded/`
- **自定义报告**：SOP 覆盖率矩阵、慢步骤、flaky 检测、趋势图（`reports/index.html`）
- **CI 工作流**：PR 跑冒烟、夜间跑全量、部署后发飞书告警

默认目标环境是 **web-beta 测试环境** (`https://web-beta.apps.blksails.cn`)，且**仅对 `company_id=1` 的租户做破坏性操作**——由 `tenantGuard` fixture 强制。

---

## 2. 本地 5 分钟上手

```bash
cd C:/workcode/webapp

# 一次性：安装依赖 + 浏览器
make install
make e2e-install

# 一次性：填测试账号（已经 gitignore，不会提交）
cp apps/web-e2e/.env.example apps/web-e2e/.env.local
# 编辑 apps/web-e2e/.env.local：
#   E2E_ADMIN_EMAIL=<company_id=1 的管理员邮箱>
#   E2E_ADMIN_PASSWORD=<对应密码>

# 跑冒烟（约 1 分钟）
make e2e-smoke

# 生成综合报告
make e2e-report
# 浏览器打开 apps/web-e2e/reports/index.html
```

如果冒烟过了，跑全量：

```bash
make e2e           # 全量 ≈ 1 分钟
make e2e-sop       # 只跑 tests/sop
```

---

## 3. 目录导览

```
apps/web-e2e/
├── playwright.config.ts      # 入口：baseURL、reporters、projects
├── global-setup.ts           # 一次性登录，写 .auth/admin.json
├── fixtures/
│   ├── base.ts               # POM + tenantGuard 核心
│   └── a11y.ts               # axe-core 封装
├── pages/                    # 业务 POM（按模块拆）
├── tests/
│   ├── smoke/                # PR 冒烟
│   ├── sop/                  # 业务回归（sop-1..5）
│   └── recorded/             # 测试人员录制后导入的用例
├── reporters/
│   └── suggestion-reporter.ts  # 自定义 reporter：生成 suggestions.json + trends.jsonl
├── scripts/
│   ├── record.ts             # `pnpm record` 入口：启动 codegen
│   ├── import-recording.ts   # `pnpm import` 入口：把录制规范化
│   ├── generate-report.ts    # 综合报告生成
│   ├── preflight.ts          # 测试前自检：防 .only、sleep、绝对 URL
│   └── __tests__/            # node:test 单测（pnpm test:unit）
├── docs/
│   ├── ENGINEER-GUIDE.md     # 当前文件
│   ├── TESTER-RECORDING-GUIDE.md
│   ├── RECORDING.md
│   └── COVERAGE.md
├── reports/                  # 跑完后产出（gitignored）
└── recordings/               # codegen 原始产物（gitignored）
```

---

## 4. 核心概念

### 4.1 tenantGuard — 多租户安全红线

在任何对后端有写入的用例里，**破坏性操作之前必须调用 `tenantGuard(page)`**：

```ts
import { test, expect } from '../../fixtures/base'

test('@sop2 invite member', async ({ page, tenantGuard, membersPage }) => {
  await membersPage.gotoInviteForm()
  await tenantGuard(page)   // 必须在写入前
  await membersPage.submitInvite({ email: `e2e-${Date.now()}@blksails.test`, role: 'member' })
})
```

`tenantGuard` 做两件事：

1. 校验 `E2E_BASE_URL` 主机名不是生产——host 里必须包含 `beta` / `staging` / `dev` / `test` 之一。
2. 校验浏览器上下文里存在有效的 Supabase auth cookie（`sb-*-auth-token`）。

它**不**从 cookie/localStorage 读取 `company_id`——BlackSail 把 tenant 存在 Supabase 的 `profiles` 表里，前端状态只在内存的 Zustand store 中。"账号属于哪个 company_id" 是 `.env.local` 的契约：`E2E_ADMIN_EMAIL` 对应的账号**必须**是 `company_id=1` 的管理员。如果你换了账号但没换 `E2E_EXPECTED_COMPANY_ID`，就是你自己的 bug。

### 4.2 Page Object Model (POM)

**用例里不写选择器**，全部通过 POM：

```ts
// ❌ 不要这样
await page.locator('[data-slot="button"][name="invite"]').click()

// ✅ 这样
await membersPage.openInviteDialog()
```

POM 在 `pages/*.ts`。新加业务模块时创建新的 POM 文件，继承 `BasePage`：

```ts
// pages/my-module-page.ts
import { BasePage } from './base-page'

export class MyModulePage extends BasePage {
  async gotoList() {
    await super.goto('/my-module')
  }
  async createSomething(name: string) {
    await this.page.getByRole('button', { name: /新建/ }).click()
    await this.page.getByLabel('名称').fill(name)
    await this.page.getByRole('button', { name: '确认' }).click()
  }
}
```

然后注册到 `fixtures/base.ts`：

```ts
export interface BlackSailFixtures {
  // ...
  myModulePage: MyModulePage
}

export const test = base.extend<BlackSailFixtures>({
  // ...
  myModulePage: async ({ page }, use) => { await use(new MyModulePage(page)) },
})
```

### 4.3 标签 (Tag) 体系

| 标签 | 含义 | 用途 |
|------|------|------|
| `@smoke` | PR 必跑，单个 < 5s | 核心链路冒烟 |
| `@sop1`…`@sop5` | 按 SOP 分组 | 对应 `tasks.md` 中的业务分组 |
| `@recorded` | 测试人员通过 codegen 录制导入 | 运行稳定后提升到 `tests/sop/` |
| `@flaky` | 已知不稳定 | 隔离运行，不阻塞主流程 |
| `@a11y` | 无障碍检查 | 跑 axe-core |

标签可以放在 `describe()` 标题或单个 `test()` 标题里，suggestion-reporter 扫整条 titlePath。

### 4.4 选择器优先级

稳定到不稳定：

1. `getByRole(role, { name })` — 首选，语义稳定
2. `getByLabel(text, { exact: true })` — 对 form 字段好用，**注意 `exact: true`**（label 文本和 placeholder 有时会撞车）
3. `getByText(text)` — 非表单 UI 文案，容易变
4. `getByTestId(id)` — 需要组件加 `data-testid`，最稳但最 intrusive
5. `page.locator(css)` — 最后手段，最脆

**常见坑**：BlackSail 的登录页有 `<input placeholder="邮箱@example.com">`，`getByLabel('邮箱')` 会同时匹配 label 和 placeholder 触发 strict-mode 违例。改用 `getByRole('textbox', { name: '邮箱' })`。

---

## 5. 工作流

### 5.1 加一条 SOP 用例

1. 在 `company-docs/specs/testing/blksails-e2e/tasks.md` 里确认 SOP 条目（`- [ ] x.y 描述`）
2. 找到对应 `tests/sop/sop-N*.spec.ts`
3. 新增 `test()`：

```ts
test('5.2.c 绑定接待人员 @sop5', async ({ page, wxworkPage, tenantGuard }) => {
  await wxworkPage.gotoKfAccounts()
  await tenantGuard(page)
  // ... 用 POM 方法驱动
  await wxworkPage.bindReceptionist('kf-account-1', 'e2e-user-1')
  await expect(page.getByRole('row', { name: 'e2e-user-1' })).toBeVisible()
})
```

4. 本地跑单条：
   ```bash
   pnpm --filter web-e2e exec playwright test -g "5.2.c"
   ```
5. 加 / 扩展 POM 方法（如需）
6. `pnpm --filter web-e2e lint && pnpm --filter web-e2e typecheck` 确保干净
7. `git commit`

### 5.2 跟进测试人员的录制

流程参见 `docs/TESTER-RECORDING-GUIDE.md`。你要做的是：

1. 测试人员在 `tests/recorded/` 提 PR
2. code review：检查有没有 `waitForTimeout`、硬编码测试数据、没进 POM 的重复选择器
3. 跑稳定后，把它从 `tests/recorded/` 提升到 `tests/sop/`，去掉 `@recorded` 标签，补负向路径
4. 把重复选择器抽进对应 POM

### 5.3 故障排查

**测试失败怎么看**：

1. CI：下载 artifact `e2e-smoke-report` 或 `e2e-full-report`
2. 本地：`test-results/<test-dir>/` 下有 screenshot、video、trace.zip
3. 打开 trace：`pnpm --filter web-e2e exec playwright show-trace <trace.zip>` 或 UI 模式

**Flaky 用例处理**：

- 第一步：先确认是业务 bug 还是用例问题——用 trace 逐步回放
- 如果是用例问题：用 `expect.poll` / `locator.waitFor` 替代 `waitForTimeout`
- 如果短期内修不好：加 `@flaky` 标签或 `test.fixme(true, '原因')`，**不要** `test.skip(true)` 裸跳过

**登录态失效**：

```bash
rm apps/web-e2e/.auth/admin.json
# 下一次跑 global-setup 会重新登录
```

---

## 6. CI 机制

见 `.github/workflows/e2e.yml`：

- **PR 触发**：只跑 `@smoke` 标签，< 5 min，失败阻断合并
- **夜间**：02:00 UTC 全量回归，失败发飞书
- **Artifact**：HTML 报告 + trace + video，retention 14/30 天

需要的 GitHub Secrets：

| Secret | 说明 |
|--------|------|
| `E2E_BASE_URL` | 目标环境 URL，默认 web-beta |
| `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` | `company_id=1` 管理员 |
| `E2E_MEMBER_EMAIL` / `E2E_MEMBER_PASSWORD` | 邀请流程用（可选） |
| `FEISHU_WEBHOOK_URL` | 夜间失败告警（可选） |

---

## 7. 常用命令速查

```bash
make e2e                 # 全量
make e2e-smoke           # @smoke only
make e2e-sop             # 只跑 tests/sop
make e2e-ui              # Playwright UI 模式（交互调试）
make e2e-record name=xxx path=/foo   # 录制新用例
make e2e-import file=recordings/xxx.spec.ts sop=sop5   # 规范化录制
make e2e-report          # 生成综合 HTML 报告
make e2e-typecheck       # tsc --noEmit
make e2e-unit            # node:test 跑 scripts 单测

# 直接 pnpm 方式
pnpm --filter web-e2e test -g "5.2"   # 按标题 grep 跑
pnpm --filter web-e2e test --headed   # 带 UI
pnpm --filter web-e2e test --debug    # 单步调试
```

---

## 8. 最佳实践清单

在提 PR 前自检：

- [ ] 新增/改动的 spec 里没有 `test.only` 或 `describe.only`（`preflight` 会挡，但最好自己先看）
- [ ] 没有 `page.waitForTimeout(...)`（preflight 会挡）
- [ ] 没有硬编码 `https://web-beta.apps.blksails.cn`（preflight 会挡）
- [ ] 破坏性用例都调用了 `tenantGuard`
- [ ] 测试数据用 `e2e-` 前缀 + 时间戳（`` `e2e-foo-${Date.now()}` ``）
- [ ] 选择器通过 `getByRole` / `getByLabel`，不是裸 CSS
- [ ] 新的 POM 方法加了类型，不在用例里拼 selector 字符串
- [ ] `pnpm --filter web-e2e lint && pnpm --filter web-e2e typecheck && pnpm --filter web-e2e test:unit` 全绿
- [ ] 跑过一次本地 `make e2e-smoke` 没有新 fail

---

## 9. 进阶：扩展 tenantGuard 或 POM 基类

要改 `tenantGuard` 的实际检查逻辑（例如接入真正的 company_id 查询）：

```ts
// fixtures/base.ts
tenantGuard: async ({}, use, testInfo) => {
  await use(async (page) => {
    // 新方案：从 /api/me 拿 profile
    const profile = await page.evaluate(async () => {
      const res = await fetch('/api/me', { credentials: 'include' })
      return res.ok ? (await res.json()) as { company_id: number } : null
    })
    expect(profile?.company_id, `Expected company_id=1, got ${profile?.company_id}`).toBe(1)
  })
}
```

注意改完要同步更新 `docs/COVERAGE.md` 里对 guard 的描述。

要给 POM 基类加一个共用的 toast 断言器：

```ts
// pages/base-page.ts
async expectToast(message: string | RegExp, timeout = 5_000) {
  await expect(this.page.getByRole('status').filter({ hasText: message }).first())
    .toBeVisible({ timeout })
}
```

然后所有 POM 子类都能用。

---

## 10. 往哪里看更多

- `docs/TESTER-RECORDING-GUIDE.md` — 交给测试人员的录制指南
- `docs/RECORDING.md` — 录制流程原始版
- `docs/COVERAGE.md` — 覆盖率策略说明
- `company-docs/specs/testing/blksails-e2e/tasks.md` — SOP 任务清单（覆盖矩阵对标源）
- Playwright 官方文档：https://playwright.dev
