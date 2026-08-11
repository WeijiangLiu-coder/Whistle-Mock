const { execFile, spawn } = require('child_process');
const http = require('http');
const os = require('os');
const querystring = require('querystring');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function getLanIpv4() {
  try {
    const nets = os.networkInterfaces() || {};
    const candidates = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        const family = net.family === 'IPv4' || net.family === 4;
        if (family && !net.internal) {
          candidates.push({ name, address: net.address });
        }
      }
    }
    const preferred = candidates.find(
      (c) =>
        c.address.startsWith('192.168.') ||
        c.address.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(c.address)
    );
    return (preferred || candidates[0] || {}).address || null;
  } catch (_) {
    return null;
  }
}

function runW2(args, timeoutMs = 15000) {
  return execFileAsync('w2', args, {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: process.env,
  }).then(
    ({ stdout, stderr }) => ({
      ok: true,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
    }),
    (err) => ({
      ok: false,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || err.message || ''),
      code: err.code,
    })
  );
}

async function getStatus(whistleHost, whistlePort) {
  const lanIp = getLanIpv4();
  const proxyAddress = lanIp ? `${lanIp}:${whistlePort}` : `127.0.0.1:${whistlePort}`;
  const cli = await runW2(['status']);
  const text = `${cli.stdout}\n${cli.stderr}`;
  const runningByCli = /running|pid|listen|port/i.test(text) && !/No running Whistle/i.test(text);

  let runningByHttp = false;
  let httpError = null;
  try {
    await cgiRequest(whistleHost, whistlePort, 'GET', '/cgi-bin/init');
    runningByHttp = true;
  } catch (e) {
    httpError = e.message;
  }

  const running = runningByHttp || runningByCli;
  return {
    running,
    runningByHttp,
    runningByCli,
    whistleHost,
    whistlePort,
    lanIp,
    proxyAddress,
    uiUrl: `http://${whistleHost}:${whistlePort}`,
    cliText: text.trim(),
    httpError,
  };
}

async function startWhistle(whistleHost, whistlePort) {
  const status = await getStatus(whistleHost, whistlePort);
  if (status.runningByHttp) {
    return { alreadyRunning: true, status };
  }

  // 后台启动，避免阻塞
  await new Promise((resolve, reject) => {
    const child = spawn(
      'w2',
      ['start', '-p', String(whistlePort)],
      {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      }
    );
    child.on('error', reject);
    child.unref();
    resolve();
  });

  // 轮询等待 CGI 可用
  const deadline = Date.now() + 20000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await cgiRequest(whistleHost, whistlePort, 'GET', '/cgi-bin/init');
      const next = await getStatus(whistleHost, whistlePort);
      return { alreadyRunning: false, status: next };
    } catch (e) {
      lastError = e.message;
      await sleep(500);
    }
  }
  throw new Error(`w2 启动超时: ${lastError || 'unknown'}`);
}

async function stopWhistle(whistleHost, whistlePort) {
  const result = await runW2(['stop']);
  await sleep(500);
  const status = await getStatus(whistleHost, whistlePort);
  return { result, status };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cgiRequest(host, port, method, cgiPath, body) {
  // 使用 querystring，与 Whistle WebUI 一致；避免部分环境下表单字段异常
  const payload =
    body == null
      ? null
      : typeof body === 'string'
        ? body
        : querystring.stringify(
            Object.entries(body).reduce((acc, [k, v]) => {
              if (v !== undefined && v !== null) acc[k] = String(v);
              return acc;
            }, {})
          );

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        path: cgiPath,
        method,
        headers: {
          Accept: 'application/json, text/plain, */*',
          ...(payload
            ? {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`CGI ${cgiPath} HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (_) {
            resolve({ raw: text });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`CGI 超时: ${cgiPath}`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function listRules(host, port) {
  return cgiRequest(host, port, 'GET', '/cgi-bin/rules/list');
}

/** 列出用户 Rules 分组（含 Default） */
async function listRuleGroups(host, port) {
  const data = await listRules(host, port);
  const groups = [
    {
      name: 'Default',
      selected: !data.defaultRulesIsDisabled,
      isDefault: true,
    },
  ];
  for (const item of data.list || []) {
    if (!item || !item.name) continue;
    // Whistle 分组目录名以 \r 开头，跳过
    if (item.name.charCodeAt(0) === 13) continue;
    groups.push({
      name: item.name,
      selected: !!item.selected,
      isDefault: false,
    });
  }
  return {
    groups,
    defaultRulesIsDisabled: !!data.defaultRulesIsDisabled,
  };
}

async function getRuleValue(host, port, name) {
  const q = encodeURIComponent(name);
  return cgiRequest(host, port, 'GET', `/cgi-bin/rules/value?name=${q}`);
}

async function addRules(host, port, name, value, selected = true) {
  return cgiRequest(host, port, 'POST', '/cgi-bin/rules/add', {
    name,
    value,
    selected: selected ? '1' : '',
    clientId: 'whistle-mock',
  });
}

/**
 * 注意：Whistle 的 /cgi-bin/rules/select 在未传 value 时会把规则写成空串。
 * 因此这里必须带上当前规则正文，或改用 add + selected。
 */
async function selectRules(host, port, name, value) {
  const body = {
    name,
    clientId: 'whistle-mock',
  };
  if (typeof value === 'string') {
    body.value = value;
  }
  return cgiRequest(host, port, 'POST', '/cgi-bin/rules/select', body);
}

async function addValue(host, port, name, value) {
  return cgiRequest(host, port, 'POST', '/cgi-bin/values/add', {
    name,
    value,
    clientId: 'whistle-mock',
  });
}

async function removeValue(host, port, name) {
  return cgiRequest(host, port, 'POST', '/cgi-bin/values/remove', {
    name,
    clientId: 'whistle-mock',
  });
}

module.exports = {
  getLanIpv4,
  getStatus,
  startWhistle,
  stopWhistle,
  cgiRequest,
  listRules,
  listRuleGroups,
  getRuleValue,
  addRules,
  selectRules,
  addValue,
  removeValue,
};
