// BlackSail E2E 控制台 — 前端逻辑
// 通过 window.__TAURI__ 与 Rust 后端通信（withGlobalTauri=true）。

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// 统一通过后端命令打开原生选择器（withGlobalTauri 不暴露 dialog 插件）
const pick = {
  file: (filters, defaultPath) =>
    invoke('pick_file', { filters: filters || null, defaultPath: defaultPath || null }),
  directory: (defaultPath) =>
    invoke('pick_directory', { defaultPath: defaultPath || null }),
};

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- 视图切换 ----------
$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === view));
    if (view === 'docs') loadDocsList();
    if (view === 'dashboard') { loadEnv().then(loadProjectRootCard); loadEnvForm(); }
    if (view === 'record') loadConfigAndDirs();
  });
});

// ---------- 环境信息 ----------
let lastEnv = null;
let lastNode = null;
async function loadEnv() {
  const env = await invoke('env_info');
  lastEnv = env;
  try { lastNode = await invoke('detect_node_env'); } catch { lastNode = null; }
  renderNodeCard();
  const cards = $('#env-cards');
  const row = (label, ok, text, hint) => `
    <div class="env-card">
      <div class="label">${label}</div>
      <div class="value"><span class="dot ${ok ? 'ok' : 'bad'}"></span>${text}</div>
      ${hint ? `<div class="muted tight">${hint}</div>` : ''}
    </div>`;
  const nodeOk = lastNode && lastNode.node_found;
  const pnpmOk = lastNode && lastNode.pnpm_found;
  cards.innerHTML = [
    row('项目路径', env.project_root_found, env.project_root_found ? `<code>${env.project_root}</code>` : '未找到', env.project_root_found ? '' : '见上方「没找到 e2e 项目目录」提示'),
    row('运行平台', true, env.platform),
    row('Node.js', nodeOk, nodeOk ? `${lastNode.node_version} <span class="muted">(${lastNode.source})</span>` : '未检测到', nodeOk ? `<code>${lastNode.node_path}</code>` : '见下方红色提示'),
    row('pnpm', pnpmOk, pnpmOk ? (lastNode.pnpm_version || '已安装') : '未找到', pnpmOk ? `<code>${lastNode.pnpm_path}</code>` : '推荐：<code>npm i -g pnpm</code>（先有 node）'),
    row('node_modules', env.node_modules_installed, env.node_modules_installed ? '已安装' : '未安装', env.node_modules_installed ? '' : '点上方「一键准备测试环境」'),
    row('Playwright 浏览器', env.playwright_installed, env.playwright_installed ? '已就绪' : '未安装', env.playwright_installed ? '' : '点上方「一键准备测试环境」'),
    row('登录缓存', env.auth_exists, env.auth_exists ? '.auth/admin.json 已有' : '首次运行会自动登录'),
    row('综合报告', env.has_reports, env.has_reports ? 'reports/index.html 已存在' : '还没跑过'),
  ].join('');

  $('#no-project-card').style.display = env.project_root_found ? 'none' : '';
  const depsReady = env.project_root_found && env.node_modules_installed && env.playwright_installed;
  $('#setup-card').style.display = env.project_root_found && !depsReady ? '' : 'none';

  const ind = $('#env-indicator');
  if (!env.project_root_found) {
    ind.textContent = '未找到项目';
    ind.style.color = 'var(--danger)';
  } else {
    const ready = depsReady && env.env_local_exists;
    ind.textContent = depsReady ? (ready ? '环境就绪' : '仅缺 .env.local') : '依赖未就绪';
    ind.style.color = ready ? 'var(--success)' : depsReady ? 'var(--warn)' : 'var(--danger)';
  }
}

// ---------- Node 环境卡片 ----------
function renderNodeCard() {
  const card = $('#no-node-card');
  if (!card) return;
  const found = lastNode && lastNode.node_found;
  card.style.display = found ? 'none' : '';
  if (found) return;
  const hasVersions = lastNode && lastNode.nvm_versions && lastNode.nvm_versions.length > 0;
  $('#nvm-suggest').style.display = hasVersions ? '' : 'none';
  if (hasVersions) {
    $('#nvm-versions-list').innerHTML = lastNode.nvm_versions
      .map((v) => `<li><code>${v.name}</code> — <span class="muted">${v.path}</span></li>`)
      .join('');
  }
}

$('#btn-open-node-site')?.addEventListener('click', async () => {
  const url = (lastNode && lastNode.download_url) || 'https://nodejs.org/zh-cn/download';
  try { await invoke('open_external_url', { url }); } catch (e) { alert(String(e)); }
});

$('#btn-recheck-node')?.addEventListener('click', async () => {
  await loadEnv();
  await loadProjectRootCard();
});

// 所有 data-ext-url 链接
document.addEventListener('click', async (e) => {
  const a = e.target.closest && e.target.closest('[data-ext-url]');
  if (!a) return;
  e.preventDefault();
  const url = a.dataset.extUrl;
  try { await invoke('open_external_url', { url }); } catch (err) { alert(String(err)); }
});

// ---------- 日志控制台 ----------
const consoleEl = $('#console');
const jobStatus = $('#job-status');
const btnStop   = $('#btn-stop');
const btnClear  = $('#btn-clear');

let currentJob = null;

