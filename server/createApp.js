const path = require('path');
const express = require('express');
const { loadConfig } = require('./config');
const whistle = require('./whistleClient');
const caseScanner = require('./caseScanner');
const { applyCase, clearCase, getActiveCase } = require('./applyCase');
const {
  applyMockByPath,
  clearMockByPath,
  getActiveFileMocks,
} = require('./applyMock');

function syncEndpointFromHostHeader(req, config) {
  const hostHeader = String(req.headers.host || '');
  const m = /^([^:]+):(\d+)$/.exec(hostHeader);
  if (!m) return;
  const host = m[1] === 'localhost' ? '127.0.0.1' : m[1];
  const port = Number(m[2]);
  if (!port) return;
  // 插件模式下，页面本身就挂在 Whistle UI 端口上，优先跟 Host 对齐
  config.whistleHost = host;
  config.whistlePort = port;
}

async function syncWhistleEndpoint(config) {
  const status = await whistle.getStatus(config.whistleHost, config.whistlePort);
  whistle.bindConfigEndpoint(config, status);
  return status;
}

function createApp(options = {}) {
  const mode = options.mode || 'standalone';
  const config = loadConfig();
  const app = express();

  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use((req, res, next) => {
    if (mode === 'plugin') {
      syncEndpointFromHostHeader(req, config);
    }
    next();
  });

  app.get('/api/config', (req, res) => {
    res.json({
      mode,
      myGitlabDir: config.myGitlabDir,
      gitlabProjectKey: config.gitlabProjectKey,
      projectName: config.projectName,
      projectRoot: config.projectRoot,
      caseRoots: config.caseRoots,
      whistlePort: config.whistlePort,
      whistleHost: config.whistleHost,
      ruleGroup: config.ruleGroup,
      port: config.port,
    });
  });

  app.get('/api/rules/groups', async (req, res) => {
    try {
      await syncWhistleEndpoint(config);
      const data = await whistle.listRuleGroups(
        config.whistleHost,
        config.whistlePort
      );
      const names = (data.groups || []).map((g) => g.name);
      // 当前选择若不在列表中，仍展示出来
      if (config.ruleGroup && !names.includes(config.ruleGroup)) {
        data.groups.unshift({
          name: config.ruleGroup,
          selected: false,
          isDefault: config.ruleGroup === 'Default',
          missing: true,
        });
      }
      res.json({
        ok: true,
        ruleGroup: config.ruleGroup,
        ...data,
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
        ruleGroup: config.ruleGroup,
        groups: [{ name: 'Default', selected: true, isDefault: true }],
      });
    }
  });

  app.post('/api/rules/group', (req, res) => {
    try {
      const name = String((req.body && req.body.name) || '').trim();
      if (!name) {
        return res.status(400).json({ ok: false, error: '需要规则组 name' });
      }
      config.ruleGroup = name;
      res.json({ ok: true, ruleGroup: config.ruleGroup });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/status', async (req, res) => {
    try {
      const status = await syncWhistleEndpoint(config);
      res.json({ ok: true, mode, ...status, ruleGroup: config.ruleGroup });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/w2/start', async (req, res) => {
    try {
      const result = await whistle.startWhistle(
        config.whistleHost,
        config.whistlePort
      );
      if (result && result.status) {
        whistle.bindConfigEndpoint(config, result.status);
      }
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/w2/stop', async (req, res) => {
    try {
      const result = await whistle.stopWhistle(
        config.whistleHost,
        config.whistlePort
      );
      if (result && result.status) {
        whistle.bindConfigEndpoint(config, result.status);
      }
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/cases/tree', (req, res) => {
    try {
      const tree = caseScanner.buildTree(config);
      const leafTotal = caseScanner.countSelectableLeaves(config);
      res.json({ ok: true, leafTotal, ...tree });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/cases/children', (req, res) => {
    try {
      const rel = req.query.path || '';
      const children = caseScanner.listChildren(config, rel);
      res.json({ ok: true, path: caseScanner.normalizeRel(rel), children });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/files/save', (req, res) => {
    try {
      const rel = req.body && req.body.path;
      const content = req.body && req.body.content;
      if (!rel) {
        return res.status(400).json({ ok: false, error: '需要 path' });
      }
      if (typeof content !== 'string') {
        return res.status(400).json({ ok: false, error: '需要 content' });
      }
      const result = caseScanner.writeFileContent(config, rel, content);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/cases/detail', (req, res) => {
    try {
      const rel = req.query.path;
      if (!rel) {
        return res.status(400).json({ ok: false, error: '需要 path' });
      }
      const detail = caseScanner.getNodeDetail(config, rel);

      if (detail.type === 'file') {
        return res.json({
          ok: true,
          ruleGroup: config.ruleGroup,
          ...detail,
        });
      }

      if (detail.type === 'case') {
        const apis = detail.apis.map((a) => ({
          soaName: a.soaName,
          mockFile: a.mockFile,
          ok: a.ok,
          error: a.error,
          jsonRel: a.jsonRel,
          valueName: a.valueName,
          ruleLine:
            a.ok && a.valueName
              ? caseScanner.buildRuleLine(a.soaName, a.valueName)
              : null,
          preview: a.content ? a.content.slice(0, 400) : null,
        }));
        return res.json({
          ok: true,
          type: 'case',
          path: detail.path,
          name: detail.name,
          mockId: detail.mockId,
          mockIds: detail.mockIds,
          selectable: true,
          files: detail.files,
          ruleGroup: config.ruleGroup,
          apis,
        });
      }

      res.json({
        ok: true,
        type: 'dir',
        path: detail.path,
        name: detail.name,
        mockId: detail.mockId,
        selectable: false,
        folders: detail.folders,
        files: detail.files,
        ruleGroup: config.ruleGroup,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get('/api/cases/active', async (req, res) => {
    try {
      await syncWhistleEndpoint(config);
      const result = await getActiveCase(config);
      const files = await getActiveFileMocks(config);
      const warning = result.warning || files.warning || null;
      res.json({
        ok: true,
        ...result,
        files: files.files || [],
        warning,
        whistleHost: config.whistleHost,
        whistlePort: config.whistlePort,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/cases/apply', async (req, res) => {
    try {
      await syncWhistleEndpoint(config);
      const rel = req.body && req.body.path;
      if (!rel) {
        return res.status(400).json({ ok: false, error: '需要 path' });
      }
      const result = await applyCase(config, { path: rel });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e.message,
        whistleHost: config.whistleHost,
        whistlePort: config.whistlePort,
        ruleGroup: config.ruleGroup,
      });
    }
  });

  app.post('/api/cases/clear', async (req, res) => {
    try {
      const result = await clearCase(config);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/mocks/apply', async (req, res) => {
    try {
      const rel = req.body && req.body.path;
      if (!rel) {
        return res.status(400).json({ ok: false, error: '需要 path' });
      }
      const result = await applyMockByPath(config, rel);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/mocks/clear', async (req, res) => {
    try {
      const rel = req.body && req.body.path;
      if (!rel) {
        return res.status(400).json({ ok: false, error: '需要 path' });
      }
      const result = await clearMockByPath(config, rel);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || 'server error' });
  });

  return app;
}

module.exports = { createApp };
