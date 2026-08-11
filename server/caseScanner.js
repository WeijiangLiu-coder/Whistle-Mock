const fs = require('fs');
const path = require('path');

const IMPORT_JSON_RE =
  /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+\.json)['"]/g;
const BODY_RE = /body\s*:\s*([A-Za-z_$][\w$]*)/;

const SKIP_DIR_NAMES = new Set(['node_modules', '.git']);

function loadMockIdMap(mockConfigFile) {
  const map = new Map();
  try {
    const cfg = JSON.parse(fs.readFileSync(mockConfigFile, 'utf8'));
    const list = (cfg.folders && cfg.folders.list) || [];
    for (const item of list) {
      if (!item || !item.path) continue;
      const key = normalizeRel(item.path);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item.id);
    }
  } catch (_) {}
  return map;
}

function normalizeRel(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function safeJoin(root, rel) {
  const full = path.resolve(root, rel || '');
  const rootFull = path.resolve(root);
  if (full !== rootFull && !full.startsWith(rootFull + path.sep)) {
    throw new Error('非法路径');
  }
  return full;
}

function listMockTs(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.mock.ts'))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch (_) {
    return [];
  }
}

function listEntries(dir, { includeDot = false } = {}) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => {
        if (SKIP_DIR_NAMES.has(d.name)) return false;
        if (d.name === '.DS_Store') return false;
        if (!includeDot && d.name.startsWith('.')) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name, 'zh-CN');
      });
  } catch (_) {
    return [];
  }
}

function listSubDirs(dir, options) {
  return listEntries(dir, options)
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function listFiles(dir, options) {
  return listEntries(dir, options)
    .filter((d) => d.isFile())
    .map((d) => d.name);
}

function isUnderCaseRoot(config, relPath) {
  const rel = normalizeRel(relPath);
  const roots = config.caseRoots || [];
  return roots.some((root) => rel === root || rel.startsWith(`${root}/`));
}

/** 可 mock 的叶子：位于三端用例目录内，有 .mock.ts，且没有子文件夹 */
function isLeafCaseDir(dir) {
  const mocks = listMockTs(dir);
  if (!mocks.length) return false;
  return listSubDirs(dir).length === 0;
}

function isSelectableCaseDir(config, relPath, fullDir) {
  return isUnderCaseRoot(config, relPath) && isLeafCaseDir(fullDir);
}

function dirHasChildren(dir, options) {
  return listEntries(dir, options).length > 0;
}

/** base-data/<apiName>/<file>.json → 可单独 mock */
function parseBaseDataJson(relPath) {
  const rel = normalizeRel(relPath);
  const m = rel.match(/^base-data\/([^/]+)\/([^/]+\.json)$/i);
  if (!m) return null;
  return {
    apiName: m[1],
    fileName: m[2],
    path: rel,
    valueName: `${m[1]}__${m[2]}`,
  };
}

function makeFileNode(relPath) {
  const rel = normalizeRel(relPath);
  const base = parseBaseDataJson(rel);
  return {
    type: 'file',
    name: path.basename(rel),
    path: rel,
    mockId: null,
    mockIds: [],
    selectable: !!base,
    mockKind: base ? 'file' : null,
    apiName: base ? base.apiName : null,
    mockCount: 0,
    hasChildren: false,
    childrenLoaded: true,
    children: [],
  };
}

function makeDirNode(config, relPath, idMap, { includeDot = false } = {}) {
  const rel = normalizeRel(relPath);
  const full = safeJoin(config.projectRoot, rel);
  const ids = idMap.get(rel) || [];
  const selectable = isSelectableCaseDir(config, rel, full);
  const mocks = selectable ? listMockTs(full) : listMockTs(full);
  const hasChildren = dirHasChildren(full, { includeDot });

  return {
    type: 'dir',
    name: path.basename(rel) || path.basename(config.projectRoot),
    path: rel,
    mockId: ids[0] || null,
    mockIds: ids,
    selectable,
    mockCount: mocks.length,
    hasChildren,
    childrenLoaded: false,
    children: [],
  };
}

/**
 * 项目根目录一层：镜像本地仓库（跳过 node_modules / .git）。
 * 子目录按需加载，避免 base-data + 用例树一次打爆。
 */
function buildTree(config) {
  const idMap = loadMockIdMap(config.mockConfigFile);
  const roots = listChildren(config, '', idMap);
  return {
    projectRoot: config.projectRoot,
    caseRoots: config.caseRoots,
    roots,
  };
}

/** 列出某一层目录内容（path 空字符串表示项目根） */
function listChildren(config, relPath, idMap) {
  const map = idMap || loadMockIdMap(config.mockConfigFile);
  const rel = normalizeRel(relPath);
  const full = safeJoin(config.projectRoot, rel);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
    throw new Error(`目录不存在: ${rel || '.'}`);
  }

  // 根目录展示点目录（.cursor 等），子目录默认隐藏点文件
  const includeDot = !rel;
  const entries = listEntries(full, { includeDot });
  const children = [];

  for (const entry of entries) {
    const childRel = rel ? normalizeRel(path.join(rel, entry.name)) : entry.name;
    if (entry.isDirectory()) {
      children.push(makeDirNode(config, childRel, map, { includeDot: false }));
    } else if (entry.isFile()) {
      children.push(makeFileNode(childRel));
    }
  }

  return children;
}

