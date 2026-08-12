const path = require('path');
const fs = require('fs');
const {
  readMock,
  buildValueName,
  buildRuleLine,
} = require('./mockScanner');
const { parseBaseDataJson, normalizeRel } = require('./caseScanner');
const whistle = require('./whistleClient');

const FILE_MARKER_PREFIX = '# [whistle-mock]';

/**
 * 注释掉规则组中「已启用」且匹配指定接口的 file:// mock 行，再追加新规则。
 */
function patchRulesText(existingText, apiName, ruleLine) {
  const lines = String(existingText || '').split(/\r?\n/);
  const apiToken = `/${apiName}/`;
  const patched = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    if (!trimmed.includes(apiToken)) return line;
    if (!/file:\/\/\{/.test(trimmed)) return line;
    const indent = line.match(/^\s*/)[0];
    return `${indent}# ${trimmed}`;
  });

  while (patched.length && patched[patched.length - 1].trim() === '') {
    patched.pop();
  }

  const marker = `${FILE_MARKER_PREFIX} ${apiName}`;
  const cleaned = [];
  for (let i = 0; i < patched.length; i++) {
    if (patched[i].trim() === marker) {
      if (i + 1 < patched.length && patched[i + 1].includes(apiToken)) {
        i += 1;
      }
      continue;
    }
    cleaned.push(patched[i]);
  }

  cleaned.push('');
  cleaned.push(marker);
  cleaned.push(ruleLine);
  cleaned.push('');
  return cleaned.join('\n');
}

/** 移除某个接口的单文件 mock 标记块 */
function removeFileMockMarker(existingText, apiName) {
  const lines = String(existingText || '').split(/\r?\n/);
  const marker = `${FILE_MARKER_PREFIX} ${apiName}`;
  const apiToken = `/${apiName}/`;
  const cleaned = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === marker) {
      if (i + 1 < lines.length && lines[i + 1].includes(apiToken)) {
        i += 1;
      }
      continue;
    }
    cleaned.push(lines[i]);
  }
  while (cleaned.length && cleaned[cleaned.length - 1].trim() === '') {
    cleaned.pop();
  }
  cleaned.push('');
  return cleaned.join('\n');
}

/** 清除全部单文件 mock 标记块 */
function stripAllFileMockMarkers(existingText) {
  const lines = String(existingText || '').split(/\r?\n/);
  const cleaned = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith(FILE_MARKER_PREFIX + ' ')) {
      const apiName = t.slice(FILE_MARKER_PREFIX.length + 1).trim();
      if (
        i + 1 < lines.length &&
        lines[i + 1].includes(`/${apiName}/`) &&
        /file:\/\/\{/.test(lines[i + 1])
      ) {
        i += 1;
      }
      continue;
    }
    cleaned.push(lines[i]);
  }
  return cleaned.join('\n');
}

function parseActiveFileMocks(text) {
  const lines = String(text || '').split(/\r?\n/);
  const actives = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith(FILE_MARKER_PREFIX + ' ')) continue;
    const apiName = t.slice(FILE_MARKER_PREFIX.length + 1).trim();
    const next = (lines[i + 1] || '').trim();
    const m = next.match(/file:\/\/\{([^}]+)\}/);
    if (!m) continue;
    const valueName = m[1];
    let fileName = valueName;
    const prefix = `${apiName}__`;
    if (valueName.startsWith(prefix)) {
      fileName = valueName.slice(prefix.length);
    }
    actives.push({
      apiName,
      fileName,
      valueName,
      path: normalizeRel(`base-data/${apiName}/${fileName}`),
      ruleLine: next,
    });
  }
  return actives;
}

async function ensureWhistle(config) {
  let status = await whistle.getStatus(config.whistleHost, config.whistlePort);
  whistle.bindConfigEndpoint(config, status);
  if (!status.runningByHttp) {
    const started = await whistle.startWhistle(
      config.whistleHost,
      config.whistlePort
    );
    status = started.status;
    whistle.bindConfigEndpoint(config, status);
  }
  if (!status.runningByHttp) {
    throw new Error(
      `Whistle 未就绪，无法写入 Rules/Values（当前尝试 ${config.whistleHost}:${config.whistlePort}）`
    );
  }
  return status;
}

