# 桌面应用 — BlackSail E2E 控制台

面向测试专员 / QA 的图形化界面。把项目里本来要在命令行里敲的
`pnpm test:smoke`、`pnpm record`、`pnpm report:dashboard` 等操作，
封装成点点鼠标就能跑的按钮。

> 桌面端基于 [Tauri v2](https://tauri.app/) + 原生 HTML/CSS/JS 构建。
> 不会另外安装 Playwright 依赖，调用的全部是本仓库里已有的 pnpm 脚本。

---

## 1. 给测试专员：装好就能用

如果你拿到的是工程师已经打包好的 `.msi` / `.dmg` / `.AppImage`，
直接双击装、打开即可 —— 下面"开发者篇"可以跳过。

**首次打开三步：**

1. 概览面板顶上「项目路径」里点**「解压默认模板并使用」**
   —— 应用会把自带的测试工程拷到 `app_data_dir/template-project/`，
   之后所有测试都在这里跑
2. 下面会出现「一键准备测试环境」卡片，点一下
   —— 自动跑 `pnpm install` + `pnpm install-browsers`（首次约 3–6 分钟）
3. 再下面「填测试账号」表单 —— 填 company_id=1 管理员邮箱/密码，保存

全程不需要开任何终端。第二次之后秒进。

> **想用自己的 git 仓库而非默认模板？** 在「项目路径」里点「浏览…」选你的仓库目录 → 保存。
> 应用立刻切到那个仓库里跑所有命令。

---

## 2. 给开发者：本地怎么跑

桌面端基于 Rust + Tauri v2 构建，需要：

- **Node.js 22.x** + **pnpm 10+**
- **Rust 1.77+**

```bash
pnpm install                    # 装 JS 依赖 + 自动跑 playwright install chromium (postinstall 钩子)
pnpm desktop                    # 开发模式启动（热重载）
pnpm desktop:build              # 打包分发（Windows .msi / macOS .dmg / Linux .AppImage）
```

第一次跑 `pnpm desktop` 时 Cargo 要下载并编译 Tauri 依赖，首次 3–8 分钟；之后秒起。

> `pnpm install` 的 `postinstall` 钩子会自动跑 `playwright install chromium`。
> 如果你在 CI 或资源受限环境想跳过，设 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`。

### 平台先决条件

| 平台 | 必需 |
|------|------|
| **Windows 10/11** | Rust via <https://rustup.rs/> · MSVC Build Tools（装 Rust 时会问） |
| **macOS 10.15+** | `xcode-select --install`（约 2GB）· `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` · 建议 `brew install pnpm node@22` |
| **Linux** | `rustup` · `apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev build-essential` |

### macOS 专属说明

1. **首次构建生成原生图标**：Tauri 会在 build 时根据 `icons/icon.png` 自动生成 `.icns`。
   也可以手动一次性生成全平台图标：
   ```bash
   pnpm tauri icon src-tauri/icons/icon.png
   ```
2. **打包产物**：`pnpm desktop:build` 会在 `src-tauri/target/release/bundle/` 下生成 `.app`、`.dmg`。
   - Apple Silicon 本机默认打 `aarch64-apple-darwin`
   - 要打 Intel 用：`pnpm tauri build --target x86_64-apple-darwin`（需提前 `rustup target add x86_64-apple-darwin`）
   - 通用二进制：`pnpm tauri build --target universal-apple-darwin`
3. **GUI 应用的 PATH 陷阱**：从 Dock/Launchpad 启动的 `.app` 默认**不继承**你 shell 的 PATH。
   桌面端 Rust 代码会自动调 `zsh -lc 'echo $PATH'` 抓登录 shell 的 PATH 并把 `/opt/homebrew/bin`、`~/.local/share/pnpm` 等常见位置拼进去，所以一般能找到 `pnpm`。
   如果概览面板的「pnpm 路径」还是红点，把装 pnpm 的目录 `export` 到你的 `~/.zshrc` 即可。
4. **代码签名 / 公证**：内部分发给 QA 可不签名 —— 第一次打开应用时右键 → 打开，同意「来自未知开发者」。
   对外分发请看 [Tauri 官方 macOS 签名指南](https://tauri.app/distribute/sign/macos/)。
5. **找项目目录**：Dock 启动时 cwd=`/`，应用会按以下顺序找项目：
   - `E2E_PROJECT_ROOT` 环境变量
   - 当前工作目录向上 5 级
   - 可执行文件目录向上 6 级
   - 都找不到时概览页会弹红色提示，让你手动设环境变量：
     ```bash
     launchctl setenv E2E_PROJECT_ROOT "/Users/you/workcode/web-e2e"
     ```
     设完重开应用。

---

## 3. 面板说明

左侧导航栏分 5 个面板：

### 概览
- **项目路径卡**：当前用的项目根 + 切换入口。优先级从高到低：
  1. 环境变量 `E2E_PROJECT_ROOT`
  2. 用户在 UI 点「保存」的全局配置（存在 `app_data_dir/desktop-global.json`）
  3. 已解压的默认模板（`app_data_dir/template-project/`）
  4. 自动扫描（当前目录 / exe 目录向上查找含 `package.json + playwright.config` 的目录）

  可以点「浏览…」手动挑一个目录保存；也可以点「解压默认模板并使用」把安装包里附带的模板拷到 `app_data_dir`（仅打包版本存在此按钮，dev 模式里隐藏）
- **一键准备测试环境**按钮：仅当依赖缺失时显示；点下去会串行跑 `pnpm install` 与 `pnpm install-browsers`，全程可见进度
- **测试账号表单**：直接在界面上填 `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` 等；保存会写进项目根 `.env.local`，保留注释与其他字段，密码默认隐藏
- 一眼看到：项目路径、运行平台、pnpm 路径、`node_modules` 是否装过、Playwright 是否就绪、`.env.local` 是否填过、历史报告等

### 运行测试
- **跑指定测试文件**：文件选择器挑一个 `.spec.ts`（默认定位到「导入目标目录」；也能从录制目录选）。可勾选 `--headed` / `--ui` / `--debug`，加 `--grep`。命令预览会实时显示
  - 文件在 `tests/` 下：走主配置 `pnpm test`（完整 reporters / fixtures）
  - 文件不在 `tests/` 下（例如原始录制）：自动切到衍生配置 `pnpm test:any`，通过 `E2E_SPEC_DIR` 把 testDir 指向该文件所在目录。不需要先导入
- **冒烟 @smoke**：PR 必跑 · `pnpm test:smoke`
- **SOP 回归**：`tests/sop/` 全量 · `pnpm test:sop`
- **录制用例**：`@recorded` 标签 · `pnpm test:recorded`
- **全量回归**：`pnpm test`
- **带浏览器跑**：`pnpm test:headed`（看着它点）
- **Playwright UI**：`pnpm test:ui`（交互调试，会单独开一个 Playwright 窗）
- **TypeScript 检查** / **Lint**：代码健康体检
- 下面是**实时日志**面板：点任一按钮，stdout/stderr 会流式出现；
  红色行是 stderr，蓝色是状态事件。右上角「停止」可以随时 kill 当前任务

### 录制与导入
- **最近录制**：列出录制目录下按修改时间倒序的最近 10 条。每条两个按钮：
  - **立即试跑**：不用先导入，直接用衍生配置 `playwright.any.config.ts` 跑这个文件。加载登录态但不过 tenantGuard。一键验证刚刚录的动作是否连得通
  - **带窗口**：同上但加 `--headed`，看着浏览器跑
- **保存位置卡片**：可以配置
  - 录制保存目录（默认 `recordings/`）：codegen 生成的 `*.spec.ts` 落这里
  - 导入目标目录（默认 `tests/recorded/`）：规范化后的正式用例落这里
  - 支持相对路径（以项目根为基准）或绝对路径；右侧有"选目录…"对话框
  - 保存后落在项目根的 `.desktop-config.json`（已 gitignore，按机器自留）
- **录制新流程**：填一个英文短横线的用例名（例如 `invite-member`）和起始路径，
  点「启动 codegen 录制」。Chromium 会带着登录态打开；你像平常一样点业务流程，
  codegen 会把动作写成 `<录制目录>/<name>-<时间戳>.spec.ts`。录完会自动出现在上面"最近录制"里
- **导入**：选择刚录的那个文件（对话框默认定位到录制目录），挑 SOP 分组（sop1~sop5），点「导入」。
  底层调 `pnpm import -- --file ... --sop ... --outDir <导入目录>`

### 报告
- **综合仪表盘**：`reports/index.html`，覆盖率 / 耗时 / 建议
- **Playwright 官方报告**：`reports/playwright-html/index.html`，失败用例有 trace/视频
- **原始数据**：`playwright.json`、`suggestions.md`、`junit.xml`
- **失败产物**：直接打开 `test-results/` 文件夹

每个按钮点下去就是用系统默认应用打开对应文件或目录（浏览器打开 HTML、编辑器打开 MD/XML…）。

### 文档
- 渲染 `docs/` 下所有 Markdown
- 左侧是文件列表，右侧是内容。包含测试人员录制手册、工程师指南、覆盖率总览等

---

## 4. 它不会做什么

- **不会**跳过任何 tenantGuard 检查。写入动作依然只允许落在 company_id=1
- **不会**改你的 Playwright 配置、不会绕过 global-setup
- **不会**把测试跑到云上。所有执行都在你本机
- **不会**自己生成账号。`.env.local` 仍然需要工程师把 company_id=1 管理员账号交给你

---

## 5. 目录约定

```
apps/web-e2e/
├── src-tauri/              # Rust 壳 + 配置
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/
│   ├── icons/
│   ├── template-project/   # 打包时 stage-template 产出的默认模板（gitignored）
│   └── src/
│       ├── main.rs
│       └── lib.rs          # Tauri commands：run_pnpm / list_docs / read_doc ...
├── ui/                     # 前端（vanilla HTML/JS，无构建）
│   ├── index.html
│   ├── app.js
│   └── style.css
├── scripts/
│   └── stage-template.ts   # 把当前工程打包成模板资源
└── docs/                   # 文档（桌面端会读取这里渲染）
    ├── DESKTOP-APP.md      # 本文
    ├── TESTER-RECORDING-GUIDE.md
    └── ...
```

### 模板打包原理

`pnpm desktop:build`（以及 `pnpm desktop`）会通过 Tauri 的 `beforeBuildCommand` 自动先跑
`pnpm stage-template`，把当前工程下的 `tests/`、`pages/`、`fixtures/`、
`scripts/`、`docs/`、配置文件和 `.env.example` 拷到 `src-tauri/template-project/`。
然后 Tauri 把这个目录作为资源打进安装包。

安装后首次启动，用户点「解压默认模板并使用」，Rust 侧的 `extract_template` 命令把
资源目录 (`<install>/resources/template-project`) 递归拷到 `app_data_dir/template-project/`
（这是用户可写目录），并把全局配置 `desktop-global.json` 的 `project_root` 指向它。

之后所有命令 —— `pnpm install` / `pnpm test` / `pnpm record` —— 都以这个目录为 cwd。

**排除清单**：`node_modules/`、`src-tauri/`、`ui/`、`.auth/`、`.env`、`.env.local`、
`reports/`、`test-results/`、`recordings/*.ts` 都不会进模板。
`scripts/stage-template.ts` 里的 `INCLUDE` 白名单是真实情况。

---

## 6. 故障排查

| 症状 | 处理 |
|------|------|
| 启动失败提示 `启动 pnpm 失败` | 需要本机装 Node.js 22+ 和 pnpm 10+；Windows 要能在命令行直接跑 `pnpm -v` |
| Mac 点按钮显示"找不到 pnpm" | GUI PATH 没拿到；把 pnpm 装到 `~/.local/share/pnpm` 或 `/opt/homebrew/bin`；或确认 `zsh -lc 'which pnpm'` 能输出路径 |
| Mac 首次打开提示"来自未知开发者" | 在 Finder 里**右键** → 打开，同意一次；或系统设置 → 隐私与安全性 → 仍要打开 |
| Mac 概览页「没找到 e2e 项目目录」 | `launchctl setenv E2E_PROJECT_ROOT "/Users/you/workcode/web-e2e"`，然后重开应用 |
| 「一键准备测试环境」按钮卡住不动 | 打开概览面板看"运行测试"日志面板里 install 是否在下载；国内网络慢可以配 npm 镜像 |
| 浏览器提示 "Executable doesn't exist" | 重新点一次概览面板的「一键准备测试环境」—— 这会跑 `playwright install chromium` 幂等补回 |
| 日志没输出 | 开 devtools（dev 模式默认弹；生产按 F12）看前端是否收到 `job-log` 事件 |
| 图标看着不对 | 占位图标；要替换成项目 logo 在 `src-tauri/icons/` 下改或 `pnpm tauri icon <source.png>` 自动生成 |
| `pnpm desktop:build` 报缺 ico/icns | Windows 需要 `icon.ico`、macOS 需要 `icon.icns`；用 `pnpm tauri icon` 生成 |
| 点按钮没反应 | 底部状态栏看 "环境就绪" 是不是绿色；若不是按「概览」面板的提示补齐 |
| 想看 Rust 侧日志 | `RUST_LOG=debug pnpm desktop` |

---

## 7. 贡献与扩展

想加新按钮？两步：

1. 在 `ui/index.html` 加一个 `<button data-job="..." data-args="...">`；
   `data-args` 就是你在命令行里 `pnpm` 后面跟的参数
2. 不需要改 Rust — 已经有通用的 `run_pnpm` 命令兜住所有 pnpm 脚本

想加新的 Rust 命令（比如读取某个状态文件）？在 `src-tauri/src/lib.rs` 加 `#[tauri::command]`
函数，然后加到 `invoke_handler![]` 宏里；前端通过 `window.__TAURI__.core.invoke('your_cmd')` 调用。

---

## 8. 和 CLI 的关系

桌面端和 CLI **不是二选一**，是互补：

| 场景 | 推荐 |
|------|------|
| 日常跑冒烟 / 看报告 / 录用例 | 桌面端 |
| CI / 批量化 / 脚本集成 | CLI (`pnpm test`) |
| 调 Playwright fixture 本身 | CLI + `pnpm test:ui` |
| 给不会命令行的测试专员用 | 桌面端 |

桌面端生成的所有产物（reports/、recordings/、test-results/）和 CLI 完全一致；
测试专员录完后，工程师可以照常 `pnpm import` 接手审查。
