'use strict';

const fs = require('node:fs');
const path = require('node:path');

const isTTY = Boolean(process.stdout.isTTY);
const useColor = isTTY && process.env.NO_COLOR == null && process.env.TERM !== 'dumb';

function paint(code) {
  return (text) => (useColor ? `[${code}m${text}[0m` : String(text));
}

const color = {
  dim: paint('2'),
  bold: paint('1'),
  green: paint('32'),
  yellow: paint('33'),
  red: paint('31'),
  cyan: paint('36'),
  magenta: paint('35'),
};

const symbols = {
  info: color.cyan('i'),
  ok: color.green('✓'),
  warn: color.yellow('!'),
  error: color.red('×'),
  arrow: color.dim('→'),
};

function info(message) { console.log(`${symbols.info} ${message}`); }
function ok(message) { console.log(`${symbols.ok} ${message}`); }
function warn(message) { console.warn(`${symbols.warn} ${color.yellow(message)}`); }
function fail(message) { console.error(`${symbols.error} ${color.red(message)}`); }
function step(message) { console.log(`\n${color.bold(message)}`); }

/** 单行刷新的进度条；非 TTY 环境只在整十百分比时输出，避免刷屏。 */
class Progress {
  constructor(label, total, { width = 24 } = {}) {
    this.label = label;
    this.total = Math.max(1, total);
    this.width = width;
    this.start = Date.now();
    this.kind = 'count';
    this.lastPrinted = -1;
  }

  update(value, extra = '') {
    const width = Math.max(1, this.total);
    const ratio = Math.min(1, Math.max(0, value / width));
    const percent = Math.floor(ratio * 100);
    if (!isTTY && percent !== 100 && percent % 10 !== 0) return;
    if (isTTY && percent === this.lastPrinted && !extra) return;
    this.lastPrinted = percent;
    const filled = Math.round(ratio * this.width);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(this.width - filled)}`;
    const elapsed = (Date.now() - this.start) / 1000;
    const rate = value > 0 ? `${(value / elapsed).toFixed(1)}/s` : '';
    const line = `${this.label} ${color.dim('[')}${color.green(bar)}${color.dim(']')} ${String(value).padStart(String(this.total).length)}/${this.total} ${color.dim(`${percent}% ${rate} ${extra}`.trim())}`;
    if (isTTY) process.stdout.write(`\r[2K${line}`);
    else console.log(line);
  }

  done(extra = '') {
    this.update(this.total, extra);
    if (isTTY) process.stdout.write('\n');
  }
}

function elapsed(startedAt) {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
}

function banner(version) {
  console.log(color.bold(`\n网易云音乐 ${symbols.arrow} QQ 音乐  v${version}`));
  console.log(color.dim('本地运行 · 不经过第三方服务器 · 写入前需要交互确认\n'));
}

/** 统一渲染表格；按显示宽度补齐中英文混排。 */
function table(rows, { gap = 3 } = {}) {
  if (!rows.length) return '';
  const columns = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => Array.from({ length: columns }, (_, index) => String(row[index] ?? '')));
  const widths = Array.from({ length: columns }, (_, column) => Math.max(...normalized.map((row) => displayWidth(row[column]))));
  return normalized.map((row, rowIndex) => row.map((cell, column) => {
    const text = rowIndex === 0 ? color.bold(cell) : cell;
    if (column === columns - 1) return text;
    const padding = ' '.repeat(Math.max(1, widths[column] - displayWidth(cell) + gap));
    return `${text}${padding}`;
  }).join('')).join('\n');
}

// 终端宽度：CJK 字符占两格，仅用于报告排版。
function displayWidth(text) {
  let width = 0;
  for (const char of text) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/.test(char) ? 2 : 1;
  return width;
}

module.exports = {
  color, symbols, info, ok, warn, fail, step, Progress, elapsed, banner, table, isTTY,
};
