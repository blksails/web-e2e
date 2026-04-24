# 测试专员录制手册 — BlackSail E2E

面向测试专员 / QA。你不需要写代码。你只要会点击页面、懂业务流程，就能把一条测试流程"拍下来"变成可回归的自动化用例。

---

## 1. 这手册讲什么

教你用 Playwright 的录制功能（codegen）把一段手工操作转化成自动化测试。目标受众：**不写 JS/TS 的测试人员**。

你需要会：
- 用命令行（能输 `cd`、`pnpm xxx`）
- 知道要测的业务流程（例如"管理员怎么邀请成员"）
- 用 Chrome 的点击、填表、跳转

你不需要会：
- 写 Playwright API
- 改 TypeScript
- 处理 Git（交给开发）

---

## 2. 一次性准备（每台电脑只做一次）

问开发要这些东西：

1. 代码仓库已经 clone 到本地（路径形如 `C:\workcode\webapp`）
2. Node.js 22.x 和 pnpm 10+ 已装
3. **测试账号**：`company_id=1` 的管理员邮箱 + 密码——这个账号**只用于测试环境**，不是你自己的生产账号

然后：

```bash
cd C:\workcode\webapp

# 装依赖（一次就够）
pnpm install
pnpm --filter web-e2e install-browsers
```

**配置账号**（只在这台机上改一次）：

```bash
cd apps/web-e2e
copy .env.example .env.local      # Windows PowerShell: Copy-Item
```

用编辑器打开 `apps/web-e2e/.env.local`，填：

```
E2E_ADMIN_EMAIL=你拿到的测试管理员邮箱
E2E_ADMIN_PASSWORD=密码
```

保存。**不要把这个文件提交到 git**——它已经在 `.gitignore` 里了，放心。

**验证环境好了：**

```bash
cd C:/workcode/webapp
make e2e-smoke
```

看到 "X passed" 且没有 "failed" 就说明环境 OK。如果失败，截图找开发。

---

## 3. 录制流程（核心）

### 第一步：想清楚你要录什么

- 一次录制 = 一个测试用例 = 一条业务流程
- 流程要小而聚焦。比如"新建一个销售组"是一条。"新建销售组 + 邀请成员 + 配置接待 + 看客户"就太长了，拆开。
- 在你脑子里走一遍流程，记下每一步：
  1. 点"销售组"菜单
  2. 点"新建"
  3. 填名称"测试组A"
  4. 选成员 xxx、yyy
  5. 点"确认"
  6. 看到列表里出现"测试组A"

### 第二步：启动录制

```bash
cd C:\workcode\webapp

# 起点是 /wxwork/sales-groups 这个页面，录制的名字叫"创建销售组"
make e2e-record name=创建销售组 path=/wxwork/sales-groups
```

会自动弹出两个窗口：

- **左边**：一个已经登录的 Chromium 浏览器（就是日常的测试环境 web-beta）
- **右边**：Playwright Inspector（会实时显示你点过的每一步生成的代码）

### 第三步：在 Chromium 里演示

**关键原则：像给新同事演示一样操作。** 每一步都要走真实的 UI，不要绕。

- **点按钮** → 直接点
- **填输入框** → 点进去、输入内容
- **切换 tab 或下拉** → 点
- **等页面加载** → 正常等，Playwright 会记录加载时机

### 第四步：打断言（关键！）

操作完一步，**最好加一个断言**。断言 = "这里我期望看到什么"。

在 Inspector 右上角的工具里：

| 按钮 | 作用 | 什么时候用 |
|------|------|----------|
| 👁 **Assert visibility** | 断言元素可见 | "新建成功后列表里应该出现这一行" |
| 🟰 **Assert value** | 断言输入框的值 | "填完后输入框的值应该是 xxx" |
| 📝 **Assert text** | 断言某段文本 | "toast 提示应该是'创建成功'" |

点这些按钮，然后**在 Chromium 窗口里点一下你想断言的元素**，Inspector 就会自动生成断言代码。

**没有断言的测试 ≈ 看起来点了一遍但不验证任何事情——等于白录。**

### 第五步：结束录制

直接关掉 Chromium 和 Inspector 两个窗口。

生成的文件在：

```
apps/web-e2e/recordings/创建销售组-2026-04-23T12-30-45.spec.ts
```

### 第六步：导入到项目

```bash
cd C:\workcode\webapp
make e2e-import file=apps/web-e2e/recordings/创建销售组-2026-04-23T12-30-45.spec.ts sop=sop5
```

`sop=sop5` 是给这个用例打的业务分组标签。对照：

| SOP | 对应什么业务 |
|-----|-------------|
| `sop1` | 注册账户 |
| `sop2` | 邀请成员 |
| `sop3` | 广告账户授权（GDT / Ocean） |
| `sop4` | 企业微信授权 |
| `sop5` | 企业微信业务：销售组、客服、获客链接、客户列表、分组等 |

这一步会做：

- 把录制的脚本搬到 `apps/web-e2e/tests/recorded/` 下
- 自动接入项目的 `tenantGuard`（保证不误跑到其他租户）
- 在 `waitForTimeout` 这种"死等"行为上打 TODO 标记，提醒开发替换
- 给用例打上 `@recorded` + `@sop5` 标签

### 第七步：跑一遍验证

```bash
cd C:\workcode\webapp
pnpm --filter web-e2e test tests/recorded/创建销售组-xxx.recorded.spec.ts --headed
```