function appendLog(kind, line) {
  const span = document.createElement('span');
  if (kind !== 'stdout') span.className = kind;
  span.textContent = (kind === 'status' ? `▶ ${line}\n` : kind === 'error' ? `✗ ${line}\n` : `${line}\n`);
  consoleEl.appendChild(span);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

// 批量试跑状态机：跟踪 chain 推进，把每行录制的 ✓/✗ 实时写到 .run-status 上
const batchRunState = {
  active: false,
  paths: [],   // 启动时的文件路径快照（按 chain 步骤顺序）
  current: -1, // 当前正在跑的 step 索引（0-based）；-1 = 还没开始
};
function setRowStatus(path, status) {
  if (!path) return;
  // 用属性比较查行，避免 querySelector 处理路径里的特殊字符（: \ / 等）
  const li = $$('#recent-list li').find((el) => el.dataset.path === path);
  if (!li) return;
  const span = li.querySelector('.run-status');
  if (!span) return;
  span.dataset.status = status;
  span.textContent = status === 'running' ? '▶' : status === 'ok' ? '✓' : status === 'fail' ? '✗' : '';
}
function clearAllRowStatuses() {
  $$('#recent-list .run-status').forEach((sp) => { sp.dataset.status = ''; sp.textContent = ''; });
}

listen('job-log', (event) => {
  const { job, kind, line } = event.payload;
  if (currentJob && job !== currentJob) return; // 只显示当前关注的任务
  appendLog(kind, line);

  // === 批量试跑：实时更新行状态 ===
  // run_pnpm_chain 在每步开始时 emit `[i/total] <label>`。chain 只有在前一步成功才会推进，
  // 所以"看到下一步开始" ⇒ "前一步成功"。这样不用改 Rust，纯靠现有事件流就能反推 ✓。
  if (batchRunState.active && job === 'batch-run' && kind === 'status') {
    const m = /^\[(\d+)\/\d+\]/.exec(line);
    if (m) {
      const newIdx = Number(m[1]) - 1;
      // 把上一个 current 到 newIdx 之间的所有步骤都打 ✓（通常就一步，防御性多步）
      for (let i = Math.max(0, batchRunState.current); i < newIdx; i++) {
        setRowStatus(batchRunState.paths[i], 'ok');
      }
      batchRunState.current = newIdx;
      setRowStatus(batchRunState.paths[newIdx], 'running');
    }
  }

  if (kind === 'status' && line.startsWith('任务')) {
    const success = line.includes('成功');
    jobStatus.textContent = success ? '成功' : line.includes('退出码') ? '结束' : '空闲';
    jobStatus.className = 'pill ' + (success ? 'pill-idle' : 'pill-error');
    btnStop.disabled = true;
    enableAllActions(true);
    const finishedJob = currentJob;
    currentJob = null;
    // 批量试跑收尾：成功 → 当前及之后全打 ✓；失败 → 当前打 ✗
    if (finishedJob === 'batch-run' && batchRunState.active) {
      if (success) {
        for (let i = Math.max(0, batchRunState.current); i < batchRunState.paths.length; i++) {
          setRowStatus(batchRunState.paths[i], 'ok');
        }
      } else if (batchRunState.current >= 0) {
        setRowStatus(batchRunState.paths[batchRunState.current], 'fail');
      }
      batchRunState.active = false;
      batchRunState.paths = [];
      batchRunState.current = -1;
    }
    // 特殊任务结束后刷新相关 UI
    if (finishedJob === 'setup' || (finishedJob || '').startsWith('import:')) {
      loadEnv();
    }
    if ((finishedJob || '').startsWith('record:')) {
      loadRecentRecordings();
    }
    if (finishedJob === 'setup' && success) {
      // 装完回到 Dashboard 让用户看到全绿
      $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'dashboard'));
      $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === 'dashboard'));
    }
  } else if (kind === 'error') {
    jobStatus.textContent = '错误';
    jobStatus.className = 'pill pill-error';
  }
});

btnClear.addEventListener('click', () => {
  consoleEl.innerHTML = '';
});

btnStop.addEventListener('click', async () => {
  if (!currentJob) return;
  try {
    await invoke('kill_job', { job: currentJob });
    appendLog('status', `已发送停止信号：${currentJob}`);
  } catch (e) {
    appendLog('error', String(e));
  }
});

function enableAllActions(enabled) {
  $$('button.action, button[data-job]').forEach((b) => { b.disabled = !enabled; });
}

async function startJob(job, argsOrArray, env) {
  if (currentJob) {
    alert(`任务「${currentJob}」还在跑，请等结束或点停止。`);
    return;
  }
  currentJob = job;
  jobStatus.textContent = '运行中';
  jobStatus.className = 'pill pill-running';
  btnStop.disabled = false;
  enableAllActions(false);
  // 自动切到「运行测试」面板，可见日志
  if (!$('.view[data-view="run"]').classList.contains('active')) {
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'run'));
    $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === 'run'));
  }
  const args = Array.isArray(argsOrArray)
    ? argsOrArray
    : argsOrArray.split(/\s+/).filter(Boolean);
  try {
    await invoke('run_pnpm', { args: { job, args, env: env || null } });
  } catch (e) {
    appendLog('error', String(e));
    jobStatus.textContent = '错误';
    jobStatus.className = 'pill pill-error';
    btnStop.disabled = true;
    enableAllActions(true);
    currentJob = null;
  }
}

// 绑定所有 data-job 按钮
$$('button[data-job]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const job = btn.dataset.job;
    const argsStr = btn.dataset.args || job;
    startJob(job, argsStr);
  });
});

// ---------- 跑指定测试文件 ----------
function normalizeSeparators(p) {
  return (p || '').replace(/\\/g, '/');
}
function relToProjectRoot(absPath) {
  if (!lastEnv || !lastEnv.project_root_found) return absPath;
  const root = normalizeSeparators(lastEnv.project_root).replace(/\/$/, '');
  const abs  = normalizeSeparators(absPath);
  if (abs.toLowerCase().startsWith(root.toLowerCase() + '/')) {
    return abs.slice(root.length + 1);
  }
  return abs; // 外部路径原样返回
}
function isUnderTests(relPath) {
  const p = normalizeSeparators(relPath);
  return p.startsWith('tests/');
}

