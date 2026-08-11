const fs = require('fs');
const path = require('path');

function assertSafeApiName(apiName) {
  if (!apiName || typeof apiName !== 'string') {
    throw new Error('接口名无效');
  }
  if (apiName.includes('..') || apiName.includes('/') || apiName.includes('\\')) {
    throw new Error('接口名非法');
  }
  return apiName;
}

function assertSafeFileName(fileName) {
  if (!fileName || typeof fileName !== 'string') {
    throw new Error('文件名无效');
  }
  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    throw new Error('文件名非法');
  }
  if (!fileName.toLowerCase().endsWith('.json')) {
    throw new Error('仅支持 .json 文件');
  }
  return fileName;
}

function listApis(mockRoot) {
  if (!fs.existsSync(mockRoot)) {
    throw new Error(`mockRoot 不存在: ${mockRoot}`);
  }
  return fs
    .readdirSync(mockRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => {
      const dir = path.join(mockRoot, d.name);
      let jsonCount = 0;
      try {
        jsonCount = fs
          .readdirSync(dir)
          .filter((f) => f.toLowerCase().endsWith('.json')).length;
      } catch (_) {
        jsonCount = 0;
      }
      return { name: d.name, jsonCount };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function getPreviewLines(content, maxLines = 8) {
  return content.split(/\r?\n/).slice(0, maxLines).join('\n');
}

function listMocks(mockRoot, apiName) {
  const safeApi = assertSafeApiName(apiName);
  const dir = path.join(mockRoot, safeApi);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`接口目录不存在: ${safeApi}`);
  }

  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .map((fileName) => {
      const fullPath = path.join(dir, fileName);
      const stat = fs.statSync(fullPath);
      let preview = '';
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        preview = getPreviewLines(content);
      } catch (_) {
        preview = '';
      }
      return {
        fileName,
        size: stat.size,
        mtime: stat.mtimeMs,
        preview,
      };
    })
    .sort((a, b) => a.fileName.localeCompare(b.fileName, 'zh-CN'));
}

function readMock(mockRoot, apiName, fileName) {
  const safeApi = assertSafeApiName(apiName);
  const safeFile = assertSafeFileName(fileName);
  const fullPath = path.join(mockRoot, safeApi, safeFile);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    throw new Error(`文件不存在: ${safeApi}/${safeFile}`);
  }
  const content = fs.readFileSync(fullPath, 'utf8');
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch (_) {
    parsed = null;
  }
  return {
    apiName: safeApi,
    fileName: safeFile,
    path: fullPath,
    content,
    json: parsed,
  };
}

function buildValueName(apiName, fileName, strategy = 'api-filename') {
  if (strategy === 'filename') {
    return fileName;
  }
  return `${apiName}__${fileName}`;
}

function buildRuleLine(apiName, valueName) {
  return `/^(http|https)://.+?/${apiName}/ file://{${valueName}}`;
}

module.exports = {
  listApis,
  listMocks,
  readMock,
  buildValueName,
  buildRuleLine,
  assertSafeApiName,
  assertSafeFileName,
};