/** 仅统计三端用例内可勾选叶子数（给角标用） */
function countSelectableLeaves(config) {
  let total = 0;
  for (const rootName of config.caseRoots || []) {
    const rootDir = safeJoin(config.projectRoot, rootName);
    if (!fs.existsSync(rootDir)) continue;
    total += walkCountSelectable(rootDir);
  }
  return total;
}

function walkCountSelectable(dir) {
  const subs = listSubDirs(dir);
  const mocks = listMockTs(dir);
  if (mocks.length && subs.length === 0) return 1;
  let n = 0;
  for (const sub of subs) {
    n += walkCountSelectable(path.join(dir, sub));
  }
  return n;
}

function getCaseDetail(config, relPath) {
  const rel = normalizeRel(relPath);
  const full = safeJoin(config.projectRoot, rel);
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
    throw new Error(`目录不存在: ${rel}`);
  }
  if (!isUnderCaseRoot(config, rel)) {
    throw new Error('只能勾选三端用例文件夹内的最小用例目录');
  }
  if (!isLeafCaseDir(full)) {
    throw new Error('只能勾选最小用例文件夹（含 .mock.ts 且无子目录）');
  }

  const idMap = loadMockIdMap(config.mockConfigFile);
  const ids = idMap.get(rel) || [];
  const files = listMockTs(full);
  const apis = files.map((fileName) =>
    parseMockTs(config.projectRoot, full, fileName)
  );

  return {
    path: rel,
    name: path.basename(rel),
    mockId: ids[0] || null,
    mockIds: ids,
    apis,
  };
}

/** 任意节点预览：目录列表 / 叶子用例 / 文件内容 */
function getNodeDetail(config, relPath) {
  const rel = normalizeRel(relPath);
  const full = safeJoin(config.projectRoot, rel);
  if (!fs.existsSync(full)) {
    throw new Error(`路径不存在: ${rel}`);
  }

  const stat = fs.statSync(full);
  const idMap = loadMockIdMap(config.mockConfigFile);
  const ids = idMap.get(rel) || [];

  if (stat.isFile()) {
    const content = fs.readFileSync(full, 'utf8');
    let linked = null;
    if (rel.endsWith('.mock.ts')) {
      linked = parseMockTs(
        config.projectRoot,
        path.dirname(full),
        path.basename(full)
      );
    }
    const base = parseBaseDataJson(rel);
    return {
      type: 'file',
      path: rel,
      name: path.basename(rel),
      selectable: !!base,
      editable: isEditableFile(rel),
      mockKind: base ? 'file' : null,
      apiName: base ? base.apiName : null,
      fileName: base ? base.fileName : path.basename(rel),
      valueName: base ? base.valueName : null,
      ruleLine: base
        ? buildRuleLine(base.apiName, base.valueName)
        : null,
      content,
      linkedApi: linked,
    };
  }

  const selectable = isSelectableCaseDir(config, rel, full);
  const subs = listSubDirs(full, { includeDot: !rel });
  const files = listFiles(full, { includeDot: !rel });

  if (selectable) {
    const detail = getCaseDetail(config, rel);
    return {
      type: 'case',
      selectable: true,
      ...detail,
      files,
    };
  }

  return {
    type: 'dir',
    path: rel,
    name: path.basename(rel),
    mockId: ids[0] || null,
    mockIds: ids,
    selectable: false,
    folders: subs,
    files,
    mockableZone: isUnderCaseRoot(config, rel),
  };
}

