# 覆盖率策略

## 我们追踪什么

E2E 套件对"覆盖率"的定义与单测不同，分两层：

### 1. 功能覆盖（SOP matrix） ✅

`reports/index.html` 里的 **SOP coverage** 表格。数据源：
- `company-docs/specs/testing/blksails-e2e/tasks.md` 中每个 `- [ ] x.y ...` 条目
- `tests/**/*.spec.ts` 里以 `@sopN` 标签或 `x.y` 为前缀标题的用例

每跑一次 `pnpm test` 都会刷新。PR smoke 里也会展示。

### 2. 代码行覆盖（Istanbul，可选） ⚠️

Playwright 对远程服务器做 E2E，本身拿不到被测应用的行级覆盖率——除非应用跑的是
**instrumented build**。对我们来说：

| 场景 | 是否能拿行覆盖率 |
|------|----------------|
| 跑本地 `pnpm dev`（测试环境） | 是，通过 babel-plugin-istanbul + `window.__coverage__` |
| 跑 `web-beta.apps.blksails.cn`（共享 staging） | 否，staging 不开启插桩 |
| 生产环境 | 绝对不行 |

结论：**E2E 不承担代码行覆盖率指标**。单测（`vitest`, `apps/web/vitest.config.ts`）负责这个。
如果后续需要合并两者，参考 [`docs/COVERAGE-ISTANBUL.md`](#TODO) 的本地开关方案——默认关闭。

## 为什么不强行搞行覆盖率

1. Staging 是共享环境，插桩会污染其他租户的体验
2. Playwright worker 并行跑时收集 `window.__coverage__` 存在时序竞态，聚合起来噪声大
3. 真正答"功能点是否被 E2E 触达过" 的是 SOP matrix，行覆盖率只是副产物

## 想自建本地行覆盖率怎么办

最小步骤（未来做）：

1. `pnpm add -D babel-plugin-istanbul -w`
2. 在 `apps/web/next.config.mjs` 里挂 `E2E_COVERAGE=1` 分支，启用插桩
3. E2E 新增 fixture，在每个 page 关闭前 `await page.evaluate(() => JSON.stringify(window.__coverage__))` 收集
4. 跑 `E2E_COVERAGE=1 pnpm --filter web dev` + `E2E_BASE_URL=http://localhost:4000 pnpm test`
5. `nyc report --reporter=html --temp-dir coverage-raw`

这套 **本地专属**，不进 CI。
