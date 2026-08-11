#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const unlink = process.argv.includes('--unlink');
const pluginName = 'whistle.mock-console';
const projectRoot = path.resolve(__dirname, '..');

// Whistle 会直接扫描 CUSTOM_PLUGIN_PATH 下的 whistle.* 目录
// （不是 custom_plugins/node_modules）
const linkCandidates = [
  path.join(os.homedir(), '.WhistleAppData', 'custom_plugins', pluginName),
  path.join(os.homedir(), '.WhistleAppData', '.whistle', 'node_modules', pluginName),
];

function ensureLink(linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  } catch (_) {}
  fs.symlinkSync(projectRoot, linkPath, 'dir');
  console.log(`已链接: ${linkPath}`);
  console.log(`  → ${projectRoot}`);
}

function removeLink(linkPath) {
  try {
    fs.lstatSync(linkPath);
    fs.rmSync(linkPath, { recursive: true, force: true });
    console.log(`已移除: ${linkPath}`);
  } catch (_) {
    // ignore
  }
}

if (unlink) {
  linkCandidates.forEach(removeLink);
  // 清理旧错误路径
  removeLink(
    path.join(
      os.homedir(),
      '.WhistleAppData',
      'custom_plugins',
      'node_modules',
      pluginName
    )
  );
} else {
  // 清理旧错误路径
  removeLink(
    path.join(
      os.homedir(),
      '.WhistleAppData',
      'custom_plugins',
      'node_modules',
      pluginName
    )
  );
  linkCandidates.forEach(ensureLink);
}

const restart = spawnSync('w2', ['restart'], {
  encoding: 'utf8',
  env: process.env,
});
if (restart.error) {
  console.log('未自动重启 w2，请手动执行: w2 restart');
} else {
  console.log((restart.stdout || '') + (restart.stderr || ''));
  console.log('打开 Whistle UI → Plugins → mock-console，或 Tools → Mock');
  console.log('或直接访问: http://127.0.0.1:8899/whistle.mock-console/');
}
