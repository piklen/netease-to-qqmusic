#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { root, findPython } = require('../src/lib/paths');
const { fail, info } = require('../src/lib/ui');

const python = findPython();
if (!python) {
  fail('找不到 Python，请先运行 npm run setup');
  process.exit(1);
}
info(`使用 ${python}`);
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_*.py', '-v'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PYTHONPATH: root },
});
process.exit(result.status ?? 1);
