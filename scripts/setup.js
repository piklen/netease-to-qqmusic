#!/usr/bin/env node
'use strict';

/**
 * 一次性环境准备：创建 .venv 并安装 Python 依赖。
 * 幂等、可重复执行；--check 只检查不安装，供 CI 使用。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { root, findPython, checkPython } = require('../src/lib/paths');
const { ok, warn, fail, info, step, color } = require('../src/lib/ui');

const checkOnly = process.argv.includes('--check');
const venvDir = path.join(root, '.venv');
const isWindows = process.platform === 'win32';
const venvPython = isWindows ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`命令失败（${result.status}）：${command} ${args.join(' ')}`);
}

function hasVenv() {
  return fs.existsSync(venvPython);
}

function createVenv() {
  const base = findPython();
  if (!base) throw new Error('找不到 Python 3.10+。请先安装 Python：https://www.python.org/downloads/');
  info(`使用 ${base} 创建 .venv …`);
  run(base, ['-m', 'venv', venvDir]);
}

function install() {
  const pip = [venvPython, '-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', path.join(root, 'requirements.txt')];
  info('安装 Python 依赖（首次约 1 分钟）…');
  run(pip[0], pip.slice(1));
}

function main() {
  step('环境准备');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 18) throw new Error(`需要 Node.js ≥ 18，当前 ${process.versions.node}`);
  ok(`Node.js v${process.versions.node}`);

  if (!fs.existsSync(path.join(root, 'node_modules'))) {
    if (checkOnly) throw new Error('未安装 Node 依赖，请运行 npm install');
    info('安装 Node 依赖…');
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund']);
  }
  ok('Node 依赖已就绪');

  if (!hasVenv()) {
    if (checkOnly) throw new Error('未创建 .venv，请运行 npm run setup');
    createVenv();
  }
  let check = checkPython(venvPython);
  if (!check.ok) {
    if (checkOnly) throw new Error(`Python 依赖缺失：${check.missing.join(', ')}。请运行 npm run setup`);
    install();
    check = checkPython(venvPython);
  }
  if (!check.ok) throw new Error(`Python 依赖仍缺失：${check.missing?.join(', ') || check.reason}`);

  ok(`Python ${check.version}，依赖已就绪`);
  console.log(`\n${color.bold('下一步')}`);
  console.log('  node bin/n2q.js login      # 或 npm run n2q -- login');
  console.log('  node bin/n2q.js export');
  console.log('  node bin/n2q.js prepare');
  console.log('  node bin/n2q.js review');
  console.log('  node bin/n2q.js import --albums --artists');
  console.log('  node bin/n2q.js verify\n');
  console.log(color.dim('安装为全局命令：npm link 后可直接使用 n2q'));
}

try {
  main();
} catch (error) {
  fail(error.message);
  process.exitCode = 1;
}