// 登录行为检测 —— 必须与 scripts/detect-login.ts 的 LOGIN_SIGNALS / KEEP_AUTH_MARKER 保持一致。
// 用途：选中某个测试文件后，若内容含登录行为，强制走 test:any 路由（playwright.any.config.ts
// 在 config 加载时会清空 storageState 并跳过 globalSetup），避免预登录态污染登录流程测试。
const LOGIN_KEEP_AUTH_MARKER = /\/\/\s*@keep-auth\b/;
const LOGIN_SIGNALS = [
  /page\.goto\(\s*[`'"][^`'"]*\/login\b/,
  /getByRole\(\s*['"`]button['"`]\s*,\s*\{\s*name\s*:\s*['"`/](?![^'"`,)]*退出)[^'"`,)]*登录/,
  /getByLabel\(\s*[`'"]密码/,
  /getByRole\(\s*['"`]textbox['"`]\s*,\s*\{\s*name\s*:\s*['"`/][^'"`,)]*邮箱/,
  /getByRole\(\s*['"`]textbox['"`]\s*,\s*\{\s*name\s*:\s*['"`/][^'"`,)]*手机号/,
];
function specSourceContainsLogin(source) {
  if (!source) return false;
  if (LOGIN_KEEP_AUTH_MARKER.test(source)) return false;
  return LOGIN_SIGNALS.some((re) => re.test(source));
}

// 缓存当前 #spec-file 的检测结果。null = 还没检测/路径为空；boolean = 检测完。
let lastSpecLoginDetected = null;
let lastSpecDetectedFor = '';
async function detectLoginForCurrentSpec() {
  const file = $('#spec-file').value.trim();
  if (!file) {
    lastSpecLoginDetected = null;
    lastSpecDetectedFor = '';
    return null;
  }
  if (file === lastSpecDetectedFor && lastSpecLoginDetected !== null) {
    return lastSpecLoginDetected;
  }
  try {
    const text = await invoke('read_spec_text', { path: file });
    lastSpecLoginDetected = specSourceContainsLogin(text);
  } catch {
    // 读取失败（不存在/非 spec/超大）：当作未检测到，让后端去走默认路径
    lastSpecLoginDetected = false;
  }
  lastSpecDetectedFor = file;
  return lastSpecLoginDetected;
}

/** 构建运行测试文件所需的 pnpm args + env。
 * 默认路由：
 *   - 在 tests/ 下 → `pnpm test -- <relpath>` （用主配置，完整 reporters / tenantGuard）
 *   - 不在 tests/ 下 → `pnpm test:any -- <relpath>` + E2E_SPEC_DIR=<dir>（衍生配置）
 *
 * 例外：检测到登录行为且文件不是 *.anon.spec.ts 命名时，强制走 test:any —— 该路径
 * 的 playwright.any.config.ts 会在 config 加载时清空 storageState 并跳过 globalSetup，
 * 避免预登录态污染登录流程测试。tests/ 下 *.anon.spec.ts 走主配置即可（chromium-anonymous
 * project 已经处理）。
 */
function buildSpecArgs() {
  const file = $('#spec-file').value.trim();
  if (!file) return null;
  const rel = relToProjectRoot(file);
  const norm = normalizeSeparators(rel);
  const underTests = isUnderTests(norm);
  const isAnonNamed = /\.anon\.spec\.ts$/i.test(norm);
  const loginDetected = lastSpecLoginDetected === true;
  const forceAnyForLogin = loginDetected && !isAnonNamed;
  const useAnyConfig = !underTests || forceAnyForLogin;

  const args = useAnyConfig ? ['test:any', '--', norm] : ['test', '--', norm];
  const headed = $('#spec-headed').checked;
  if (headed) args.push('--headed');
  if ($('#spec-ui').checked) args.push('--ui');
  if ($('#spec-debug').checked) args.push('--debug');
  const grep = $('#spec-grep').value.trim();
  if (grep) { args.push('--grep', grep); }

  const env = {};
  if (useAnyConfig) {
    // E2E_SPEC_DIR 只需目录即可，playwright testDir 设成此
    const slash = norm.lastIndexOf('/');
    const dir = slash >= 0 ? norm.slice(0, slash) : '.';
    env.E2E_SPEC_DIR = dir || '.';
  }
  // 保险：除 CLI --headed 外，同时用 env 让 playwright.any.config 覆盖 headless + slowMo
  // （CLI --headed 在某些 pnpm/shell 组合里可能被吞，env 是更可靠的入口）
  if (headed) env.E2E_SPEC_HEADED = '1';
  // 前端已经检测到登录行为时，给 any-config 一个硬覆盖通道，避免后端
  // process.argv / cwd 解析在某些 pnpm 版本下有偏差导致回扫错过该文件。
  if (forceAnyForLogin) env.E2E_FORCE_ANON = '1';
  return {
    args,
    rel: norm,
    underTests,
    useAnyConfig,
    forceAnyForLogin,
    loginDetected,
    isAnonNamed,
    env,
  };
}

async function refreshSpecPreview() {
  // 检测当前选中文件是否含登录行为；结果会被 buildSpecArgs 读到。
  await detectLoginForCurrentSpec();
  const built = buildSpecArgs();
  if (!built) { $('#spec-cmd-preview').textContent = ''; $('#spec-warn').textContent = ''; return; }
  const envStr = Object.keys(built.env).length
    ? Object.entries(built.env).map(([k, v]) => `${k}=${v}`).join(' ') + ' '
    : '';
  $('#spec-cmd-preview').textContent = '$ ' + envStr + 'pnpm ' + built.args.map((a) => a.includes(' ') ? `"${a}"` : a).join(' ');
  const hint = $('#spec-warn');
  if (built.forceAnyForLogin) {
    hint.innerHTML = '检测到<strong>登录行为</strong> —— 已切换到 <code>playwright.any.config.ts</code>，将清空 storageState 并跳过预登录。在脚本里加 <code>// @keep-auth</code> 可强制保留登录态。';
    hint.style.color = 'var(--warn)';
  } else if (built.loginDetected && built.isAnonNamed) {
    hint.innerHTML = '检测到登录行为；文件名是 <code>.anon.spec.ts</code>，主配置的 chromium-anonymous project 会自动清空 storageState。';
    hint.style.color = 'var(--muted)';
  } else if (!built.underTests) {
    hint.innerHTML = '使用衍生配置 <code>playwright.any.config.ts</code> 直接跑该文件（加载登录态但不过 tenantGuard）。要正式入库请"导入"后再用主配置跑。';
    hint.style.color = 'var(--muted)';
  } else {
    hint.textContent = '';
  }
}

async function pickSpecFile(from) {
  const defaultPath =
    from === 'recordings' ? resolvedRecordingsAbs
    : from === 'imports'  ? resolvedImportsAbs
    : (lastEnv && lastEnv.project_root);
  try {
    const selected = await pick.file(
      [{ name: 'Playwright spec', extensions: ['ts'] }],
      defaultPath,
    );
    if (typeof selected === 'string') {
      $('#spec-file').value = selected;
      refreshSpecPreview();
    }
  } catch (e) { alert(String(e)); }
}

$('#btn-pick-spec').addEventListener('click', () => pickSpecFile('imports'));
$('#btn-pick-spec-rec').addEventListener('click', () => pickSpecFile('recordings'));
$('#btn-clear-spec').addEventListener('click', () => {
  $('#spec-file').value = '';
  $('#spec-grep').value = '';
  $('#spec-headed').checked = false;
  $('#spec-ui').checked = false;
  $('#spec-debug').checked = false;
  refreshSpecPreview();
});
['spec-headed', 'spec-ui', 'spec-debug'].forEach((id) => {
  $('#' + id).addEventListener('change', refreshSpecPreview);
});
$('#spec-grep').addEventListener('input', refreshSpecPreview);

$('#btn-run-spec').addEventListener('click', async () => {
  // 等检测落停再读 buildSpecArgs，避免用户改完路径立刻点运行时还按旧检测结果走。
  await detectLoginForCurrentSpec();
  const built = buildSpecArgs();
  if (!built) { alert('请先选择一个测试文件'); return; }
  // 用文件名做 job id，防冲突
  const base = built.rel.split('/').pop().replace(/\.spec\.ts$/, '');
  startJob(`spec:${base}`, built.args, Object.keys(built.env).length ? built.env : null);
});

/** 公共函数：跑某个 spec 文件（被"最近录制"的"立即试跑"按钮调用） */
async function runSpecByPath(absPath, headed = false) {
  $('#spec-file').value = absPath;
  $('#spec-headed').checked = !!headed;
  $('#spec-ui').checked = false;
  $('#spec-debug').checked = false;
  $('#spec-grep').value = '';
  await refreshSpecPreview();
  const built = buildSpecArgs();
  if (!built) return;
  const base = built.rel.split('/').pop().replace(/\.spec\.ts$/, '');
  startJob(`spec:${base}`, built.args, Object.keys(built.env).length ? built.env : null);
}

// ---------- 首次环境向导：一键 install + install-browsers ----------
async function startSetup(options) {
  const opts = options || {};
  if (currentJob) {
    alert(`任务「${currentJob}」还在跑，请等结束或点停止。`);
    return;
  }

  // 修复安装：先清掉 node_modules
  if (opts.clean) {
    const ok = confirm('将删除项目下的 node_modules 再重装。继续？');
    if (!ok) return;
    try {
      appendLog('status', '清理 node_modules…');
      await invoke('wipe_node_modules');
      appendLog('status', 'node_modules 已清理');
    } catch (e) {
      appendLog('error', '清理失败：' + String(e));
      return;
    }
  }

  // 保证 .npmrc 存在，规避 Windows FS 问题（不覆盖已有 .npmrc）
  try {
    const msg = await invoke('ensure_npmrc');
    appendLog('status', msg);
  } catch (e) {
    appendLog('error', '写 .npmrc 失败：' + String(e));
  }

  currentJob = 'setup';
  jobStatus.textContent = '运行中';
  jobStatus.className = 'pill pill-running';
  btnStop.disabled = false;
  enableAllActions(false);
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'run'));
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === 'run'));

  // 始终两步都跑；pnpm install / install-browsers 都是幂等的
  const steps = [
    { label: '安装 JS 依赖 (pnpm install)', args: ['install'] },
    { label: '安装 Playwright 浏览器 (chromium)', args: ['install-browsers'] },
  ];

  try {
    await invoke('run_pnpm_chain', { args: { job: 'setup', steps } });
  } catch (e) {
    appendLog('error', String(e));
    jobStatus.textContent = '错误';
    jobStatus.className = 'pill pill-error';
    btnStop.disabled = true;
    enableAllActions(true);
    currentJob = null;
  }
}

$('#btn-setup').addEventListener('click', () => startSetup());
$('#btn-setup-clean').addEventListener('click', () => startSetup({ clean: true }));

// 绑定所有 data-open（打开本地文件/目录）
$$('button[data-open]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      await invoke('open_in_shell', { target: btn.dataset.open });
    } catch (e) {
      alert(String(e));
    }
  });
});

// ---------- 录制 / 导入 ----------
let desktopConfig = { recordings_dir: '', imports_dir: '' };
let resolvedRecordingsAbs = '';
let resolvedImportsAbs = '';

async function loadConfigAndDirs() {
  try {
    desktopConfig = (await invoke('read_config')) || {};
  } catch {}
  const recRaw = desktopConfig.recordings_dir || 'recordings';
  const impRaw = desktopConfig.imports_dir || 'tests/recorded';
  $('#cfg-recordings-dir').value = recRaw;
  $('#cfg-imports-dir').value = impRaw;
  try { resolvedRecordingsAbs = await invoke('resolve_recordings_dir'); } catch { resolvedRecordingsAbs = ''; }
  try { resolvedImportsAbs    = await invoke('resolve_imports_dir');    } catch { resolvedImportsAbs    = ''; }
  $('#rec-dir-abs').textContent = resolvedRecordingsAbs || '—';
  $('#imp-dir-abs').textContent = resolvedImportsAbs || '—';
  $('#rec-sample-path').textContent = recRaw;
  $('#imp-target-label').textContent = impRaw;
  $('#recent-dir-label').textContent = recRaw + '/';
  loadRecentRecordings();
}

function formatSince(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s 前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  return `${d} 天前`;
}

// 当前最近录制列表的缓存 —— 批量导入 / 批量试跑都直接拿来用，避免重复 IPC 调用
let lastRecentList = [];

// 自然顺序：TC-1 < TC-2 < TC-10（普通字典序会把 TC-10 排到 TC-2 前面）。
// 显示 + 批量试跑 + 批量导入都使用这个顺序，保证用户看到的次序就是执行次序。
function naturalCmp(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

async function loadRecentRecordings() {
  const ul = $('#recent-list');
  const card = $('#recent-card');
  try {
    // limit 不传 → 后端返回全部录制；CSS 限高 + 滚动让 5 条以上可滚动浏览
    const raw = await invoke('list_recordings', {});
    const list = (raw || []).slice().sort((a, b) => naturalCmp(a.name, b.name));
    lastRecentList = list;
    if (!list || list.length === 0) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';
    ul.innerHTML = list.map((r) => `
      <li data-path="${r.path}" data-relative="${r.relative}" data-name="${r.name}">
        <input type="checkbox" class="row-check" title="加入批量试跑" checked />
        <div class="meta">
          <div class="file" title="${r.relative}">${r.name}</div>
          <div class="when">${formatSince(r.modified_ms)} · ${r.relative}</div>
        </div>
        <span class="run-status" data-status="" title="批量试跑状态"></span>
        <button class="primary" data-action="run">立即试跑</button>
        <button data-action="run-headed" title="带浏览器窗口可见跑">带窗口</button>
        <button data-action="import" title="规范化后落到 tests/recorded/">导入</button>
      </li>
    `).join('');
    $$('#recent-list li').forEach((li) => {
      const path = li.dataset.path;
      li.querySelector('[data-action="run"]').addEventListener('click', () => runSpecByPath(path, false));
      li.querySelector('[data-action="run-headed"]').addEventListener('click', () => runSpecByPath(path, true));
      li.querySelector('[data-action="import"]').addEventListener('click', () => openImportModal(path, li.dataset.relative));
      li.querySelector('.row-check').addEventListener('change', updateSelectAllState);
    });
    updateSelectAllState();
  } catch (e) {
    card.style.display = 'none';
  }
}

// ---------- 导入弹窗 ----------
function openImportModal(absPath, relativeForLabel) {
  $('#import-modal-file').textContent = relativeForLabel || absPath;
  $('#import-modal-file').setAttribute('title', absPath);
  // 预填导入目录：优先用配置卡片里的当前值，回落到默认 tests/recorded
  const dirFromCfg = ($('#cfg-imports-dir').value || '').trim();
  $('#import-modal-dir').value = dirFromCfg || 'tests/recorded';
  // SOP 分组保留上次选择，不重置
  $('#import-modal').dataset.file = absPath;
  $('#import-modal').hidden = false;
}
function closeImportModal() {
  $('#import-modal').hidden = true;
  $('#import-modal').dataset.file = '';
}
$('#import-modal-cancel').addEventListener('click', closeImportModal);
$('#import-modal').addEventListener('click', (e) => {
  // 点遮罩关闭，点弹窗内部不关闭
  if (e.target === $('#import-modal')) closeImportModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#import-modal').hidden) closeImportModal();
});
$('#import-modal-pick-dir').addEventListener('click', async () => {
  const cur = $('#import-modal-dir').value || resolvedImportsAbs || (lastEnv && lastEnv.project_root);
  const p = await pickDirectory(cur);
  if (p) $('#import-modal-dir').value = p;
});
$('#import-modal-confirm').addEventListener('click', () => {
  const file = $('#import-modal').dataset.file;
  if (!file) { closeImportModal(); return; }
  const dir = ($('#import-modal-dir').value || '').trim();
  const sop = $('#import-modal-sop').value;
  if (!dir) { alert('请选择导入目标目录'); return; }
  closeImportModal();
  // 用数组形式避免路径含空格被 startJob 的 .split(/\s+/) 切碎
  startJob(`import:${sop}`, ['import:rec', '--', '--file', file, '--sop', sop, '--outDir', dir]);
});

// ---------- 批量导入 ----------
// 文件名前缀（TC-1-... / tc-2-... / Tc_3_...）映射到 sop 编号。第一段数字若 1..5 内
// 才视为有效（与 #imp-sop / #import-modal-sop 的可选项保持一致），否则返回 null。
function sopFromRecordingName(name) {
  const m = /^[Tt][Cc][-_](\d+)/.exec(name || '');
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return `sop${n}`;
}

function openBatchImportModal() {
  if (!lastRecentList || lastRecentList.length === 0) {
    alert('当前录制目录没有可导入的文件');
    return;
  }
  const dirFromCfg = ($('#cfg-imports-dir').value || '').trim();
  $('#import-batch-dir').value = dirFromCfg || 'tests/recorded';
  const ul = $('#import-batch-preview');
  ul.innerHTML = lastRecentList.map((r) => {
    const sop = sopFromRecordingName(r.name);
    const tag = sop
      ? `<span class="sop-tag">${sop}</span>`
      : `<span class="sop-tag unmatched">未匹配（不带 SOP 标签）</span>`;
    return `<li><span class="filename" title="${r.relative}">${r.name}</span>${tag}</li>`;
  }).join('');
  $('#import-batch-count').textContent = String(lastRecentList.length);
  $('#import-batch-modal').hidden = false;
}
function closeBatchImportModal() { $('#import-batch-modal').hidden = true; }

$('#btn-batch-import').addEventListener('click', openBatchImportModal);
$('#import-batch-cancel').addEventListener('click', closeBatchImportModal);
$('#import-batch-modal').addEventListener('click', (e) => {
  if (e.target === $('#import-batch-modal')) closeBatchImportModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#import-batch-modal').hidden) closeBatchImportModal();
});
$('#import-batch-pick-dir').addEventListener('click', async () => {
  const cur = $('#import-batch-dir').value || resolvedImportsAbs || (lastEnv && lastEnv.project_root);
  const p = await pickDirectory(cur);
  if (p) $('#import-batch-dir').value = p;
});

// ---------- 行勾选 / 全选 ----------
// 全选 checkbox 的三态：全勾 = checked；全不勾 = unchecked；部分勾 = indeterminate。
// 行勾选变化时调一次 updateSelectAllState 同步表头；表头切换时把所有可见行写成同一状态。
function getRowCheckboxes() {
  return $$('#recent-list .row-check');
}
function updateSelectAllState() {
  const boxes = getRowCheckboxes();
  const all = $('#recent-select-all');
  const label = $('#recent-select-count');
  if (!all) return;
  if (boxes.length === 0) {
    all.checked = false;
    all.indeterminate = false;
    if (label) label.textContent = '';
    return;
  }
  const checked = boxes.filter((b) => b.checked).length;
  all.checked = checked === boxes.length;
  all.indeterminate = checked > 0 && checked < boxes.length;
  if (label) label.textContent = `已选 ${checked} / ${boxes.length}`;
}
$('#recent-select-all').addEventListener('change', (e) => {
  const on = e.target.checked;
  getRowCheckboxes().forEach((b) => { b.checked = on; });
  updateSelectAllState();
});

// ---------- 批量试跑 ----------
// 依次跑 lastRecentList 里勾选了的录制；每个文件复用 buildSpecArgs 的路由逻辑（test:any /
// E2E_FORCE_ANON / 登录检测），所以含登录行为的录制会自动清 storageState。带不带浏览器
// 窗口由 #batch-run-headed 决定。chain 中任何一步失败即停止剩余步骤。
$('#btn-batch-run').addEventListener('click', async () => {
  if (!lastRecentList || lastRecentList.length === 0) {
    alert('当前录制目录没有可试跑的文件');
    return;
  }
  if (currentJob) {
    alert(`任务「${currentJob}」还在跑，请等结束或点停止。`);
    return;
  }
  // 按表格里的勾选过滤 —— 只跑勾选的行。顺序仍按 lastRecentList（即 UI 显示顺序）。
  const selectedPaths = new Set(
    $$('#recent-list li')
      .filter((li) => li.querySelector('.row-check')?.checked)
      .map((li) => li.dataset.path),
  );
  const selected = lastRecentList.filter((r) => selectedPaths.has(r.path));
  if (selected.length === 0) {
    alert('请先勾选要批量试跑的录制');
    return;
  }
  const headed = $('#batch-run-headed').checked;

  // 并行预检测每个 spec 是否含登录 —— 决定 E2E_FORCE_ANON 是否要带
  const loginFlags = await Promise.all(selected.map(async (r) => {
    try {
      const text = await invoke('read_spec_text', { path: r.path });
      return specSourceContainsLogin(text);
    } catch {
      return false;
    }
  }));

  const steps = selected.map((r, i) => {
    const norm = relToProjectRoot(r.path).replace(/\\/g, '/');
    const underTests = isUnderTests(norm);
    const isAnonNamed = /\.anon\.spec\.ts$/i.test(norm);
    const loginDetected = loginFlags[i];
    const forceAnyForLogin = loginDetected && !isAnonNamed;
    const useAnyConfig = !underTests || forceAnyForLogin;

    const args = useAnyConfig ? ['test:any', '--', norm] : ['test', '--', norm];
    if (headed) args.push('--headed');

    const env = {};
    if (useAnyConfig) {
      const slash = norm.lastIndexOf('/');
      const dir = slash >= 0 ? norm.slice(0, slash) : '.';
      env.E2E_SPEC_DIR = dir || '.';
    }
    if (headed) env.E2E_SPEC_HEADED = '1';
    if (forceAnyForLogin) env.E2E_FORCE_ANON = '1';

    return {
      label: r.name + (forceAnyForLogin ? ' [anon]' : ''),
      args,
      env: Object.keys(env).length ? env : null,
    };
  });

  // 启动 chain：复用 startJob 的 UI 切换逻辑，但显式入 batch-run 状态机
  batchRunState.active = true;
  batchRunState.paths = selected.map((r) => r.path);
  batchRunState.current = -1;
  clearAllRowStatuses();

  currentJob = 'batch-run';
  jobStatus.textContent = '运行中';
  jobStatus.className = 'pill pill-running';
  btnStop.disabled = false;
  enableAllActions(false);
  if (!$('.view[data-view="run"]').classList.contains('active')) {
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'run'));
    $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === 'run'));
  }
  appendLog('status', `批量试跑：${steps.length} 个录制${headed ? '（带窗口）' : '（无头）'}`);

  try {
    await invoke('run_pnpm_chain', { args: { job: 'batch-run', steps } });
  } catch (e) {
    appendLog('error', String(e));
    jobStatus.textContent = '错误';
    jobStatus.className = 'pill pill-error';
    btnStop.disabled = true;
    enableAllActions(true);
    currentJob = null;
    // chain 失败不要把行状态卡死在 running
    if (batchRunState.active && batchRunState.current >= 0) {
      setRowStatus(batchRunState.paths[batchRunState.current], 'fail');
    }
    batchRunState.active = false;
    batchRunState.paths = [];
    batchRunState.current = -1;
  }
});

$('#import-batch-confirm').addEventListener('click', async () => {
  const dir = ($('#import-batch-dir').value || '').trim();
  if (!dir) { alert('请选择导入目标目录'); return; }
  if (!lastRecentList || lastRecentList.length === 0) { closeBatchImportModal(); return; }
  if (currentJob) {
    alert(`任务「${currentJob}」还在跑，请等结束或点停止。`);
    return;
  }
  closeBatchImportModal();

  // 构造 chain：每个录制一步 import:rec。匹配上 SOP 的就带 --sop，否则不带。
  const steps = lastRecentList.map((r) => {
    const sop = sopFromRecordingName(r.name);
    const args = ['import:rec', '--', '--file', r.path, '--outDir', dir];
    if (sop) { args.push('--sop', sop); }
    return {
      label: sop ? `导入 ${r.name} → ${sop}` : `导入 ${r.name}（无 SOP）`,
      args,
    };
  });

  // 复用 run_pnpm_chain：失败一步即停（与 setup chain 行为一致），成功全部为终态
  currentJob = 'batch-import';
  jobStatus.textContent = '运行中';
  jobStatus.className = 'pill pill-running';
  btnStop.disabled = false;
  enableAllActions(false);
  // 切到运行测试面板看日志
  if (!$('.view[data-view="run"]').classList.contains('active')) {
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'run'));
    $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === 'run'));
  }
  appendLog('status', `批量导入：共 ${steps.length} 个文件 → ${dir}`);
  try {
    await invoke('run_pnpm_chain', { args: { job: 'batch-import', steps } });
  } catch (e) {
    appendLog('error', String(e));
    jobStatus.textContent = '错误';
    jobStatus.className = 'pill pill-error';
    btnStop.disabled = true;
    enableAllActions(true);
    currentJob = null;
  }
});

$('#btn-refresh-recent').addEventListener('click', loadRecentRecordings);

async function pickDirectory(defaultPath) {
  try {
    const selected = await pick.directory(defaultPath);
    return typeof selected === 'string' ? selected : null;
  } catch (e) { alert(String(e)); return null; }
}

$('#btn-pick-rec-dir').addEventListener('click', async () => {
  const p = await pickDirectory(resolvedRecordingsAbs || (lastEnv && lastEnv.project_root));
  if (p) $('#cfg-recordings-dir').value = p;
});
$('#btn-pick-imp-dir').addEventListener('click', async () => {
  const p = await pickDirectory(resolvedImportsAbs || (lastEnv && lastEnv.project_root));
  if (p) $('#cfg-imports-dir').value = p;
});

$('#btn-save-dirs').addEventListener('click', async () => {
  const hint = $('#dirs-save-hint');
  hint.textContent = '保存中…'; hint.className = 'muted';
  const cfg = {
    recordings_dir: $('#cfg-recordings-dir').value.trim() || null,
    imports_dir:    $('#cfg-imports-dir').value.trim()    || null,
  };
  try {
    await invoke('write_config', { cfg });
    await loadConfigAndDirs();
    hint.textContent = '已保存'; hint.className = 'muted saved-flash';
  } catch (e) {
    hint.textContent = '保存失败：' + e; hint.className = 'muted saved-err';
  }
});

$$('[data-open-dyn]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const which = btn.dataset.openDyn;
    let target = '';
    if (which === 'recordings') target = resolvedRecordingsAbs;
    else if (which === 'imports') target = resolvedImportsAbs;
    else if (which === 'project-root') target = (lastEnv && lastEnv.project_root) || '';
    if (!target) return alert('路径未就绪');
    try { await invoke('open_in_shell', { target }); } catch (e) { alert(String(e)); }
  });
});

$('#btn-record').addEventListener('click', () => {
  const name = $('#rec-name').value.trim();
  const path = $('#rec-path').value.trim() || '/';
  if (!name) { alert('请填一个用例名'); return; }
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '-');
  const recDir = ($('#cfg-recordings-dir').value || 'recordings').trim();
  // pnpm record -- --name <safe> --path <path> --outDir <dir>
  startJob(`record:${safe}`, `record -- --name ${safe} --path ${path} --outDir ${recDir}`);
});

$('#btn-pick-file').addEventListener('click', async () => {
  try {
    const selected = await pick.file(
      [{ name: 'Playwright spec', extensions: ['ts'] }],
      resolvedRecordingsAbs,
    );
    if (typeof selected === 'string') $('#imp-file').value = selected;
  } catch (e) {
    alert(String(e));
  }
});

$('#btn-import').addEventListener('click', () => {
  const file = $('#imp-file').value.trim();
  const sop  = $('#imp-sop').value;
  if (!file) { alert('请先选择录制文件'); return; }
  const impDir = ($('#cfg-imports-dir').value || 'tests/recorded').trim();
  // 用数组形式传 args，避免路径含空格被 startJob 的 .split(/\s+/) 切碎
  startJob(`import:${sop}`, ['import:rec', '--', '--file', file, '--sop', sop, '--outDir', impDir]);
});

// ---------- 项目路径卡片 ----------
async function loadProjectRootCard() {
  // 当前解析到的根
  const cur = (lastEnv && lastEnv.project_root) || '';
  $('#proj-root-current').value = cur;

  // 如果 input 没人改过，帮填当前根作为编辑起点（方便局部改）
  const input = $('#proj-root-input');
  if (!input.value || !input.dataset.touched) {
    input.value = cur;
  }

  // 模板可用性：只有打包过的安装包会 true；dev 模式默认 false
  try {
    const has = await invoke('template_available');
    $('#template-row').style.display = has ? '' : 'none';
    if (has) {
      const destInput = $('#template-dest');
      if (!destInput.value || !destInput.dataset.touched) {
        try {
          const def = await invoke('default_template_dest');
          destInput.value = def;
          destInput.placeholder = def;
        } catch {}
      }
    }
  } catch {
    $('#template-row').style.display = 'none';
  }
}

$('#proj-root-input').addEventListener('input', (e) => {
  e.target.dataset.touched = '1';
});

$('#btn-pick-proj').addEventListener('click', async () => {
  const cur = $('#proj-root-input').value || (lastEnv && lastEnv.project_root) || '';
  const p = await pickDirectory(cur);
  if (p) {
    $('#proj-root-input').value = p;
    $('#proj-root-input').dataset.touched = '1';
  }
});

$('#btn-save-proj').addEventListener('click', async () => {
  const hint = $('#proj-save-hint');
  const path = $('#proj-root-input').value.trim();
  if (!path) { hint.textContent = '请先选一个目录'; hint.className = 'muted saved-err'; return; }
  hint.textContent = '保存中…'; hint.className = 'muted';
  try {
    await invoke('set_project_root', { path });
    hint.textContent = '已保存 — 重新扫描环境'; hint.className = 'muted saved-flash';
    $('#proj-root-input').dataset.touched = '';
    // 项目根变了 — 全面刷新
    await loadEnv();
    await loadEnvForm();
    await loadConfigAndDirs();
    await loadProjectRootCard();
  } catch (e) {
    hint.textContent = '保存失败：' + e; hint.className = 'muted saved-err';
  }
});

$('#btn-clear-proj').addEventListener('click', async () => {
  const hint = $('#proj-save-hint');
  hint.textContent = '清除中…'; hint.className = 'muted';
  try {
    await invoke('clear_project_root');
    hint.textContent = '已清除，将按自动规则再次扫描'; hint.className = 'muted saved-flash';
    $('#proj-root-input').dataset.touched = '';
    await loadEnv();
    await loadEnvForm();
    await loadConfigAndDirs();
    await loadProjectRootCard();
  } catch (e) {
    hint.textContent = '清除失败：' + e; hint.className = 'muted saved-err';
  }
});

$('#template-dest')?.addEventListener('input', (e) => {
  e.target.dataset.touched = '1';
});

$('#btn-pick-template-dest')?.addEventListener('click', async () => {
  const cur = $('#template-dest').value || '';
  const p = await pickDirectory(cur);
  if (p) {
    $('#template-dest').value = p;
    $('#template-dest').dataset.touched = '1';
  }
});

$('#btn-reset-template-dest')?.addEventListener('click', async () => {
  try {
    const def = await invoke('default_template_dest');
    $('#template-dest').value = def;
    $('#template-dest').dataset.touched = '';
  } catch (e) { alert(String(e)); }
});

$('#btn-extract-template').addEventListener('click', async () => {
  const hint = $('#template-hint');
  const dest = $('#template-dest').value.trim();
  const force = $('#template-force').checked;
  hint.textContent = '解压中（第一次约 1–3 秒）…'; hint.className = 'muted';
  try {
    const path = await invoke('extract_template', {
      destDir: dest || null,
      force,
    });
    hint.textContent = '已解压到：' + path;
    hint.className = 'muted saved-flash';
    // 解压后重置"强制覆盖"，避免下一次误点
    $('#template-force').checked = false;
    // 使用它作为项目根
    await loadEnv();
    await loadEnvForm();
    await loadConfigAndDirs();
    await loadProjectRootCard();
  } catch (e) {
    hint.textContent = '解压失败：' + e;
    hint.className = 'muted saved-err';
  }
});

// ---------- .env.local 表单 ----------
async function loadEnvForm() {
  try {
    const data = await invoke('read_env_local');
    const keys = await invoke('env_keys');
    for (const key of keys) {
      const el = document.getElementById('env-' + key);
      if (el) el.value = data[key] || '';
    }
  } catch (e) {
    // 项目找不到等 — 静默，由 dashboard 的 no-project-card 处理
  }
}

$$('.toggle-pw').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    if (input.type === 'password') { input.type = 'text'; btn.textContent = '隐藏'; }
    else                            { input.type = 'password'; btn.textContent = '显示'; }
  });
});

$('#btn-save-env').addEventListener('click', async () => {
  const hint = $('#env-save-hint');
  hint.textContent = '保存中…'; hint.className = 'muted';
  try {
    const keys = await invoke('env_keys');
    const updates = {};
    for (const key of keys) {
      const el = document.getElementById('env-' + key);
      if (!el) continue;
      updates[key] = el.value;
    }
    await invoke('write_env_local', { updates });
    hint.textContent = '已写入 .env.local'; hint.className = 'muted saved-flash';
    loadEnv();
  } catch (e) {
    hint.textContent = '保存失败：' + e; hint.className = 'muted saved-err';
  }
});

$('#btn-reload-env').addEventListener('click', loadEnvForm);

// ---------- 文档 ----------
async function loadDocsList() {
  try {
    const list = await invoke('list_docs');
    const ul = $('#doc-list');
    ul.innerHTML = list
      .map((d) => `<li data-name="${d.name}"><strong>${d.title}</strong><div class="muted" style="font-size:11px">${d.name}</div></li>`)
      .join('');
    $$('#doc-list li').forEach((li) => {
      li.addEventListener('click', () => openDoc(li.dataset.name, li));
    });
    if (list.length && !$('.doc-list li.active')) {
      openDoc(list[0].name, $('#doc-list li'));
    }
  } catch (e) {
    $('#doc-list').innerHTML = `<li class="muted">读取失败：${e}</li>`;
  }
}

async function openDoc(name, li) {
  $$('#doc-list li').forEach((x) => x.classList.toggle('active', x === li));
  try {
    const md = await invoke('read_doc', { name });
    $('#doc-content').innerHTML = renderMarkdown(md);
  } catch (e) {
    $('#doc-content').innerHTML = `<p class="muted">读取失败：${e}</p>`;
  }
}

// 最小 Markdown 渲染器：标题、代码块、内联代码、加粗、斜体、链接、列表、表格、引用、水平线、段落。
function renderMarkdown(src) {
  // 先抽出代码块，避免后续被转义/破坏
  const fences = [];
  src = src.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    fences.push({ lang, code });
    return ` FENCE${fences.length - 1} `;
  });

  const lines = src.split(/\r?\n/);
  const out = [];
  let i = 0;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  while (i < lines.length) {
    const startI = i;
    let line = lines[i];

    // 水平线
    if (/^\s*---+\s*$/.test(line)) { out.push('<hr/>'); i++; continue; }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${inline(esc(h[2]))}</h${h[1].length}>`); i++; continue; }

    // 表格（必须有 header + 分隔符两行）
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:\-|]+\|?\s*$/.test(lines[i+1])) {
      const headers = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push('<table><thead><tr>' +
        headers.map((h) => `<th>${inline(esc(h))}</th>`).join('') +
        '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(esc(c))}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>');
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inline(esc(buf.join(' ')))}</blockquote>`);
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push('<ol>' + items.map((it) => `<li>${inline(esc(it))}</li>`).join('') + '</ol>');
      continue;
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      out.push('<ul>' + items.map((it) => `<li>${inline(esc(it))}</li>`).join('') + '</ul>');
      continue;
    }

    // 空行
    if (!line.trim()) { i++; continue; }

    // 段落：收集连续非空非特殊行
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#|```|>|\s*[-*+]\s+|\s*\d+\.\s+|---)/.test(lines[i])) {
      // 下一行看起来像"合法表格开头"（当前行像行 + 下一行是分隔符），就把流程让给表格处理器
      const maybeTable = /^\s*\|.*\|\s*$/.test(lines[i])
        && i + 1 < lines.length
        && /^\s*\|?[\s:\-|]+\|?\s*$/.test(lines[i+1]);
      if (maybeTable) break;
      para.push(lines[i]);
      i++;
    }
    if (para.length) {
      out.push(`<p>${inline(esc(para.join(' ')))}</p>`);
      continue;
    }

    // 安全网：走到这里说明没有任何分支消费了当前行 —— 作为普通文本兜底，强制前进一行
    if (line.trim()) out.push(`<p>${inline(esc(line))}</p>`);
    i++;
    if (i === startI) { i = startI + 1; } // 最后一道保险，杜绝死循环
  }

  // 代码块还原
  let html = out.join('\n');
  html = html.replace(/ FENCE(\d+) /g, (_, idx) => {
    const f = fences[+idx];
    return `<pre><code class="language-${f.lang}">${esc(f.code)}</code></pre>`;
  });
  return html;

  function splitRow(l) {
    return l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  }

  function inline(s) {
    // 内联代码
    s = s.replace(/`([^`\n]+?)`/g, (_, c) => `<code>${c}</code>`);
    // 加粗：**text**
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    // 斜体：简化版，不使用回溯风险高的 lookaround；只匹配 *text*，不跨行
    s = s.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
    // 链接
    s = s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
    return s;
  }
}

// ---------- 启动 ----------
window.addEventListener('DOMContentLoaded', async () => {
  await loadEnv();
  await loadProjectRootCard();
  await loadEnvForm();
  await loadConfigAndDirs();
  try {
    const active = await invoke('active_jobs');
    if (active && active.length) {
      currentJob = active[0];
      jobStatus.textContent = `恢复任务：${currentJob}`;
      jobStatus.className = 'pill pill-running';
      btnStop.disabled = false;
      enableAllActions(false);
    }
  } catch {}
});
