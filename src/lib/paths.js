'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');

/** 数据目录优先级：--data-dir > N2Q_DATA_DIR > 项目 ./data。环境变量便于多账号隔离。 */
function resolveDataDir(value) {
  const chosen = value || process.env.N2Q_DATA_DIR || path.join(root, 'data');
  return path.resolve(chosen);
}

function exists(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
}

/** 查找 Python：显式 --python > 项目 .venv > PATH 中的 python3/python。 */
function findPython(explicit) {
  if (explicit) return explicit;
  const candidates = process.platform === 'win32'
    ? [path.join(root, '.venv', 'Scripts', 'python.exe')]
    : [path.join(root, '.venv', 'bin', 'python')];
  for (const candidate of candidates) if (exists(candidate)) return candidate;
  for (const name of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    try {
      const result = spawnSync(name, ['--version'], { stdio: 'ignore' });
      if (result.status === 0) return name;
    } catch { /* 继续尝试下一个 */ }
  }
  return null;
}

const REQUIRED_MODULES = [
  ['qqmusic_api', 'qqmusic-api-python==0.8.2'],
  ['qrcode', 'qrcode==8.2'],
  ['PIL', 'Pillow'],
];

/** 返回缺失的 Python 依赖列表及修复命令，不抛异常。 */
function checkPython(python, { skipModules = false } = {}) {
  if (!python) {
    return { ok: false, reason: '找不到 Python 解释器', missing: REQUIRED_MODULES, fix: '运行 npm run setup 自动创建 .venv' };
  }
  const modules = skipModules ? [] : REQUIRED_MODULES.map(([name]) => name);
  const probe = `import importlib.util as u, json, sys\nprint(json.dumps({"version": sys.version.split()[0], "missing": [m for m in ${JSON.stringify(modules)} if u.find_spec(m) is None]}))`;
  const result = spawnSync(python, ['-c', probe], { encoding: 'utf8' });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim().split('\n').filter(Boolean);
    return {
      ok: false,
      reason: `Python 无法启动${stderr.length ? `：${stderr[stderr.length - 1]}` : ''}`,
      missing: REQUIRED_MODULES.map(([name]) => name),
      fix: '运行 npm run setup',
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ok: false, reason: '无法解析 Python 版本信息', missing: [], fix: '运行 npm run setup' };
  }
  const { version, missing } = parsed;
  const install = missing.map((name) => REQUIRED_MODULES.find(([module]) => module === name)?.[1] || name).join(' ');
  return {
    ok: missing.length === 0,
    reason: missing.length ? `缺少依赖 ${missing.join(', ')}` : '',
    version,
    missing,
    fix: missing.length ? (process.platform === 'win32'
      ? `.venv\\Scripts\\pip install ${install}`
      : `.venv/bin/pip install ${install}`) : null,
  };
}

function helperPath() {
  return path.join(root, 'src', 'py', 'qq_bridge.py');
}

function homeDir() {
  return os.homedir();
}

function relative(file) {
  const rel = path.relative(process.cwd(), file);
  return rel && !rel.startsWith('..') ? rel : file;
}

module.exports = {
  root, resolveDataDir, findPython, checkPython, helperPath, homeDir, relative, exists,
};