function parseMockTs(projectRoot, caseDir, fileName) {
  const soaName = fileName.replace(/\.mock\.ts$/i, '');
  const mockPath = path.join(caseDir, fileName);
  const text = fs.readFileSync(mockPath, 'utf8');

  const imports = [];
  let m;
  const re = new RegExp(IMPORT_JSON_RE.source, 'g');
  while ((m = re.exec(text))) {
    if (/\/soa\.json$/i.test(m[2])) continue;
    imports.push({ ident: m[1], rel: m[2] });
  }

  let chosen = imports[0] || null;
  const bodyMatch = text.match(BODY_RE);
  if (bodyMatch) {
    const hit = imports.find((i) => i.ident === bodyMatch[1]);
    if (hit) chosen = hit;
  }

  if (!chosen) {
    return {
      soaName,
      mockFile: fileName,
      mockPath,
      ok: false,
      error: '未找到 JSON import',
      jsonRel: null,
      jsonPath: null,
      valueName: null,
      content: null,
    };
  }

  const jsonPath = path.resolve(caseDir, chosen.rel);
  const jsonRel = normalizeRel(path.relative(projectRoot, jsonPath));
  if (!fs.existsSync(jsonPath)) {
    return {
      soaName,
      mockFile: fileName,
      mockPath,
      ok: false,
      error: `JSON 不存在: ${jsonRel}`,
      jsonRel,
      jsonPath,
      valueName: null,
      content: null,
    };
  }

  const content = fs.readFileSync(jsonPath, 'utf8');
  const valueName = `${soaName}__${path.basename(jsonPath)}`;

  return {
    soaName,
    mockFile: fileName,
    mockPath,
    ok: true,
    error: null,
    jsonRel,
    jsonPath,
    valueName,
    content,
  };
}

function buildRuleLine(soaName, valueName) {
  return `/^(http|https)://.+?/${soaName}/ file://{${valueName}}`;
}

const EDITABLE_EXT_RE =
  /\.(json|mock\.ts|ts|tsx|js|jsx|mjs|cjs|md|txt|css|html)$/i;

function isEditableFile(relPath) {
  const rel = normalizeRel(relPath);
  if (!rel || rel.includes('node_modules/') || rel.startsWith('.git/')) {
    return false;
  }
  return EDITABLE_EXT_RE.test(rel);
}

/** 写回本地仓库文件（仅允许项目内可编辑类型） */
function writeFileContent(config, relPath, content) {
  const rel = normalizeRel(relPath);
  if (!isEditableFile(rel)) {
    throw new Error('该文件类型不允许编辑保存');
  }
  if (typeof content !== 'string') {
    throw new Error('内容必须是字符串');
  }
  if (Buffer.byteLength(content, 'utf8') > 8 * 1024 * 1024) {
    throw new Error('文件过大（上限 8MB）');
  }

  const full = safeJoin(config.projectRoot, rel);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw new Error(`文件不存在: ${rel}`);
  }

  // JSON 做一次格式校验，避免写出非法 mock
  if (/\.json$/i.test(rel)) {
    try {
      JSON.parse(content);
    } catch (e) {
      throw new Error(`JSON 格式无效: ${e.message}`);
    }
  }

  fs.writeFileSync(full, content, 'utf8');
  return {
    path: rel,
    size: Buffer.byteLength(content, 'utf8'),
    mtime: Date.now(),
  };
}

module.exports = {
  buildTree,
  listChildren,
  countSelectableLeaves,
  getCaseDetail,
  getNodeDetail,
  parseMockTs,
  parseBaseDataJson,
  buildRuleLine,
  writeFileContent,
  isEditableFile,
  normalizeRel,
  isLeafCaseDir,
  isUnderCaseRoot,
  isSelectableCaseDir,
};
