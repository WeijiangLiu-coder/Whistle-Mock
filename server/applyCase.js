const whistle = require('./whistleClient');
const { getCaseDetail, buildRuleLine } = require('./caseScanner');
const { stripAllFileMockMarkers } = require('./applyMock');

const CASE_START = '# [whistle-mock-case]';
const CASE_END = '# [/whistle-mock-case]';
const META_PREFIX = '# meta:';

function stripCaseBlock(lines) {
  const cleaned = [];
  let skipping = false;
  let meta = null;
  let removedValues = [];

  for (const line of lines) {
    const t = line.trim();
    if (t === CASE_START) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (t.startsWith(META_PREFIX)) {
        try {
          meta = JSON.parse(t.slice(META_PREFIX.length));
          removedValues = Array.isArray(meta.values) ? meta.values : [];
        } catch (_) {
          meta = null;
        }
      }
      if (t === CASE_END) {
        skipping = false;
      }
      continue;
    }
    cleaned.push(line);
  }

  return { cleaned, meta, removedValues };
}

function parseActiveFromRules(text) {
  const lines = String(text || '').split(/\r?\n/);
  let inBlock = false;
  for (const line of lines) {
    const t = line.trim();
    if (t === CASE_START) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (t === CASE_END) break;
    if (t.startsWith(META_PREFIX)) {
      try {
        return JSON.parse(t.slice(META_PREFIX.length));
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}

/**
 * 注释掉规则组中指定接口的启用 file:// 规则，并写入本工具标记块
 */
function patchRulesForApis(existingText, apiRules, meta) {
  const lines = String(existingText || '').split(/\r?\n/);
  const { cleaned } = stripCaseBlock(lines);

  const apiSet = new Set(apiRules.map((a) => a.soaName));
  const commented = cleaned.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    if (!/file:\/\/\{/.test(trimmed)) return line;
    for (const soa of apiSet) {
      if (trimmed.includes(`/${soa}/`)) {
        const indent = line.match(/^\s*/)[0];
        return `${indent}# ${trimmed}`;
      }
    }
    return line;
  });

  while (commented.length && commented[commented.length - 1].trim() === '') {
    commented.pop();
  }

  commented.push('');
  commented.push(CASE_START);
  commented.push(`${META_PREFIX}${JSON.stringify(meta)}`);
  for (const item of apiRules) {
    commented.push(item.ruleLine);
  }
  commented.push(CASE_END);
  commented.push('');
  return commented.join('\n');
}

function clearCaseBlock(existingText) {
  const lines = String(existingText || '').split(/\r?\n/);
  const { cleaned, meta, removedValues } = stripCaseBlock(lines);
  while (cleaned.length && cleaned[cleaned.length - 1].trim() === '') {
    cleaned.pop();
  }
  cleaned.push('');
  return {
    text: cleaned.join('\n'),
    meta,
    removedValues,
  };
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
  const current = await whistle.getRuleValue(
    config.whistleHost,
    config.whistlePort,
    config.ruleGroup
  );
  return current && current.value && typeof current.value.value === 'string'
    ? current.value.value
    : '';
}

async function getActiveCase(config) {
  const status = await whistle.getStatus(config.whistleHost, config.whistlePort);
  if (!status.runningByHttp) {
    return { active: null, ruleGroup: config.ruleGroup };
  }
  const text = await readRuleText(config);
  const meta = parseActiveFromRules(text);
  return {
    active: meta
      ? {
          path: meta.path || null,
          name: meta.name || null,
          mockId: meta.mockId || null,
          values: meta.values || [],
        }
      : null,
    ruleGroup: config.ruleGroup,
  };
}

async function clearCase(config) {
  const status = await ensureWhistle(config);
  const currentText = await readRuleText(config);
  const { text, meta, removedValues } = clearCaseBlock(currentText);

  await whistle.addRules(
    config.whistleHost,
    config.whistlePort,
    config.ruleGroup,
    text,
    true
  );

  const deletedValues = [];
  for (const name of removedValues) {
    try {
      await whistle.removeValue(config.whistleHost, config.whistlePort, name);
      deletedValues.push(name);
    } catch (_) {
      // ignore missing values
    }
  }

  return {
    cleared: true,
    previous: meta
      ? { path: meta.path, name: meta.name, mockId: meta.mockId }
      : null,
    deletedValues,
    ruleGroup: config.ruleGroup,
    proxyAddress: status.proxyAddress,
    lanIp: status.lanIp,
    whistleUi: status.uiUrl,
  };
}

async function applyCase(config, { path: relPath }) {
  const detail = getCaseDetail(config, relPath);
  const okApis = detail.apis.filter((a) => a.ok);
  const failApis = detail.apis.filter((a) => !a.ok);

  if (!okApis.length) {
    throw new Error('该用例下没有可解析的 mock JSON');
  }

  const status = await ensureWhistle(config);

  // 先清掉上一个用例写入的 Values，并去掉单文件 mock 标记，避免残留冲突
  const currentText = await readRuleText(config);
  const prev = clearCaseBlock(stripAllFileMockMarkers(currentText));
  for (const name of prev.removedValues) {
    try {
      await whistle.removeValue(config.whistleHost, config.whistlePort, name);
    } catch (_) {}
  }

  const written = [];
  for (const api of okApis) {
    await whistle.addValue(
      config.whistleHost,
      config.whistlePort,
      api.valueName,
      api.content
    );
    const ruleLine = buildRuleLine(api.soaName, api.valueName);
    written.push({
      soaName: api.soaName,
      valueName: api.valueName,
      jsonRel: api.jsonRel,
      ruleLine,
    });
  }

  const meta = {
    path: detail.path,
    name: detail.name,
    mockId: detail.mockId,
    values: written.map((w) => w.valueName),
  };

  // 基于已去掉旧 case 块的文本再写入
  const baseText = prev.text;
  const nextText = patchRulesForApis(baseText, written, meta);
  await whistle.addRules(
    config.whistleHost,
    config.whistlePort,
    config.ruleGroup,
    nextText,
    true
  );

  return {
    path: detail.path,
    name: detail.name,
    mockId: detail.mockId,
    ruleGroup: config.ruleGroup,
    applied: written,
    skipped: failApis.map((a) => ({
      soaName: a.soaName,
      error: a.error,
      mockFile: a.mockFile,
    })),
    proxyAddress: status.proxyAddress,
    lanIp: status.lanIp,
    whistleUi: status.uiUrl,
  };
}

module.exports = {
  applyCase,
  clearCase,
  getActiveCase,
  patchRulesForApis,
  clearCaseBlock,
  parseActiveFromRules,
};
