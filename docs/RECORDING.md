# 测试人员录制流程

目标：把测试人员的手工点击转化为稳定、可回归、可 CI 执行的 Playwright 用例。

---

## 零、前置

- 已经按 `apps/web-e2e/README.md` 配好 `.env.local`，能本地跑 `pnpm test:smoke` 成功。
- 你要录的操作必须是 **company_id=1 租户** 下真实能做的。

## 一、开始录制

```bash
cd apps/web-e2e
pnpm record -- --name 新建分组 --path /groups
```

- `--name` 任意中文名，会转成文件名
- `--path` 是录制起点，省略则从 `/` 开始。登录态已在 `.auth/admin.json` 中，浏览器直接是已登录状态，**不要再去登录页**。

会弹出 Playwright Inspector 和一个 Chromium 窗口。在 Chromium 里按测试用例正常操作。

## 二、录制技巧

- 做的每一步，都尽量通过**可见的 UI 元素**（按钮名、输入框标签）操作，少用纯 class 选择器——代码生成器会自动偏好 `getByRole`、`getByLabel`，这类选择器最稳定。
- 断言放在 Inspector 的 **"Assert visibility / Assert value"** 工具里点一下：
  - 新建成功 → 选中提示 toast，点 Assert visibility。
  - 跳转成功 → 选中面包屑新节点，点 Assert visibility。
  - 列表出现 → 选中新增行，点 Assert visibility。
- 关键节点都应该有断言；光是操作流没断言 ≈ 只是"看起来点过了"。

## 三、结束录制

直接关闭 Inspector 和 Chromium 窗口。录制产物在：

```
recordings/新建分组-2026-04-23T....spec.ts
```

## 四、导入到项目

```bash
pnpm import -- --file "recordings/新建分组-2026-04-23T...spec.ts" --sop sop5
```

这一步会：

- 把绝对 URL 改成相对（配合 baseURL）
- 把 `@playwright/test` 的 import 换成项目 fixtures，引入 `tenantGuard`
- 加上 `@recorded` 和 `@sop5` 标签
- 在 `page.waitForTimeout` 上打 TODO 标记（睡眠等待是 flake 源头，必须替换）
- 输出到 `tests/recorded/xxx.recorded.spec.ts`

## 五、人工清理

打开导入后的文件，做三件事：

1. **替换 `waitForTimeout`**：用 `expect.poll`、`locator.waitFor({ state: 'visible' })`、或者对网络请求 `page.waitForResponse(...)`。
2. **检查硬编码数据**：测试人员录制时可能用了 `测试销售组-20260423`。换成 `` `e2e-sales-${Date.now()}` `` 这类带 `e2e-` 前缀且带时间戳的动态值，避免并发撞车。
3. **把反复出现的选择器提到 POM**：如果 `wxwork/sales-groups` 的某些按钮被第二个录制用到了，抽到 `pages/wxwork-page.ts` 的方法里。

## 六、跑一遍验证

```bash
pnpm test tests/recorded/新建分组-xxx.recorded.spec.ts --headed
```

- 第一次跑顺了，把它 `git add tests/recorded/` 提交。
- 不顺：看失败截图、视频、trace（在 `test-results/` 下），定位到底是脚本问题还是真 bug。

## 七、提升到正式 SOP

录制来的是"某个人当时这样点过"，如果稳定了、有代表性，建议：

1. 移动到 `tests/sop/sop-X.xxx.spec.ts`
2. 去掉 `@recorded` 标签
3. 补充负向路径（权限不足、字段为空、重复名称等）
4. 进 PR review 流程

这样一条路径就从"录制 artefact"升级成"团队维护的回归用例"。

## 常见问题

**Q: 录制时浏览器提示未登录？**
A: `.auth/admin.json` 过期或缺失。跑 `pnpm test -- --project=setup` 重建一次，或临时 `rm .auth/admin.json` 后让 `pnpm test` 触发 `global-setup` 重生。

**Q: 我录的是破坏性操作，怕把生产数据搞坏？**
A: 不可能。`fixtures/base.ts` 的 `tenantGuard` 会在任何写入前把当前租户 ID 读出来，不等于 1 就 hard fail。另外 `E2E_BASE_URL` 默认就是 staging，不是生产。

**Q: 录了一半想暂停？**
A: Inspector 右上角有暂停按钮；或者直接关窗口先保留半成品，下次再手工补。
