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
async function loadEnv() {
  const env = await invoke('env_info');
  lastEnv = env;
  const cards = $('#env-cards');
  const row = (label, ok, text, hint) => `
    <div class="env-card">
      <div class="label">${label}</div>
      <div class="value"><span class="dot ${ok ? 'ok' : 'bad'}"></span>${text}</div>
      ${hint ? `<div class="muted tight">${hint}</div>` : ''}
    </div>`;
  cards.innerHTML = [
    row('项目路径', env.project_root_found, env.project_root_found ? `<code>${env.project_root}</code>` : '未找到', env.project_root_found ? '' : '见上方「没找到 e2e 项目目录」提示'),
    row('运行平台', true, env.platform),
    row('pnpm 路径', env.pnpm_hint ? true : env.platform === 'windows', env.pnpm_hint ? `<code>${env.pnpm_hint}</code>` : (env.platform === 'windows' ? '由 PATH 解析' : '未找到'), env.pnpm_hint || env.platform === 'windows' ? '' : 'Mac/Linux：请先装 Node.js + pnpm（推荐 <code>brew install pnpm</code>）'),
    row('node_modules', env.node_modules_installed, env.node_modules_installed ? '已安装' : '未安装', env.node_modules_installed ? '' : '点上方「一键准备测试环境」'),
    row('Playwright 浏览器', env.playwright_installed, env.playwright_installed ? '已就绪' : '未安装', env.playwright_installed ? '' : '点上方「一键准备测试环境」'),
    row('.env.local', env.env_local_exists, env.env_local_exists ? '已配置' : '缺失', env.env_local_exists ? '' : '从 <code>.env.example</code> 复制并填测试账号'),
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

listen('job-log', (event) => {
  const { job, kind, line } = event.payload;
  if (currentJob && job !== currentJob) return; // 只显示当前关注的任务
  appendLog(kind, line);
  if (kind === 'status' && line.startsWith('任务')) {
    const success = line.includes('成功');
    jobStatus.textContent = success ? '成功' : line.includes('退出码') ? '结束' : '空闲';
    jobStatus.className = 'pill ' + (success ? 'pill-idle' : 'pill-error');
    btnStop.disabled = true;
    enableAllActions(true);
    const finishedJob = currentJob;
    currentJob = null;
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

/** 构建运行测试文件所需的 pnpm args + env。
 * 在 tests/ 下 → `pnpm test -- <relpath>` （用主配置，完整 reporters）
 * 不在 tests/ 下 → `pnpm test:any -- <relpath>` + E2E_SPEC_DIR=<dir>（衍生配置，保登录）
 */
function buildSpecArgs() {
  const file = $('#spec-file').value.trim();
  if (!file) return null;
  const rel = relToProjectRoot(file);
  const norm = normalizeSeparators(rel);
  const underTests = isUnderTests(norm);

  const args = underTests ? ['test', '--', norm] : ['test:any', '--', norm];
  const headed = $('#spec-headed').checked;
  if (headed) args.push('--headed');
  if ($('#spec-ui').checked) args.push('--ui');
  if ($('#spec-debug').checked) args.push('--debug');
  const grep = $('#spec-grep').value.trim();
  if (grep) { args.push('--grep', grep); }

  const env = {};
  if (!underTests) {
    // E2E_SPEC_DIR 只需目录即可，playwright testDir 设成此
    const slash = norm.lastIndexOf('/');
    const dir = slash >= 0 ? norm.slice(0, slash) : '.';
    env.E2E_SPEC_DIR = dir || '.';
  }
  // 保险：除 CLI --headed 外，同时用 env 让 playwright.any.config 覆盖 headless + slowMo
  // （CLI --headed 在某些 pnpm/shell 组合里可能被吞，env 是更可靠的入口）
  if (headed) env.E2E_SPEC_HEADED = '1';
  return { args, rel: norm, underTests, env };
}

function refreshSpecPreview() {
  const built = buildSpecArgs();
  if (!built) { $('#spec-cmd-preview').textContent = ''; $('#spec-warn').textContent = ''; return; }
  const envStr = Object.keys(built.env).length
    ? Object.entries(built.env).map(([k, v]) => `${k}=${v}`).join(' ') + ' '
    : '';
  $('#spec-cmd-preview').textContent = '$ ' + envStr + 'pnpm ' + built.args.map((a) => a.includes(' ') ? `"${a}"` : a).join(' ');
  const hint = $('#spec-warn');
  if (!built.underTests) {
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

$('#btn-run-spec').addEventListener('click', () => {
  const built = buildSpecArgs();
  if (!built) { alert('请先选择一个测试文件'); return; }
  // 用文件名做 job id，防冲突
  const base = built.rel.split('/').pop().replace(/\.spec\.ts$/, '');
  startJob(`spec:${base}`, built.args, Object.keys(built.env).length ? built.env : null);
});

/** 公共函数：跑某个 spec 文件（被"最近录制"的"立即试跑"按钮调用） */
function runSpecByPath(absPath, headed = false) {
  $('#spec-file').value = absPath;
  $('#spec-headed').checked = !!headed;
  $('#spec-ui').checked = false;
  $('#spec-debug').checked = false;
  $('#spec-grep').value = '';
  refreshSpecPreview();
  const built = buildSpecArgs();
  if (!built) return;
  const base = built.rel.split('/').pop().replace(/\.spec\.ts$/, '');
  startJob(`spec:${base}`, built.args, Object.keys(built.env).length ? built.env : null);
}

// ---------- 首次环境向导：一键 install + install-browsers ----------
async function startSetup() {
  if (currentJob) {
    alert(`任务「${currentJob}」还在跑，请等结束或点停止。`);
    return;
  }
  currentJob = 'setup';
  jobStatus.textContent = '运行中';
  jobStatus.className = 'pill pill-running';
  btnStop.disabled = false;
  enableAllActions(false);
  // 切到 Run 面板可以看到流式日志
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === 'run'));
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === 'run'));

  const steps = [];
  if (!lastEnv || !lastEnv.node_modules_installed) {
    steps.push({ label: '安装 JS 依赖 (pnpm install)', args: ['install'] });
  }
  // 浏览器层永远保险跑一次（幂等 — 已装过 Playwright 会直接跳过）
  steps.push({ label: '安装 Playwright 浏览器 (chromium)', args: ['install-browsers'] });

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

$('#btn-setup').addEventListener('click', startSetup);

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

async function loadRecentRecordings() {
  const ul = $('#recent-list');
  const card = $('#recent-card');
  try {
    const list = await invoke('list_recordings', { limit: 10 });
    if (!list || list.length === 0) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';
    ul.innerHTML = list.map((r) => `
      <li data-path="${r.path}">
        <div class="meta">
          <div class="file" title="${r.relative}">${r.name}</div>
          <div class="when">${formatSince(r.modified_ms)} · ${r.relative}</div>
        </div>
        <button class="primary" data-action="run">立即试跑</button>
        <button data-action="run-headed" title="带浏览器窗口可见跑">带窗口</button>
      </li>
    `).join('');
    $$('#recent-list li').forEach((li) => {
      const path = li.dataset.path;
      li.querySelector('[data-action="run"]').addEventListener('click', () => runSpecByPath(path, false));
      li.querySelector('[data-action="run-headed"]').addEventListener('click', () => runSpecByPath(path, true));
    });
  } catch (e) {
    card.style.display = 'none';
  }
}

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
  startJob(`import:${sop}`, `import -- --file ${file} --sop ${sop} --outDir ${impDir}`);
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

$('#btn-extract-template').addEventListener('click', async () => {
  const hint = $('#template-hint');
  hint.textContent = '解压中（第一次约 1–3 秒）…'; hint.className = 'muted';
  try {
    const path = await invoke('extract_template', { force: false });
    hint.textContent = '已解压到：' + path;
    hint.className = 'muted saved-flash';
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
