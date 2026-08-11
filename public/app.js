const HISTORY_KEY = 'whistle-mock-case-history-v1';

function apiUrl(path) {
  return String(path || '').replace(/^\//, '');
}

const state = {
  config: null,
  mode: 'standalone',
  roots: [],
  expanded: new Set(),
  selectedPath: null,
  activePath: null,
  /** @type {Record<string, string>} apiName -> base-data file path */
  activeFiles: {},
  detail: null,
  treeFilter: '',
  leafTotal: 0,
  busy: false,
  /** 预览跳转历史（Ctrl+点击 import / 树节点） */
  nav: {
    stack: [],
    index: -1,
    navigating: false,
  },
  /** 文件编辑器状态 */
  fileEditor: {
    path: null,
    original: '',
    editing: false,
    dirty: false,
  },
};

function isFileMockActive(relPath) {
  return Object.values(state.activeFiles || {}).includes(relPath);
}

function isNodeMockActive(node) {
  if (!node) return false;
  if (node.type === 'file' || node.mockKind === 'file') {
    return isFileMockActive(node.path);
  }
  return state.activePath === node.path;
}

const $ = (id) => document.getElementById(id);

async function api(path, options) {
  const res = await fetch(apiUrl(path), {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `请求失败 ${res.status}`);
  }
  return data;
}

function setMsg(text, type) {
  const el = $('applyMsg');
  el.textContent = text || '';
  el.className = `msg ${type || ''}`;
}

function emptyStateHtml({ title, desc, icon = 'folder' }) {
  const icons = {
    folder: `<path d="M4 7.5A2.5 2.5 0 016.5 5h11A2.5 2.5 0 0120 7.5v9a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 014 16.5v-9z" stroke="currentColor" stroke-width="1.6"/><path d="M8 9h8M8 12.5h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
    search: `<circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.6"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
    alert: `<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.6"/><path d="M12 8v5M12 15.5v.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>`,
  };
  return `<div class="empty-state">
    <div class="empty-icon" aria-hidden="true">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none">${icons[icon] || icons.folder}</svg>
    </div>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(desc)}</p>
  </div>`;
}

function openHelp() {
  const el = $('helpOverlay');
  if (!el) return;
  el.hidden = false;
}

function closeHelp() {
  const el = $('helpOverlay');
  if (!el) return;
  el.hidden = true;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function updateToggleButton() {
  const btn = $('btnToggle');
  const d = state.detail;
  const isCase = d && d.type === 'case' && d.selectable;
  const isFileMock = d && d.type === 'file' && d.selectable && d.mockKind === 'file';

  if (!state.selectedPath || (!isCase && !isFileMock)) {
    btn.disabled = true;
    btn.classList.remove('danger');
    btn.textContent = '请勾选用例文件夹或 base-data JSON';
    return;
  }

  btn.disabled = state.busy;
  if (isFileMock) {
    if (isFileMockActive(state.selectedPath)) {
      btn.textContent = '取消此 JSON mock';
      btn.classList.add('danger');
    } else {
      btn.textContent = `启用 mock · ${d.apiName}`;
      btn.classList.remove('danger');
    }
    return;
  }

  if (state.activePath === state.selectedPath) {
    btn.textContent = '取消勾选（清除 Rules / Values）';
    btn.classList.add('danger');
  } else {
    btn.textContent = '勾选启用此用例';
    btn.classList.remove('danger');
  }
}

async function refreshStatus() {
  const data = await api('/api/status');
  state.mode = data.mode || state.mode || 'standalone';
  document.body.classList.toggle('mode-plugin', state.mode === 'plugin');
  $('modeBadge').textContent = state.mode === 'plugin' ? '插件模式' : '独立模式';

  const running = !!data.runningByHttp || !!data.running;
  $('w2Dot').className = `dot ${running ? 'on' : 'off'}`;
  $('w2Label').textContent = running
    ? `Whistle 运行中 · ${data.whistleHost}:${data.whistlePort}`
    : 'Whistle 未运行';
  $('proxyAddress').textContent = data.proxyAddress || '-';
  $('whistleUiLink').href = data.uiUrl || '#';
  return data;
}

async function loadActive() {
  try {
    const data = await api('/api/cases/active');
    state.activePath = (data.active && data.active.path) || null;
    const map = {};
    for (const f of data.files || []) {
      if (f && f.apiName && f.path) map[f.apiName] = f.path;
    }
    state.activeFiles = map;
  } catch (_) {
    state.activePath = null;
    state.activeFiles = {};
  }
  renderTree();
  updateToggleButton();
}

async function loadConfig() {
  state.config = await api('/api/config');
  state.mode = state.config.mode || 'standalone';
  document.body.classList.toggle('mode-plugin', state.mode === 'plugin');
  $('modeBadge').textContent = state.mode === 'plugin' ? '插件模式' : '独立模式';
  await loadRuleGroups();
}

function closeRuleGroupMenu() {
  const wrap = $('ruleGroupSelect');
  const menu = $('ruleGroupMenu');
  const trigger = $('ruleGroupTrigger');
  if (!wrap || !menu || !trigger) return;
  wrap.classList.remove('is-open');
  menu.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
}

function openRuleGroupMenu() {
  const wrap = $('ruleGroupSelect');
  const menu = $('ruleGroupMenu');
  const trigger = $('ruleGroupTrigger');
  if (!wrap || !menu || !trigger) return;
  wrap.classList.add('is-open');
  menu.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
}

function renderRuleGroupUI(names, current) {
  const sel = $('ruleGroup');
  const menu = $('ruleGroupMenu');
  const valueEl = $('ruleGroupValue');
  if (!sel || !menu || !valueEl) return;

  sel.innerHTML = names
    .map(
      (name) =>
        `<option value="${escapeHtml(name)}"${
          name === current ? ' selected' : ''
        }>${escapeHtml(name)}</option>`
    )
    .join('');
  sel.value = current;
  valueEl.textContent = current;

  menu.innerHTML = names
    .map(
      (name) =>
        `<li class="nice-select-option${
          name === current ? ' is-active' : ''
        }" role="option" data-value="${escapeHtml(name)}" aria-selected="${
          name === current ? 'true' : 'false'
        }">${escapeHtml(name)}</li>`
    )
    .join('');
}

async function loadRuleGroups() {
  let groups = [{ name: 'Default', isDefault: true }];
  let current = (state.config && state.config.ruleGroup) || 'Default';
  try {
    const data = await api('/api/rules/groups');
    if (data.groups && data.groups.length) groups = data.groups;
    if (data.ruleGroup) current = data.ruleGroup;
  } catch (_) {
    // Whistle 未就绪时仍提供 Default
  }

  const names = [];
  const seen = new Set();
  for (const g of groups) {
    const name = g.name || g;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  if (!seen.has('Default')) names.unshift('Default');
  else {
    names.splice(names.indexOf('Default'), 1);
    names.unshift('Default');
  }
  if (!names.includes(current)) names.push(current);

  renderRuleGroupUI(names, current);
  if (state.config) state.config.ruleGroup = current;
  closeRuleGroupMenu();
}

async function setRuleGroup(name) {
  if (!name) return;
  try {
    const data = await api('/api/rules/group', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    const next = data.ruleGroup || name;
    if (state.config) state.config.ruleGroup = next;
    const sel = $('ruleGroup');
    if (sel) sel.value = next;
    const valueEl = $('ruleGroupValue');
    if (valueEl) valueEl.textContent = next;
    $('ruleGroupMenu')
      ?.querySelectorAll('.nice-select-option')
      .forEach((el) => {
        const on = el.getAttribute('data-value') === next;
        el.classList.toggle('is-active', on);
        el.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    closeRuleGroupMenu();
    setMsg(`规则组已切换为 ${next}`, 'ok');
  } catch (e) {
    setMsg(e.message, 'err');
    await loadRuleGroups();
  }
}

function bindRuleGroupSelect() {
  const wrap = $('ruleGroupSelect');
  const trigger = $('ruleGroupTrigger');
  const menu = $('ruleGroupMenu');
  if (!wrap || !trigger || !menu || wrap.dataset.bound) return;
  wrap.dataset.bound = '1';

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (wrap.classList.contains('is-open')) closeRuleGroupMenu();
    else openRuleGroupMenu();
  });

  menu.addEventListener('click', (e) => {
    const opt = e.target.closest('.nice-select-option');
    if (!opt) return;
    e.stopPropagation();
    setRuleGroup(opt.getAttribute('data-value'));
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) closeRuleGroupMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeRuleGroupMenu();
  });
}

function nodeMatches(node, q) {
  if (!q) return true;
  const hay = `${node.name} ${node.path} ${node.mockId || ''} ${(node.mockIds || []).join(' ')}`.toLowerCase();
  if (hay.includes(q)) return true;
  return (node.children || []).some((c) => nodeMatches(c, q));
}

function isFileNode(node) {
  return node && node.type === 'file';
}

function findNodeByPath(nodes, relPath) {
  for (const node of nodes || []) {
    if (node.path === relPath) return node;
    const hit = findNodeByPath(node.children, relPath);
    if (hit) return hit;
  }
  return null;
}

function normalizeProjectPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

/** 相对 import 解析为项目内路径 */
function resolveImportPath(fromFile, importPath) {
  const raw = String(importPath || '').trim();
  if (!raw || raw.startsWith('http') || raw.startsWith('node:')) return null;
  if (!(raw.startsWith('.') || raw.startsWith('/'))) return null;

  const from = normalizeProjectPath(fromFile);
  const baseParts = from.split('/').slice(0, -1);
  const segs = raw.replace(/\\/g, '/').split('/');
  for (const seg of segs) {
    if (!seg || seg === '.') continue;
    if (seg === '..') baseParts.pop();
    else baseParts.push(seg);
  }
  return normalizeProjectPath(baseParts.join('/'));
}

/** 识别 testhub.mock.config.json 等里的用例目录 path */
function looksLikeProjectPath(str) {
  const s = normalizeProjectPath(str);
  if (!s || s.length < 2) return false;
  if (/^(https?:|node:|data:)/i.test(s)) return false;
  if (s.startsWith('.') || s.startsWith('/')) return false;

  const roots = (state.config && state.config.caseRoots) || [];
  if (roots.some((r) => s === r || s.startsWith(`${r}/`))) return true;
  if (s === 'base-data' || s.startsWith('base-data/')) return true;
  // 兼容 config 里其它仓库相对目录（含中文路径）
  if (s.includes('/') && /[\u4e00-\u9fff]/.test(s)) return true;
  return false;
}

/** import 相对路径，或配置里的项目内 path */
function resolveClickablePath(fromFile, str) {
  const imported = resolveImportPath(fromFile, str);
  if (imported) return imported;
  if (looksLikeProjectPath(str)) return normalizeProjectPath(str);
  return null;
}

function renderPathLink(path, displayText) {
  return `<a class="code-import-link" href="#" data-path="${escapeHtml(
    path
  )}" title="Ctrl/⌘ + 点击跳转到目录/文件">${escapeHtml(
    displayText != null ? displayText : path
  )}</a>`;
}

function detectLanguage(filePath) {
  const name = String(filePath || '').toLowerCase();
  if (name.endsWith('.json')) return 'json';
  if (/\.(ts|tsx|js|jsx|mjs|cjs|mock\.ts)$/.test(name)) return 'ts';
  if (name.endsWith('.md')) return 'md';
  return 'text';
}

const TS_KEYWORDS = new Set([
  'import',
  'export',
  'from',
  'default',
  'as',
  'const',
  'let',
  'var',
  'function',
  'return',
  'async',
  'await',
  'if',
  'else',
  'for',
  'while',
  'of',
  'in',
  'new',
  'class',
  'extends',
  'type',
  'interface',
  'true',
  'false',
  'null',
  'undefined',
  'typeof',
  'void',
  'this',
]);

function isImportPathString(line, quoteIndex) {
  const before = line.slice(0, quoteIndex);
  return /\bfrom\s*$/.test(before) || /\bimport\s*$/.test(before);
}

function renderCodeTokens(line, language, currentFilePath) {
  if (language === 'json') return renderJsonLine(line);
  if (language !== 'ts') return escapeHtml(line);

  let i = 0;
  let out = '';
  while (i < line.length) {
    // line comment
    if (line[i] === '/' && line[i + 1] === '/') {
      out += `<span class="tok-comment">${escapeHtml(line.slice(i))}</span>`;
      break;
    }
    // string
    if (line[i] === "'" || line[i] === '"' || line[i] === '`') {
      const quote = line[i];
      let j = i + 1;
      let escaped = false;
      while (j < line.length) {
        if (escaped) {
          escaped = false;
          j += 1;
          continue;
        }
        if (line[j] === '\\') {
          escaped = true;
          j += 1;
          continue;
        }
        if (line[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      const raw = line.slice(i, j);
      const inner = raw.slice(1, -1);
      const canImport = isImportPathString(line, i);
      const target = canImport
        ? resolveImportPath(currentFilePath, inner)
        : resolveClickablePath(currentFilePath, inner);
      if (target) {
        out += `<span class="tok-string"><span class="tok-quote">${quote}</span>${renderPathLink(
          target,
          inner
        )}<span class="tok-quote">${quote}</span></span>`;
      } else {
        out += `<span class="tok-string">${escapeHtml(raw)}</span>`;
      }
      i = j;
      continue;
    }
    // number
    if (/[0-9]/.test(line[i])) {
      let j = i + 1;
      while (j < line.length && /[0-9._xXa-fA-F]/.test(line[j])) j += 1;
      out += `<span class="tok-number">${escapeHtml(line.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // ident / keyword
    if (/[A-Za-z_$]/.test(line[i])) {
      let j = i + 1;
      while (j < line.length && /[A-Za-z0-9_$]/.test(line[j])) j += 1;
      const word = line.slice(i, j);
      const cls = TS_KEYWORDS.has(word) ? 'tok-keyword' : 'tok-ident';
      out += `<span class="${cls}">${escapeHtml(word)}</span>`;
      i = j;
      continue;
    }
    // punctuation / other
    let j = i + 1;
    while (
      j < line.length &&
      !/[A-Za-z0-9_$'"`]/.test(line[j]) &&
      !(line[j] === '/' && line[j + 1] === '/')
    ) {
      j += 1;
    }
    out += `<span class="tok-punct">${escapeHtml(line.slice(i, j))}</span>`;
    i = j;
  }
  return out;
}

function renderJsonLine(line) {
  let i = 0;
  let out = '';

  while (i < line.length) {
    if (/\s/.test(line[i])) {
      let j = i + 1;
      while (j < line.length && /\s/.test(line[j])) j += 1;
      out += escapeHtml(line.slice(i, j));
      i = j;
      continue;
    }

    if (line[i] === '"' || line[i] === "'") {
      const quote = line[i];
      let j = i + 1;
      let escaped = false;
      while (j < line.length) {
        if (escaped) {
          escaped = false;
          j += 1;
          continue;
        }
        if (line[j] === '\\') {
          escaped = true;
          j += 1;
          continue;
        }
        if (line[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      const raw = line.slice(i, j);
      const inner = raw.slice(1, -1);
      const after = line.slice(j).match(/^\s*:/);
      if (after) {
        out += `<span class="tok-key">${escapeHtml(raw)}</span>`;
      } else {
        const target = resolveClickablePath('', inner);
        if (target) {
          out += `<span class="tok-string"><span class="tok-quote">${quote}</span>${renderPathLink(
            target,
            inner
          )}<span class="tok-quote">${quote}</span></span>`;
        } else {
          out += `<span class="tok-string">${escapeHtml(raw)}</span>`;
        }
      }
      i = j;
      continue;
    }

    if (line[i] === ':') {
      out += `<span class="tok-punct">:</span>`;
      i += 1;
      continue;
    }

    if (/[0-9\-]/.test(line[i])) {
      let j = i + 1;
      while (j < line.length && /[0-9.eE+\-]/.test(line[j])) j += 1;
      out += `<span class="tok-number">${escapeHtml(line.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    if (/[a-z]/.test(line[i])) {
      let j = i + 1;
      while (j < line.length && /[a-z]/.test(line[j])) j += 1;
      const word = line.slice(i, j);
      if (word === 'true' || word === 'false' || word === 'null') {
        out += `<span class="tok-keyword">${word}</span>`;
      } else {
        out += escapeHtml(word);
      }
      i = j;
      continue;
    }

    out += `<span class="tok-punct">${escapeHtml(line[i])}</span>`;
    i += 1;
  }

  return out;
}

function buildCodeLayers(text, filePath) {
  const language = detectLanguage(filePath);
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const gutter = lines
    .map((_, idx) => `<div class="gutter-line">${idx + 1}</div>`)
    .join('');
  const highlight = lines
    .map((line) => {
      const code = renderCodeTokens(line, language, filePath);
      return `<div class="code-hl-line">${code || ' '}</div>`;
    })
    .join('');
  return { gutter, highlight, lineCount: lines.length };
}

function buildEditorActionsHtml(editable, editing, dirty) {
  if (!editable) return '';
  if (editing) {
    return `<div class="code-actions">
      <button type="button" class="btn ghost compact" id="btnCancelEdit">取消</button>
      <button type="button" class="btn primary compact code-save-btn" id="btnSaveFile" ${
        dirty ? '' : 'disabled'
      }>保存</button>
    </div>`;
  }
  return `<div class="code-actions">
    <button type="button" class="btn secondary compact" id="btnStartEdit">编辑</button>
  </div>`;
}

function buildCodeEditorHtml(content, filePath, options = {}) {
  const editable = !!options.editable;
  const editing = !!options.editing;
  const dirty = !!options.dirty;
  const text = String(content || '').replace(/\r\n/g, '\n');
  const layers = buildCodeLayers(text, filePath);

  const modHint = navigator.platform.toLowerCase().includes('mac')
    ? '⌘'
    : 'Ctrl';

  const hint = editing
    ? `编辑中 · ${modHint}+S 保存`
    : editable
      ? `${modHint}+点击跳转 · 点编辑修改`
      : `${modHint}+点击跳转 · ← 返回`;

  return `<div class="code-editor${editing ? ' is-editing' : ''}${
    dirty ? ' is-dirty' : ''
  }" data-file="${escapeHtml(filePath)}" data-editable="${
    editable ? '1' : '0'
  }">
    <div class="code-editor-bar">
      <div class="code-tabs">
        <span class="code-tab active" id="codeTabLabel">${escapeHtml(
          filePath.split('/').pop() || filePath
        )}${dirty ? ' •' : ''}</span>
      </div>
      <span class="code-hint" id="codeHint">${hint}</span>
      <div id="codeActions">${buildEditorActionsHtml(
        editable,
        editing,
        dirty
      )}</div>
    </div>
    <div class="code-editor-stage" id="codeStage">
      <div class="code-row">
        <div class="code-gutter" id="codeGutter">${layers.gutter}</div>
        <div class="code-pane">
          <pre class="code-highlight" id="codeHighlight">${
            layers.highlight
          }</pre>
          <textarea
            class="code-editor-input"
            id="codeEditorInput"
            spellcheck="false"
            autocomplete="off"
            autocapitalize="off"
            ${editing ? '' : 'readonly tabindex="-1"'}
          >${escapeHtml(text)}</textarea>
        </div>
      </div>
    </div>
  </div>`;
}

function syncCodeEditorHeight() {
  const highlight = $('codeHighlight');
  const input = $('codeEditorInput');
  if (!highlight || !input) return;
  const h = Math.max(highlight.scrollHeight, 360);
  input.style.height = `${h}px`;
}

function refreshCodeHighlight(text, filePath) {
  const layers = buildCodeLayers(text, filePath);
  const gutter = $('codeGutter');
  const highlight = $('codeHighlight');
  if (gutter) gutter.innerHTML = layers.gutter;
  if (highlight) highlight.innerHTML = layers.highlight;
  syncCodeEditorHeight();
}

function updateEditorChrome() {
  const editor = document.querySelector('.code-editor');
  if (!editor || !state.detail) return;
  const modHint = navigator.platform.toLowerCase().includes('mac')
    ? '⌘'
    : 'Ctrl';
  const editing = state.fileEditor.editing;
  const dirty = state.fileEditor.dirty;
  const editable = !!state.detail.editable;
  editor.classList.toggle('is-editing', editing);
  editor.classList.toggle('is-dirty', dirty);

  const tab = $('codeTabLabel');
  const hint = $('codeHint');
  const actions = $('codeActions');
  const input = $('codeEditorInput');
  const base = state.detail.name || 'file';
  if (tab) tab.textContent = dirty ? `${base} •` : base;
  if (hint) {
    hint.textContent = editing
      ? `编辑中 · ${modHint}+S 保存`
      : editable
        ? `${modHint}+点击跳转 · 点编辑修改`
        : `${modHint}+点击跳转 · ← 返回`;
  }
  if (actions) {
    const needEditBtn = editing && !actions.querySelector('#btnSaveFile');
    const needViewBtn = !editing && !actions.querySelector('#btnStartEdit');
    if (needEditBtn || needViewBtn || !actions.innerHTML.trim()) {
      actions.innerHTML = buildEditorActionsHtml(editable, editing, dirty);
      bindFileEditorButtons(actions);
    } else {
      const save = actions.querySelector('#btnSaveFile');
      if (save) save.disabled = !dirty;
    }
  }
  if (input) {
    if (editing) {
      input.removeAttribute('readonly');
      input.tabIndex = 0;
    } else {
      input.setAttribute('readonly', 'readonly');
      input.tabIndex = -1;
    }
  }
}

function updateNavButtons() {
  const back = $('btnNavBack');
  const forward = $('btnNavForward');
  if (!back || !forward) return;
  back.disabled = state.nav.index <= 0;
  forward.disabled =
    state.nav.index < 0 || state.nav.index >= state.nav.stack.length - 1;
}

function pushNavHistory(relPath) {
  if (state.nav.navigating) return;
  const p = normalizeProjectPath(relPath);
  if (!p) return;
  if (state.nav.stack[state.nav.index] === p) {
    updateNavButtons();
    return;
  }
  state.nav.stack = state.nav.stack.slice(0, state.nav.index + 1);
  state.nav.stack.push(p);
  if (state.nav.stack.length > 80) {
    const overflow = state.nav.stack.length - 80;
    state.nav.stack = state.nav.stack.slice(overflow);
  }
  state.nav.index = state.nav.stack.length - 1;
  updateNavButtons();
}

async function revealAndOpen(relPath, options = {}) {
  const target = normalizeProjectPath(relPath);
  if (!target) return;
  const parts = target.split('/');
  let current = '';
  // 逐级展开祖先，并展开目标文件夹本身（跳转后应为展开态）
  for (let i = 0; i < parts.length; i += 1) {
    current = current ? `${current}/${parts[i]}` : parts[i];
    let node = findNodeByPath(state.roots, current);
    if (!node && i === 0) {
      node = state.roots.find((n) => n.path === current);
    }
    if (node && !isFileNode(node)) {
      await ensureChildren(node);
      state.expanded.add(current);
    }
  }
  await previewNode(target, options);
  requestAnimationFrame(() => {
    const active = document.querySelector('.tree-row.active');
    if (active) {
      active.scrollIntoView({ block: 'nearest' });
      // 再滚一次，避免展开子节点后仍被遮挡
      const wrap = active.closest('.tree-node');
      if (wrap) wrap.scrollIntoView({ block: 'nearest' });
    }
  });
}

async function jumpToImportPath(path) {
  if (!path) return;
  try {
    setMsg(`正在打开 ${path}…`);
    await revealAndOpen(path, { recordHistory: true });
    setMsg(`已跳转到目录/文件，可点 ← 返回`, 'ok');
  } catch (err) {
    setMsg(err.message || '跳转失败（路径可能不存在）', 'err');
  }
}

async function navBack() {
  if (state.nav.index <= 0 || state.busy) return;
  state.nav.navigating = true;
  state.nav.index -= 1;
  updateNavButtons();
  const target = state.nav.stack[state.nav.index];
  try {
    setMsg(`返回 ${target}`);
    await revealAndOpen(target, { recordHistory: false });
    setMsg(`已返回 ${target}`, 'ok');
  } catch (e) {
    setMsg(e.message, 'err');
  } finally {
    state.nav.navigating = false;
    updateNavButtons();
  }
}

async function navForward() {
  if (
    state.nav.index < 0 ||
    state.nav.index >= state.nav.stack.length - 1 ||
    state.busy
  ) {
    return;
  }
  state.nav.navigating = true;
  state.nav.index += 1;
  updateNavButtons();
  const target = state.nav.stack[state.nav.index];
  try {
    setMsg(`前进 ${target}`);
    await revealAndOpen(target, { recordHistory: false });
    setMsg(`已打开 ${target}`, 'ok');
  } catch (e) {
    setMsg(e.message, 'err');
  } finally {
    state.nav.navigating = false;
    updateNavButtons();
  }
}

function bindFileEditorEvents(root) {
  bindFileEditorButtons(root);
  const input = root.querySelector('#codeEditorInput');
  if (!input || input.dataset.bound === '1') {
    syncCodeEditorHeight();
    return;
  }
  input.dataset.bound = '1';

  let highlightTimer = null;
  const scheduleHighlight = () => {
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
      if (!state.detail) return;
      refreshCodeHighlight(input.value, state.detail.path);
    }, 80);
  };

  input.addEventListener('input', () => {
    if (!state.fileEditor.editing) return;
    state.fileEditor.dirty = isEditorDirty();
    updateEditorChrome();
    scheduleHighlight();
  });

  input.addEventListener('scroll', () => {
    const stage = $('codeStage');
    // textarea 不单独滚动，统一由 stage 滚动
    if (input.scrollTop) input.scrollTop = 0;
    if (input.scrollLeft) input.scrollLeft = 0;
    void stage;
  });

  input.addEventListener('keydown', (e) => {
    if (!state.fileEditor.editing) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveCurrentFile();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEditMode();
    }
    // Tab 插入空格，避免失焦
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const val = input.value;
      input.value = `${val.slice(0, start)}  ${val.slice(end)}`;
      input.selectionStart = input.selectionEnd = start + 2;
      input.dispatchEvent(new Event('input'));
    }
  });

  syncCodeEditorHeight();
  requestAnimationFrame(syncCodeEditorHeight);
}

function bindCodeEditorEvents(root) {
  const editor = root.querySelector('.code-editor');

  root.onclick = async (e) => {
    if (e.target.closest('button, textarea, .code-actions')) return;
    const link = e.target.closest('.code-import-link');
    if (!link || !root.contains(link)) return;
    e.preventDefault();
    if (state.fileEditor.editing) {
      setMsg('请先保存或取消编辑，再跳转', '');
      return;
    }
    if (!(e.metaKey || e.ctrlKey)) {
      setMsg('按住 Ctrl（Mac 为 ⌘）再点击路径，可跳转到对应文件', '');
      return;
    }
    await jumpToImportPath(link.getAttribute('data-path'));
  };

  if (!editor) return;

  const syncMod = (held) => {
    const ed = document.querySelector('.code-editor');
    if (ed) ed.classList.toggle('mod-held', held);
  };

  root.onmousemove = (e) => {
    const link = e.target.closest('.code-import-link');
    editor.classList.toggle('mod-hover', !!(link && (e.metaKey || e.ctrlKey)));
  };

  if (!window.__codeModBound) {
    window.__codeModBound = true;
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Control' || e.key === 'Meta') syncMod(true);
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Control' || e.key === 'Meta') syncMod(false);
    });
    window.addEventListener('blur', () => syncMod(false));
  }
}

async function ensureChildren(node) {
  if (!node || isFileNode(node) || node.childrenLoaded) return node;
  if (!node.hasChildren) {
    node.childrenLoaded = true;
    node.children = [];
    return node;
  }
  const data = await api(
    `/api/cases/children?path=${encodeURIComponent(node.path)}`
  );
  node.children = data.children || [];
  node.childrenLoaded = true;
  node.hasChildren = node.children.length > 0;
  return node;
}

async function toggleExpand(node) {
  if (isFileNode(node) || !node.hasChildren) return;
  if (state.expanded.has(node.path)) {
    state.expanded.delete(node.path);
    renderTree();
    return;
  }
  try {
    await ensureChildren(node);
    state.expanded.add(node.path);
    renderTree();
  } catch (e) {
    setMsg(e.message, 'err');
  }
}

async function loadTree() {
  const data = await api('/api/cases/tree');
  state.roots = data.roots || [];
  state.leafTotal = data.leafTotal || 0;
  $('leafCount').textContent = String(state.leafTotal);
  // 根层已加载，不再默认全部展开（项目根文件很多）
  state.expanded.clear();
  renderTree();
}

function renderTree() {
  const root = $('caseTree');
  const q = state.treeFilter.trim().toLowerCase();
  root.innerHTML = '';

  const roots = (state.roots || []).filter((n) => nodeMatches(n, q));
  if (!roots.length) {
    root.innerHTML = emptyStateHtml({
      title: '没有匹配结果',
      desc: '搜索仅覆盖已展开内容，试试展开目录后再搜，或换个关键词。',
      icon: 'search',
    });
    return;
  }

  for (const node of roots) {
    root.appendChild(renderNode(node, q));
  }
}

function treeIconSvg(kind) {
  if (kind === 'folder') {
    return `<svg class="tree-icon-svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3.5 7.5A2 2 0 015.5 5.5H9l1.5 1.8H18.5a2 2 0 012 2V17a2 2 0 01-2 2h-13a2 2 0 01-2-2v-9.5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
    </svg>`;
  }
  // 用例 / 代码文件
  return `<svg class="tree-icon-svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M7 3.5h7l4 4V20a1.5 1.5 0 01-1.5 1.5h-9.5A1.5 1.5 0 015.5 20V5A1.5 1.5 0 017 3.5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
    <path d="M14 3.5V8h4.5" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
    <path d="M9.2 13.2l-1.7 1.8 1.7 1.8M14.8 13.2l1.7 1.8-1.7 1.8M12.4 12.8l-1.2 5.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function treeChevronSvg(expanded) {
  // 展开：向下；收起：向右
  if (expanded) {
    return `<svg class="tree-chevron-svg" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }
  return `<svg class="tree-chevron-svg" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function renderNode(node, q) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-node';

  const fileNode = isFileNode(node);
  const hasChildren = !fileNode && !!node.hasChildren;
  const expanded = state.expanded.has(node.path);
  const isCaseLeaf = !fileNode && !!node.selectable;
  const iconKind = fileNode || isCaseLeaf ? 'file' : 'folder';

  const row = document.createElement('div');
  row.className = 'tree-row';
  if (fileNode) row.classList.add('file');
  if (isCaseLeaf) row.classList.add('case');
  if (node.selectable) row.classList.add('selectable');
  if (state.selectedPath === node.path) row.classList.add('active');
  if (isNodeMockActive(node)) row.classList.add('enabled');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = `tree-toggle${hasChildren ? '' : ' is-leaf'}${
    expanded ? ' is-open' : ''
  }`;
  toggle.setAttribute('aria-label', expanded ? '收起' : '展开');
  toggle.innerHTML = hasChildren ? treeChevronSvg(expanded) : '';
  if (hasChildren) {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleExpand(node);
    });
  } else {
    toggle.tabIndex = -1;
    toggle.disabled = true;
  }
  row.appendChild(toggle);

  const icon = document.createElement('span');
  icon.className = `tree-icon tree-icon-${iconKind}`;
  icon.innerHTML = treeIconSvg(iconKind);
  row.appendChild(icon);

  if (node.selectable) {
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'tree-check';
    check.checked = isNodeMockActive(node);
    check.disabled = state.busy;
    check.title = check.checked ? '取消勾选以清除' : '勾选以启用 mock';
    check.addEventListener('click', (e) => e.stopPropagation());
    check.addEventListener('change', () => {
      toggleMock(node, check.checked);
    });
    row.appendChild(check);
  }

  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = node.name;
  name.title = node.path;
  row.appendChild(name);

  if (node.mockId || (node.selectable && !fileNode && node.mockKind !== 'file')) {
    const tag = document.createElement('span');
    tag.className = 'tree-tag';
    tag.textContent = node.mockId ? String(node.mockId) : `${node.mockCount || 0}`;
    row.appendChild(tag);
  } else if (fileNode && node.selectable && node.apiName) {
    const tag = document.createElement('span');
    tag.className = 'tree-tag soft';
    tag.textContent = node.apiName;
    row.appendChild(tag);
  }

  row.addEventListener('click', async () => {
    if (fileNode) {
      previewNode(node.path);
      return;
    }
    if (node.selectable) {
      // 可 mock 叶子：预览，并按需展开看文件
      if (hasChildren && !expanded) {
        await toggleExpand(node);
      }
      previewNode(node.path);
      return;
    }
    await toggleExpand(node);
    previewNode(node.path);
  });

  wrap.appendChild(row);

  if (hasChildren && expanded && node.childrenLoaded) {
    const kids = document.createElement('div');
    kids.className = 'tree-children';
    for (const child of node.children || []) {
      if (!nodeMatches(child, q)) continue;
      kids.appendChild(renderNode(child, q));
    }
    wrap.appendChild(kids);
  }

  return wrap;
}

async function previewNode(relPath, options = {}) {
  // 切换文件时静默退出编辑（不弹浏览器 confirm）
  if (
    state.fileEditor.editing &&
    state.fileEditor.path &&
    state.fileEditor.path !== relPath
  ) {
    state.fileEditor.editing = false;
    state.fileEditor.dirty = false;
  }

  const recordHistory = options.recordHistory !== false;
  state.selectedPath = relPath;
  if (recordHistory) pushNavHistory(relPath);
  renderTree();
  updateToggleButton();
  updateNavButtons();
  $('apiTable').innerHTML = emptyStateHtml({
    title: '加载中',
    desc: '正在读取目录与接口信息…',
  });
  setMsg('');
  try {
    const detail = await api(
      `/api/cases/detail?path=${encodeURIComponent(relPath)}`
    );
    state.detail = detail;
    $('casePath').textContent = detail.path;
    $('caseMockId').textContent = detail.mockId || '-';
    // 规则组用自定义下拉，不随详情覆盖
    if (state.config && state.config.ruleGroup) {
      const cur = state.config.ruleGroup;
      if ($('ruleGroup')) $('ruleGroup').value = cur;
      if ($('ruleGroupValue')) $('ruleGroupValue').textContent = cur;
    }

    if (detail.type === 'file') {
      const fileActive = detail.selectable && isFileMockActive(detail.path);
      $('selectedMeta').textContent = fileActive
        ? `已启用 · ${detail.apiName}`
        : detail.selectable
          ? `可 mock · ${detail.apiName}`
          : '源码预览';
      $('selectedMeta').className = fileActive ? 'count' : 'count soft';
      const label = document.querySelector('.preview-label');
      if (label) label.textContent = '源码';
      renderFilePreview(detail);
    } else if (detail.type === 'case') {
      const enabled = state.activePath === relPath;
      $('selectedMeta').textContent = enabled
        ? `已启用 · ${detail.apis.length} 接口`
        : `可勾选 · ${detail.apis.length} 接口`;
      $('selectedMeta').className = enabled ? 'count' : 'count soft';
      const label = document.querySelector('.preview-label');
      if (label) label.textContent = '接口列表';
      renderApiTable(detail.apis || []);
    } else {
      $('selectedMeta').textContent = '目录浏览';
      $('selectedMeta').className = 'count soft';
      const label = document.querySelector('.preview-label');
      if (label) label.textContent = '目录内容';
      renderDirListing(detail);
    }
    updateToggleButton();
  } catch (e) {
    state.detail = null;
    $('apiTable').innerHTML = emptyStateHtml({
      title: '无法打开',
      desc: e.message,
      icon: 'alert',
    });
    setMsg(e.message, 'err');
  }
}

function renderDirListing(detail) {
  const folders = detail.folders || [];
  const files = detail.files || [];
  const box = $('apiTable');
  if (!folders.length && !files.length) {
    box.innerHTML = emptyStateHtml({
      title: '空目录',
      desc: '这个文件夹里暂时没有可见文件或子目录。',
    });
    return;
  }
  const folderHtml = folders
    .map(
      (name) =>
        `<div class="api-item"><div class="title"><span class="kind">dir</span><span class="soa">${escapeHtml(
          name
        )}</span></div></div>`
    )
    .join('');
  const fileHtml = files
    .map(
      (name) =>
        `<div class="api-item"><div class="title"><span class="kind">file</span><span class="soa">${escapeHtml(
          name
        )}</span></div></div>`
    )
    .join('');
  box.innerHTML = `${folderHtml}${fileHtml}`;
}

function normalizeEditorText(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function resetFileEditor(path, content) {
  state.fileEditor = {
    path: path || null,
    original: normalizeEditorText(content),
    editing: false,
    dirty: false,
  };
}

function getEditorDraft() {
  const input = $('codeEditorInput');
  return normalizeEditorText(input ? input.value : state.fileEditor.original);
}

function isEditorDirty() {
  return getEditorDraft() !== normalizeEditorText(state.fileEditor.original);
}

function enterEditMode() {
  if (!state.detail || !state.detail.editable) return;
  const input = $('codeEditorInput');
  if (!input) return;
  state.fileEditor.editing = true;
  state.fileEditor.dirty = false;
  state.fileEditor.original = normalizeEditorText(state.detail.content || '');
  input.value = state.fileEditor.original;
  refreshCodeHighlight(input.value, state.detail.path);
  updateEditorChrome();
  input.focus();
  const len = input.value.length;
  input.setSelectionRange(len, len);
  setMsg('编辑模式：保存后写回本地', '');
}

function cancelEditMode() {
  // 直接退出编辑，不使用浏览器 alert/confirm
  const input = $('codeEditorInput');
  const hadDirty = isEditorDirty();
  state.fileEditor.editing = false;
  state.fileEditor.dirty = false;
  if (input && state.detail) {
    input.value = normalizeEditorText(state.detail.content || '');
    refreshCodeHighlight(input.value, state.detail.path);
  }
  updateEditorChrome();
  setMsg(hadDirty ? '已取消编辑，未保存的修改已丢弃' : '');
}

async function saveCurrentFile() {
  if (!state.detail || state.detail.type !== 'file' || !state.detail.editable) {
    return;
  }
  const path = state.detail.path;
  const content = getEditorDraft();
  if (content === normalizeEditorText(state.fileEditor.original)) {
    setMsg('没有需要保存的更改', '');
    return;
  }
  try {
    setMsg('正在保存到本地…');
    await api('/api/files/save', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    });
    state.detail.content = content;
    state.fileEditor.original = content;
    state.fileEditor.dirty = false;
    state.fileEditor.editing = false;
    refreshCodeHighlight(content, path);
    updateEditorChrome();
    if (isFileMockActive(path)) {
      setMsg(
        '已保存到本地。该文件已在 mock 中，请重新勾选以同步 Whistle Values',
        'ok'
      );
    } else {
      setMsg(`已保存 ${path}`, 'ok');
    }
  } catch (e) {
    setMsg(e.message, 'err');
  }
}

function bindFileEditorButtons(scope) {
  const root = scope || document;
  const startBtn = root.querySelector('#btnStartEdit');
  const saveBtn = root.querySelector('#btnSaveFile');
  const cancelBtn = root.querySelector('#btnCancelEdit');
  if (startBtn) {
    startBtn.onclick = (e) => {
      e.stopPropagation();
      enterEditMode();
    };
  }
  if (saveBtn) {
    saveBtn.onclick = (e) => {
      e.stopPropagation();
      saveCurrentFile();
    };
  }
  if (cancelBtn) {
    cancelBtn.onclick = (e) => {
      e.stopPropagation();
      cancelEditMode();
    };
  }
}

function renderFilePreview(detail, options = {}) {
  const box = $('apiTable');
  const linked = detail.linkedApi;
  let linkedHtml = '';
  if (linked && linked.ok && linked.jsonRel) {
    linkedHtml = `<div class="api-item linked-jump">
      <div class="title">关联 JSON</div>
      <a class="code-import-link line-link" href="#" data-path="${escapeHtml(
        linked.jsonRel
      )}" title="Ctrl/⌘ + 点击跳转">${escapeHtml(linked.jsonRel)}</a>
      <div class="line dim">按住 Ctrl/⌘ 点击上方路径，或代码里的 import 路径</div>
    </div>`;
  }

  let mockCard = '';
  if (detail.selectable && detail.mockKind === 'file') {
    const active = isFileMockActive(detail.path);
    mockCard = `<div class="api-item ${active ? 'mock-on' : ''}">
      <div class="title">
        <span class="soa">${escapeHtml(detail.apiName || '')}</span>
        <span class="tree-tag">${active ? '已启用' : '可单独 mock'}</span>
      </div>
      <div class="line">${escapeHtml(detail.ruleLine || '')}</div>
      <div class="line dim">Value: ${escapeHtml(detail.valueName || '')}</div>
    </div>`;
  }

  if (!options.preserveDraft || state.fileEditor.path !== detail.path) {
    resetFileEditor(detail.path, detail.content || '');
  }

  const showContent =
    options.preserveDraft && options.draft != null
      ? options.draft
      : detail.content || '';

  box.innerHTML = `${mockCard}${linkedHtml}${buildCodeEditorHtml(
    showContent,
    detail.path,
    {
      editable: !!detail.editable,
      editing: state.fileEditor.editing,
      dirty: state.fileEditor.dirty,
    }
  )}`;
  bindCodeEditorEvents(box);
  bindFileEditorEvents(box);
}

function renderApiTable(apis) {
  const box = $('apiTable');
  if (!apis.length) {
    box.innerHTML = emptyStateHtml({
      title: '没有可 mock 的接口',
      desc: '该目录下没有 .mock.ts 文件，换一个叶子用例再试。',
      icon: 'alert',
    });
    return;
  }
  box.innerHTML = apis
    .map((a) => {
      if (!a.ok) {
        return `<div class="api-item bad"><div class="title"><span class="soa">${escapeHtml(
          a.soaName
        )}</span></div><div class="err">${escapeHtml(a.error || '解析失败')}</div></div>`;
      }
      return `<div class="api-item"><div class="title"><span class="soa">${escapeHtml(
        a.soaName
      )}</span><span class="tree-tag">${escapeHtml(
        a.valueName
      )}</span></div><div class="line">${escapeHtml(a.ruleLine)}</div>
      <div class="line dim">${escapeHtml(a.jsonRel || '')}</div></div>`;
    })
    .join('');
}

async function toggleMock(nodeOrPath, enabled) {
  const relPath = typeof nodeOrPath === 'string' ? nodeOrPath : nodeOrPath.path;
  const mockKind =
    typeof nodeOrPath === 'object' && nodeOrPath
      ? nodeOrPath.mockKind || (nodeOrPath.type === 'file' && nodeOrPath.selectable ? 'file' : 'case')
      : null;

  if (state.busy) return;
  state.busy = true;
  state.selectedPath = relPath;
  updateToggleButton();
  renderTree();

  try {
    // 先拉详情，判断是用例还是 base-data 文件
    if (!state.detail || state.detail.path !== relPath) {
      await previewNode(relPath);
    }
    const kind =
      mockKind ||
      (state.detail && state.detail.mockKind) ||
      (state.detail && state.detail.type === 'case' ? 'case' : null);

    if (kind === 'file') {
      await toggleFileMock(relPath, enabled);
    } else if (kind === 'case' || (state.detail && state.detail.type === 'case')) {
      await toggleCase(relPath, enabled);
    } else {
      throw new Error('只能勾选用例文件夹或 base-data 下的 JSON');
    }
    await refreshStatus();
  } catch (e) {
    setMsg(e.message, 'err');
  } finally {
    state.busy = false;
    await loadActive();
    if (state.selectedPath && state.detail && state.detail.path === state.selectedPath) {
      if (state.detail.type === 'case') {
        $('selectedMeta').textContent =
          state.activePath === state.selectedPath
            ? `已启用 · ${(state.detail.apis || []).length} 接口`
            : `可勾选 · ${(state.detail.apis || []).length} 接口`;
      } else if (state.detail.mockKind === 'file') {
        const on = isFileMockActive(state.selectedPath);
        $('selectedMeta').textContent = on
          ? `已启用 · ${state.detail.apiName}`
          : `可 mock · ${state.detail.apiName}`;
        $('selectedMeta').className = on ? 'count' : 'count soft';
        renderFilePreview(state.detail);
      }
    }
    updateToggleButton();
  }
}

async function toggleFileMock(relPath, enabled) {
  if (enabled) {
    setMsg('正在写入单接口 mock…');
    const result = await api('/api/mocks/apply', {
      method: 'POST',
      body: JSON.stringify({ path: relPath }),
    });
    state.activeFiles[result.apiName] = result.path;
    setMsg(`已启用 ${result.apiName} ← ${result.fileName}`, 'ok');
    pushHistory({
      ...result,
      count: 1,
      action: 'apply',
    });
  } else {
    setMsg('正在清除该 JSON mock…');
    const result = await api('/api/mocks/clear', {
      method: 'POST',
      body: JSON.stringify({ path: relPath }),
    });
    delete state.activeFiles[result.apiName];
    setMsg(`已清除 ${result.apiName}`, 'ok');
    pushHistory({
      path: result.path,
      name: result.fileName,
      count: 1,
      action: 'clear',
    });
  }
}

async function toggleCase(relPath, enabled) {
  if (enabled) {
    setMsg('正在写入 Whistle…');
    if (!(state.detail && state.detail.type === 'case')) {
      throw new Error('只能勾选最小用例文件夹');
    }
    const result = await api('/api/cases/apply', {
      method: 'POST',
      body: JSON.stringify({ path: relPath }),
    });
    state.activePath = result.path;
    state.activeFiles = {};
    const okN = (result.applied || []).length;
    const skipN = (result.skipped || []).length;
    setMsg(
      `已启用 ${okN} 个接口${skipN ? `，跳过 ${skipN} 个` : ''}`,
      'ok'
    );
    pushHistory({ ...result, action: 'apply' });
  } else {
    setMsg('正在清除本工具写入的 Rules / Values…');
    const result = await api('/api/cases/clear', {
      method: 'POST',
      body: '{}',
    });
    state.activePath = null;
    setMsg(
      `已清除${result.previous ? `：${result.previous.name || result.previous.path}` : ''}`,
      'ok'
    );
    pushHistory({
      path: (result.previous && result.previous.path) || relPath,
      name: (result.previous && result.previous.name) || '已清除',
      mockId: result.previous && result.previous.mockId,
      count: (result.deletedValues || []).length,
      action: 'clear',
    });
  }
}

async function onToggleButton() {
  if (!state.selectedPath || state.busy || !state.detail) return;
  const d = state.detail;
  if (d.type === 'file' && d.selectable && d.mockKind === 'file') {
    const enable = !isFileMockActive(state.selectedPath);
    await toggleMock({ path: state.selectedPath, mockKind: 'file', type: 'file', selectable: true }, enable);
    return;
  }
  if (d.type === 'case' && d.selectable) {
    const enable = state.activePath !== state.selectedPath;
    await toggleMock({ path: state.selectedPath, mockKind: 'case', type: 'case', selectable: true }, enable);
  }
}

function pushHistory(result) {
  const item = {
    at: new Date().toISOString(),
    path: result.path,
    name: result.name,
    mockId: result.mockId,
    count: result.count != null ? result.count : (result.applied || []).length,
    action: result.action || 'apply',
  };
  const list = loadHistory();
  list.unshift(item);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 20)));
  renderHistory();
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch (_) {
    return [];
  }
}

function renderHistory() {
  const ul = $('historyList');
  const list = loadHistory();
  if (!list.length) {
    ul.innerHTML = '<li class="empty">暂无最近应用记录</li>';
    return;
  }
  ul.innerHTML = list
    .slice(0, 10)
    .map((item) => {
      const time = new Date(item.at).toLocaleTimeString();
      const id = item.mockId ? `#${item.mockId}` : '';
      const isClear = item.action === 'clear';
      const act = isClear ? '清除' : '启用';
      return `<li title="${escapeHtml(item.path || '')}"><code>${escapeHtml(
        item.name || ''
      )}</code><span class="tag ${isClear ? 'clear' : 'apply'}">${act}</span>${
        id ? `<span class="time">${escapeHtml(id)}</span>` : ''
      }<span class="time">${time}</span></li>`;
    })
    .join('');
}

async function copyProxy() {
  const text = $('proxyAddress').textContent;
  if (!text || text === '-') return;
  try {
    await navigator.clipboard.writeText(text);
    setMsg(`已复制代理地址 ${text}`, 'ok');
  } catch (_) {
    setMsg('复制失败，请手动选择', 'err');
  }
}

function bindEvents() {
  $('treeSearch').addEventListener('input', (e) => {
    state.treeFilter = e.target.value;
    renderTree();
  });
  $('btnToggle').addEventListener('click', onToggleButton);
  $('btnCopyProxy').addEventListener('click', copyProxy);
  bindRuleGroupSelect();
  $('btnHelp')?.addEventListener('click', openHelp);
  $('btnCloseHelp')?.addEventListener('click', closeHelp);
  $('btnNavBack')?.addEventListener('click', navBack);
  $('btnNavForward')?.addEventListener('click', navForward);
  $('helpOverlay')?.addEventListener('click', (e) => {
    if (e.target === $('helpOverlay')) closeHelp();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeHelp();
    // Alt+← / Alt+→ 前进后退（与常见 IDE 习惯接近）
    if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      navBack();
    }
    if (e.altKey && e.key === 'ArrowRight') {
      e.preventDefault();
      navForward();
    }
  });
  $('btnRefreshStatus').addEventListener('click', async () => {
    try {
      await refreshStatus();
      await loadRuleGroups();
      await loadActive();
    } catch (e) {
      setMsg(e.message, 'err');
    }
  });
  $('btnStart').addEventListener('click', async () => {
    setMsg('正在启动 w2…');
    try {
      await api('/api/w2/start', { method: 'POST', body: '{}' });
      await refreshStatus();
      await loadActive();
      setMsg('w2 已启动', 'ok');
    } catch (e) {
      setMsg(e.message, 'err');
    }
  });
  $('btnStop').addEventListener('click', async () => {
    setMsg('正在停止 w2…');
    try {
      await api('/api/w2/stop', { method: 'POST', body: '{}' });
      await refreshStatus();
      setMsg('w2 已停止', 'ok');
    } catch (e) {
      setMsg(e.message, 'err');
    }
  });
}

async function init() {
  bindEvents();
  renderHistory();
  updateToggleButton();
  try {
    await loadConfig();
    await refreshStatus();
    await loadTree();
    await loadActive();
  } catch (e) {
    setMsg(e.message, 'err');
    $('caseTree').innerHTML = emptyStateHtml({
      title: '目录加载失败',
      desc: e.message,
      icon: 'alert',
    });
  }
}

init();
