#!/usr/bin/env tsx
/**
 * 把当前 e2e 项目打包成模板，供 Tauri 构建时当作资源打进安装包。
 * 首次在用户机器上解压到 app_data_dir，给测试专员一份开箱即用的测试工程。
 *
 * 白名单 > 黑名单：避免误把 node_modules / .auth / 构建产物打进包。
 * 只会拷 tests / pages / fixtures / scripts / reporters / docs / 配置文件 + README 等。
 *
 * 被 `pnpm desktop:build`（Tauri `beforeBuildCommand`）自动触发，也可以手动
 * 跑 `pnpm stage-template` 试看。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const DEST = resolve(PROJECT_ROOT, 'src-tauri', 'template-project');
const ZIP_PATH = resolve(PROJECT_ROOT, 'src-tauri', 'template-project.zip');

// 顶层必须拷贝的文件/目录。相对项目根。
const INCLUDE: string[] = [
  // 目录
  'tests',
  'pages',
  'fixtures',
  'scripts',
  'reporters',
  'docs',
  // 配置
  'package.json',
  'pnpm-lock.yaml',
  'playwright.config.ts',
  'playwright.any.config.ts',
  'global-setup.ts',
  'tsconfig.json',
  'eslint.config.js',
  // 运行期模板
  '.env.example',
  '.gitignore',
  '.npmrc',
  'README.md',
];

// 上面白名单子树内仍要排除的路径（相对白名单项目）。例如 scripts/ 里别复制编译缓存。
const SUBTREE_EXCLUDE = new Set<string>([
  'node_modules',
  '.DS_Store',
  'Thumbs.db',
  '__pycache__',
]);

async function reset(): Promise<void> {
  if (existsSync(DEST)) {
    await rm(DEST, { recursive: true, force: true });
  }
  await mkdir(DEST, { recursive: true });
}

function copyFilter(source: string): boolean {
  const base = source.split(/[\\/]/).pop()!;
  if (SUBTREE_EXCLUDE.has(base)) return false;
  return true;
}

async function copyItem(rel: string): Promise<boolean> {
  const src = join(PROJECT_ROOT, rel);
  if (!existsSync(src)) return false;
  const dest = join(DEST, rel);
  await mkdir(dirname(dest), { recursive: true });
  const s = statSync(src);
  if (s.isDirectory()) {
    await cp(src, dest, { recursive: true, filter: copyFilter });
  } else {
    await cp(src, dest);
  }
  return true;
}

async function ensurePlaceholders(): Promise<void> {
  // recordings/ 目录模板里保留一个占位，用户首次解压就能 pnpm record
  const rec = join(DEST, 'recordings');
  if (!existsSync(rec)) await mkdir(rec, { recursive: true });
  await writeFile(
    join(rec, '.gitkeep'),
    '',
    { flag: 'w' },
  );
  // .auth 目录由 global-setup 自己创建，不需要提前造
}

async function writeReadme(): Promise<void> {
  const note = [
    '# BlackSail E2E — 桌面端默认模板',
    '',
    '这是由 BlackSail E2E 桌面端打包进安装包的**默认测试工程模板**。',
    '',
    '若此目录在你的机器上被解压到 `app_data_dir/template-project/`，',
    '说明你点过"用默认模板"按钮 —— 之后所有 e2e 执行都在此目录下发生。',
    '',
    '你可以自由编辑里面的 `.env.local` / `tests/` / `recordings/`，',
    '桌面端下次启动还是用它作为 project_root（已写进全局配置）。',
    '',
    '如果要切回你自己的 git 仓库，在概览页"项目路径"卡里改成仓库路径再保存。',
    '',
    '---',
    '',
  ].join('\n');
  await writeFile(join(DEST, 'DESKTOP-TEMPLATE-NOTES.md'), note, 'utf8');
}

async function listOutputs(): Promise<string[]> {
  const items = await readdir(DEST);
  return items.sort();
}

async function zipDirectory(): Promise<void> {
  if (existsSync(ZIP_PATH)) await rm(ZIP_PATH, { force: true });
  if (process.platform === 'win32') {
    // PowerShell Compress-Archive 是 Windows 内置，零外部依赖
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -Path '${DEST}\\*' -DestinationPath '${ZIP_PATH}' -Force`,
      ],
      { stdio: 'inherit' },
    );
  } else {
    // Mac/Linux 使用系统 zip —— 几乎都预装；若没装给明确指引
    try {
      execFileSync('zip', ['-rq', ZIP_PATH, '.'], { cwd: DEST, stdio: 'inherit' });
    } catch (e) {
      throw new Error(
        `未找到 zip 命令。macOS/Linux 请先装：brew install zip 或 sudo apt install zip。底层错误：${e}`,
      );
    }
  }
}

async function main(): Promise<void> {
  console.log(`[stage-template] project root: ${PROJECT_ROOT}`);
  console.log(`[stage-template] destination : ${DEST}`);
  console.log(`[stage-template] zip target  : ${ZIP_PATH}`);
  await reset();

  let hit = 0;
  let miss = 0;
  for (const rel of INCLUDE) {
    const ok = await copyItem(rel);
    if (ok) { hit++; console.log(`  + ${rel}`); }
    else     { miss++; console.log(`  - ${rel} (skipped, not found)`); }
  }

  await ensurePlaceholders();
  await writeReadme();

  console.log(`[stage-template] zipping…`);
  await zipDirectory();
  const zipSize = statSync(ZIP_PATH).size;
  console.log(`[stage-template] zip size: ${(zipSize / 1024).toFixed(1)} KB`);

  const top = await listOutputs();
  console.log(`[stage-template] ${hit} copied, ${miss} missing`);
  console.log(`[stage-template] staged top-level entries: ${top.join(', ')}`);
}

main().catch((err) => {
  console.error('[stage-template] failed:', err);
  process.exit(1);
});