- `--headed` 表示带可见浏览器跑——你能亲眼看到 Playwright 在重放你的操作
- 如果跑通了 → 继续下一步
- 如果跑不通 → 看下面的"常见问题"

---

## 4. 提交 PR 给开发

录制验证过了：

```bash
cd C:\workcode\webapp
git checkout -b record/sop5-创建销售组
git add apps/web-e2e/tests/recorded/
git commit -m "test(sop5): record 创建销售组 flow"
git push origin record/sop5-创建销售组
```

然后在 GitHub 上开 PR，标题写清楚业务目的。开发会 review：

- 检查选择器是不是会漂（比如纯 CSS class）
- 把重复用到的选择器抽到 POM 里
- 把 `@recorded` 级别的用例提升到 SOP 正式回归

---

## 5. 常见问题

### Q1：录制的时候浏览器提示我要登录？

原因：缓存的登录态过期了。解决：

```bash
cd C:\workcode\webapp\apps\web-e2e
del .auth\admin.json    # Windows
# 或者 rm .auth/admin.json（bash）
```

然后重新 `make e2e-record ...`，它会自动重新登录一次。

### Q2：Chromium 没弹出来？

- 检查防火墙/杀毒有没有拦截
- 把 `C:\Users\<你>\AppData\Local\ms-playwright` 目录加到白名单
- 重跑 `pnpm --filter web-e2e install-browsers`

### Q3：我点错了想重来？

关掉 Chromium 和 Inspector，什么都不用保留——重跑 `make e2e-record ...`。旧录制会留在 `recordings/` 里但不会自动进项目，忽略就行，或者手动 `del` 掉。

### Q4：录到一半能暂停吗？

可以。Inspector 右上角有 ⏸ 暂停按钮。或者直接关窗口保留半成品文件，下次再手工补。但建议：每条流程一次录完，别中断。

### Q5：导入后跑失败，说 "page.waitForTimeout"？

这是好事。系统在提醒开发：你录制时等过一段时间（比如等加载），这种"死等"容易不稳定。文件里会有 `// TODO[e2e]:` 标记——开发会来替换成更稳的等待方式。你不用动它。

### Q6：我录的是破坏性操作（新建、删除、修改数据），怕搞坏系统？

**不可能搞坏生产。** 原因：

1. 测试环境锁定在 `https://web-beta.apps.blksails.cn`，完全独立的数据库
2. `tenantGuard` fixture 会在每个破坏性操作前检查当前租户——如果不是 `company_id=1` 就会 hard fail
3. 测试数据用 `e2e-` 前缀 + 时间戳，不会和真人数据撞车

**但是一个要求**：录制时填表单的**名字/邮箱/电话**等字段，手动写成 `e2e-` 前缀。例如：

- 销售组名：`e2e-sales-20260423`
- 邀请邮箱：`e2e-invite@blksails.test`
- 手机号：测试号段如 `13800000000`（staging 不会真的发短信）

### Q7：断言应该放在哪些时候？

这是最重要的判断点。原则：

- **跳转后**：页面 URL 变了 → 断言新页面的关键元素（面包屑、标题）
- **新建成功后**：列表里多一行 → 断言新行的名字可见
- **删除/失效**：列表里少一行 → 断言"已删除"的那行不可见
- **按钮状态变了**：按钮从灰变亮 / 文字变了 → 断言按钮 enabled/disabled 或文字
- **弹出提示 toast**：断言 toast 文本包含关键字（例如"成功"、"失败"、"已保存"）

**每个关键步骤至少一个断言。** 光点不断 = 你在测试"我能点击"，而不是"功能正确"。

### Q8：看不懂 Inspector 右边生成的代码？

不用懂。你只管 Chromium 窗口里操作，代码自动生成。如果代码看上去有明显错误（比如 `getByRole('button', { name: '' })` 名字空了），提给开发让他们看。

### Q9：导入后开发让我补充"负向路径"是什么意思？

你录的通常是"正常流程"（新建 → 成功）。**负向路径**是相反的：

- 输入为空点确认 → 应该提示"请填写"
- 输入非法格式 → 应该报错
- 点两次快速点击 → 应该只创建一次（防重复提交）

这些也值得录。开发会告诉你要补哪些。

### Q10：我录的用例跑了两次，第二次失败是为什么？

多半是测试数据没有清理：第一次创建的 `e2e-组A` 还在，第二次又创建同名的就冲突了。解决办法：

- 用时间戳：名字写 `e2e-组-{{当前时间}}` 这种概念的——让开发帮你改
- 或者录制时就主动手动用不同名字

---

## 6. 检查清单

提交给开发前自查：

- [ ] 用例聚焦在**一条业务流程**上，没把多条流程串进一个文件
- [ ] 关键步骤都有断言（跳转、创建成功、状态变化、toast）
- [ ] 录制时填的数据都用了 `e2e-` 前缀
- [ ] 本地跑 `pnpm --filter web-e2e test tests/recorded/xxx.spec.ts --headed` 一次能通
- [ ] 每条用例的 PR 只包含一个 `tests/recorded/*.spec.ts` 文件，不混在一起

---

## 7. 找谁求助

- **录制技巧、业务流程**：组里其他测试同事
- **Chromium 弹不出来、`make e2e-xxx` 报错**：开发
- **登录不上、账号问题**：你的测试账号管理员

`docs/ENGINEER-GUIDE.md` 是给开发看的——你如果好奇内部怎么跑也可以瞥一眼。