async function readRuleText(config) {
  return whistle.getRuleText(
    config.whistleHost,
    config.whistlePort,
    config.ruleGroup
  );
}

async function applyMock(config, { apiName, fileName, valueName }) {
  const mock = readMock(config.mockRoot, apiName, fileName);
  const finalValueName =
    (valueName && String(valueName).trim()) ||
    buildValueName(mock.apiName, mock.fileName, config.valueNameStrategy);
  const ruleLine = buildRuleLine(mock.apiName, finalValueName);

  const status = await ensureWhistle(config);

  await whistle.addValue(
    config.whistleHost,
    config.whistlePort,
    finalValueName,
    mock.content
  );

  const currentText = await readRuleText(config);
  const nextText = patchRulesText(currentText, mock.apiName, ruleLine);

  await whistle.addRules(
    config.whistleHost,
    config.whistlePort,
    config.ruleGroup,
    nextText,
    true
  );

  return {
    kind: 'file',
    apiName: mock.apiName,
    fileName: mock.fileName,
    path: normalizeRel(`base-data/${mock.apiName}/${mock.fileName}`),
    name: mock.fileName,
    valueName: finalValueName,
    ruleGroup: config.ruleGroup,
    ruleLine,
    proxyAddress: status.proxyAddress,
    lanIp: status.lanIp,
    whistleUi: status.uiUrl,
    sourcePath: mock.path,
  };
}

async function applyMockByPath(config, relPath) {
  const info = parseBaseDataJson(relPath);
  if (!info) {
    throw new Error('只能 mock base-data/<接口名>/<文件>.json');
  }
  const full = path.resolve(config.projectRoot, info.path);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw new Error(`文件不存在: ${info.path}`);
  }
  return applyMock(config, {
    apiName: info.apiName,
    fileName: info.fileName,
    valueName: info.valueName,
  });
}

async function clearMockByPath(config, relPath) {
  const info = parseBaseDataJson(relPath);
  if (!info) {
    throw new Error('只能清除 base-data 下的 JSON mock');
  }
  const status = await ensureWhistle(config);
  const currentText = await readRuleText(config);
  const nextText = removeFileMockMarker(currentText, info.apiName);

  await whistle.addRules(
    config.whistleHost,
    config.whistlePort,
    config.ruleGroup,
    nextText,
    true
  );

  try {
    await whistle.removeValue(
      config.whistleHost,
      config.whistlePort,
      info.valueName
    );
  } catch (_) {}

  return {
    kind: 'file',
    cleared: true,
    path: info.path,
    apiName: info.apiName,
    fileName: info.fileName,
    valueName: info.valueName,
    ruleGroup: config.ruleGroup,
    proxyAddress: status.proxyAddress,
    lanIp: status.lanIp,
    whistleUi: status.uiUrl,
  };
}

async function getActiveFileMocks(config) {
  const status = await whistle.getStatus(config.whistleHost, config.whistlePort);
  whistle.bindConfigEndpoint(config, status);
  if (!status.runningByHttp) {
    return {
      files: [],
      ruleGroup: config.ruleGroup,
      warning: status.httpError || 'Whistle CGI 未就绪',
    };
  }
  try {
    const text = await readRuleText(config);
    return {
      files: parseActiveFileMocks(text),
      ruleGroup: config.ruleGroup,
    };
  } catch (e) {
    return {
      files: [],
      ruleGroup: config.ruleGroup,
      warning: e.message,
    };
  }
}

module.exports = {
  applyMock,
  applyMockByPath,
  clearMockByPath,
  getActiveFileMocks,
  patchRulesText,
  stripAllFileMockMarkers,
  parseActiveFileMocks,
  FILE_MARKER_PREFIX,
};
