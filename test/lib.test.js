'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { findPython, checkPython, resolveDataDir } = require('../src/lib/paths');
const { redact, normalize, fileSafe, atomicWrite, readJson } = require('../src/lib/util');

test('能找到 Python 并识别版本', () => {
  const python = findPython();
  assert.ok(python, '测试机需要 Python 3.10+');
  const result = checkPython(python, { skipModules: true });
  assert.equal(result.ok, true);
  assert.match(result.version, /^3\./);
});

test('缺少模块时给出可执行的修复命令', () => {
  const python = findPython();
  const result = checkPython(python, { skipModules: false });
  if (result.ok) {
    assert.equal(result.fix, null);
    assert.deepEqual(result.missing, []);
  } else {
    assert.ok(result.fix.includes('pip install'));
    assert.ok(result.missing.length > 0);
  }
});

test('不存在的解释器不会崩溃', () => {
  const result = checkPython('/nonexistent/python-binary');
  assert.equal(result.ok, false);
  assert.ok(result.reason);
});

test('数据目录支持环境变量与显式参数', () => {
  const previous = process.env.N2Q_DATA_DIR;
  process.env.N2Q_DATA_DIR = '/tmp/n2q-env-check';
  assert.equal(resolveDataDir(), '/tmp/n2q-env-check');
  assert.equal(resolveDataDir('/tmp/explicit'), '/tmp/explicit');
  if (previous === undefined) delete process.env.N2Q_DATA_DIR;
  else process.env.N2Q_DATA_DIR = previous;
});

test('凭据字段在日志中被脱敏', () => {
  const text = redact('Cookie: MUSIC_U=abc123; qm_keyst=secret; uin=12345');
  assert.ok(!text.includes('abc123'));
  assert.ok(!text.includes('secret'));
  assert.ok(text.includes('[REDACTED]'));
});

test('原子写入可覆盖已有 JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n2q-util-'));
  const file = path.join(dir, 'nested', 'a.json');
  atomicWrite(file, JSON.stringify({ a: 1 }));
  atomicWrite(file, JSON.stringify({ a: 2 }));
  assert.equal(readJson(file).a, 2);
});

test('文件名清理保留可读性并限制长度', () => {
  assert.equal(fileSafe('a/b\\c:d'), 'a_b_c_d');
  assert.ok(fileSafe('x'.repeat(300)).length <= 100);
});

test('归一化不会把不同语言当成同一首', () => {
  assert.notEqual(normalize('Hello'), normalize('哈喽'));
});
