'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { cleanError } = require('../lib/util');
const { checkPython } = require('../lib/paths');

const BRIDGE_TIMEOUT = 120000;

/**
 * Node 与 Python 之间的 JSON Lines 通道。
 * - 每次请求都有超时，避免 SDK 卡死导致整个迁移挂起；
 * - Python 退出时立即唤醒所有等待者，断点信息由上层保存。
 */
class QQBridge {
  constructor({ python, helper, dataDir, log = () => {}, timeout = BRIDGE_TIMEOUT }) {
    this.python = python;
    this.helper = helper;
    this.dataDir = dataDir;
    this.log = log;
    this.timeout = timeout;
    this.buffer = '';
    this.waiters = [];
    this.ready = null;
    this.closed = false;
    this.stderrTail = [];
  }

  async start() {
    if (!fs.existsSync(this.helper)) throw new Error(`缺少 QQ 桥接脚本：${this.helper}`);
    // 测试替身（mock）不需要真实 SDK 依赖。
    const isRealHelper = path.basename(this.helper) === 'qq_bridge.py';
    const check = checkPython(this.python, { skipModules: !isRealHelper });
    if (!check.ok) {
      throw new Error(`QQ 依赖未就绪：${check.reason}\n请执行：${check.fix || 'npm run setup'}`);
    }
    this.child = spawn(this.python, [this.helper, JSON.stringify({ dataDir: this.dataDir })], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const text = cleanError(chunk);
      this.stderrTail.push(text);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
      for (const line of text.split('\n')) if (line.trim()) this.log(`  ${line.trim()}`);
    });
    this.child.on('error', (error) => this.fail(new Error(`无法启动 Python：${cleanError(error)}`)));
    this.child.on('exit', (code, signal) => {
      if (!this.closed) this.fail(new Error(`QQ 桥接进程已退出（${signal || code}）${this.stderrTail.length ? `：${this.stderrTail.slice(-3).join(' ').slice(0, 300)}` : ''}`));
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));

    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    return this.ready;
  }

  onData(chunk) {
    this.buffer += chunk;
    while (this.buffer.includes('\n')) {
      const index = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      if (!line.startsWith('{')) {
        // Python 的人类可读输出（登录提示、二维码说明）直接透传。
        this.log(line);
        continue;
      }
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        this.log(line);
        continue;
      }
      if (payload.ready) { this.readyResolve?.(payload); continue; }
      if (payload.fatal) { this.fail(new Error(cleanError(payload.error))); continue; }
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(payload);
      }
    }
  }

  fail(error) {
    this.readyReject?.(error);
    this.readyReject = null;
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: false, error: cleanError(error) });
    }
  }

  async send(command) {
    if (this.closed || !this.child) throw new Error('QQ 连接未启动。');
    const response = new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve({ ok: false, error: `QQ 操作超时（${command.command}，${this.timeout / 1000}s）` });
      }, this.timeout);
      this.waiters.push(waiter);
    });
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    const result = await response;
    if (!result.ok) throw new Error(result.error || `QQ 操作失败：${command.command}`);
    return result;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.child) return;
    try { this.child.stdin.end(); } catch { /* 进程可能已退出 */ }
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 3000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

module.exports = { QQBridge };
