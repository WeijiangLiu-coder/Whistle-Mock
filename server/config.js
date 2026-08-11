const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const MY_GITLAB_DIR = path.join(os.homedir(), 'my-gitlab');

/** 读取 ~/my-gitlab 下所有项目目录（与组内约定一致） */
function listMygitlabProjects() {
  if (!fs.existsSync(MY_GITLAB_DIR)) {
    return [];
  }
  try {
    return fs
      .readdirSync(MY_GITLAB_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({
        name: e.name,
        fullPath: path.join(MY_GITLAB_DIR, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  } catch (_) {
    return [];
  }
}

/**
 * 自动定位 mock 仓库：优先匹配名称含 2773 的目录（如 testHub_prod_2773）
 * 仍可通过 config.projectRoot 显式覆盖（一般不需要）
 */
function resolveProjectRoot(config) {
  if (config.projectRoot) {
    return path.resolve(config.projectRoot);
  }

  const marker = String(config.gitlabProjectKey || '2773');
  const projects = listMygitlabProjects();
  if (!projects.length) {
    throw new Error(
      `未找到目录 ${MY_GITLAB_DIR}，请先将仓库 clone 到 ~/my-gitlab`
    );
  }

  const hit =
    projects.find((p) => p.name.includes(marker)) ||
    projects.find((p) => /testhub/i.test(p.name) && p.name.includes(marker));

  if (!hit) {
    const names = projects.map((p) => p.name).join(', ');
    throw new Error(
      `未在 ${MY_GITLAB_DIR} 找到包含「${marker}」的仓库。当前项目：${names}`
    );
  }

  return hit.fullPath;
}

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = JSON.parse(raw);
  const projectRoot = resolveProjectRoot(config);

  return {
    port: config.port || 3789,
    myGitlabDir: MY_GITLAB_DIR,
    gitlabProjectKey: String(config.gitlabProjectKey || '2773'),
    projectRoot,
    projectName: path.basename(projectRoot),
    mockConfigFile: path.resolve(
      projectRoot,
      config.mockConfigFile || 'testhub.mock.config.json'
    ),
    caseRoots: Array.isArray(config.caseRoots) && config.caseRoots.length
      ? config.caseRoots
      : [
          'Ctrip端门票活动向导测试用例',
          'Trip端门票活动向导测试用例',
          'TripPC端门票活动向导测试用例',
        ],
    whistlePort: config.whistlePort || 8899,
    whistleHost: config.whistleHost || '127.0.0.1',
    ruleGroup: config.ruleGroup || 'Default',
    mockRoot: path.join(projectRoot, 'base-data'),
    valueNameStrategy: config.valueNameStrategy || 'api-filename',
    defaultApi: config.defaultApi || 'getOrderDetailV1',
  };
}

module.exports = {
  loadConfig,
  CONFIG_PATH,
  MY_GITLAB_DIR,
  listMygitlabProjects,
  resolveProjectRoot,
};
