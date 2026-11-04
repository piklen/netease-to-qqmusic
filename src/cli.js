'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { NeteaseClient } = require('./core/netease');
const { Migration } = require('./core/migrate');
const { Matcher } = require('./core/search');
const { SearchCache } = require('./core/search-cache');
const { writeReports, writeFallbackAudit, summarize } = require('./core/report');
const { findPython, resolveDataDir, helperPath, checkPython, relative } = require('./lib/paths');
const { readJson, writeJson, fileSafe } = require('./lib/util');
const {
  info, ok, warn, step, color, table, Progress, elapsed,
} = require('./lib/ui');

const VERSION = require('../package.json').version;

const COMMANDS = {
  help: {
    summary: '显示帮助；n2q help <命令> 查看单项用法',
    usage: 'n2q help [命令]',
    flags: { topic: 'string' },
  },
  login: {
    summary: '登录网易云并保存本机登录态',
    usage: 'n2q login [--port 39876]',
    flags: { port: 'number' },
  },
  export: {
    summary: '备份网易云歌单、收藏专辑、关注歌手，并生成官方导入文本',
    usage: 'n2q export [--backup FILE] [--no-official-chunks]',
    flags: { backup: 'path', 'no-official-chunks': 'boolean', port: 'number' },
  },
  prepare: {
    summary: '搜索 QQ 音乐并生成匹配结果（不写入账号）',
    usage: 'n2q prepare [--owned-only] [--playlist NAME] [--no-fallback] [--rebuild]',
    flags: {
      'owned-only': 'boolean', playlist: 'string', 'no-fallback': 'boolean', 'rebuild': 'boolean', port: 'number',
    },
  },
  review: {
    summary: '交互确认待处理项，写入 overrides.json',
    usage: 'n2q review [--only review|unmatched|all] [--list]',
    flags: { only: 'string', list: 'boolean' },
  },
  import: {
    summary: '写入 QQ 音乐：创建歌单、添加歌曲、收藏专辑和歌手',
    usage: 'n2q import [--dry-run] [--albums] [--artists] [--copy-collected] [--limit N]',
    flags: {
      'dry-run': 'boolean', albums: 'boolean', artists: 'boolean', 'copy-collected': 'boolean',
      limit: 'number', 'yes': 'boolean', 'allow-review': 'boolean', strict: 'boolean', 'batch-size': 'number', port: 'number',
    },
    examples: [
      'n2q import --dry-run                 # 先看清楚会做什么',
      'n2q import --albums --artists        # 正式写入（需输入 IMPORT）',
      'n2q import                           # 中断后重跑，自动跳过已完成项',
    ],
  },
  verify: {
    summary: '只读读取 QQ 歌单，核对导入结果',
    usage: 'n2q verify [--limit N]',
    flags: { limit: 'number', port: 'number' },
  },
  status: {
    summary: '查看断点、匹配统计和最近一次导入结果',
    usage: 'n2q status [--json]',
    flags: { json: 'boolean' },
  },
  report: {
    summary: '重新生成 review.csv / review.md / unresolved.json',
    usage: 'n2q report',
    flags: {},
  },
  logout: {
    summary: '删除本机保存的网易云/QQ 登录凭据',
    usage: 'n2q logout [--netease|--qq]',
    flags: { netease: 'boolean', qq: 'boolean' },
  },
  doctor: {
    summary: '检查 Node、Python、依赖、登录态和数据目录',
    usage: 'n2q doctor',
    flags: {},
  },
};

const GLOBAL_FLAGS = {
  'data-dir': 'path', 'backup': 'path', 'port': 'number', 'help': 'boolean', 'version': 'boolean',
  'verbose': 'boolean', 'python': 'path', 'json': 'boolean',
};

const FLAG_DESCRIPTIONS = {
  'data-dir': '数据目录（默认 ./data）',
  'backup': '指定备份文件（默认 data/latest-backup.json）',
  'port': '网易云本地接口端口（默认 39876）',
  'python': '指定 Python 解释器',
  'verbose': '显示底层请求与调试信息',
  'json': '以 JSON 输出',
  'help': '显示帮助',
  'version': '显示版本',
  'owned-only': '只匹配本人创建的歌单',
  'playlist': '只匹配名称包含该字符串的歌单',
  'no-fallback': '不生成“同歌手/同名热门”替代建议',
  'rebuild': '忽略上次匹配结果，全部重新搜索',
  'no-official-chunks': '不生成 QQ 官方文本导入分片',
  'only': 'review / unmatched / all',
  'list': '只列出待处理项，不进入交互',
  'dry-run': '演练：只展示计划，不连接 QQ、不写入',
  'albums': '同时收藏匹配到的专辑',
  'artists': '同时关注匹配到的歌手',
  'copy-collected': '把收藏他人的歌单复制为自己的 QQ 歌单',
  'limit': '最多处理多少张歌单（试跑时很有用）',
  'yes': '跳过 IMPORT 确认（仅限交互终端）',
  'allow-review': '待确认项直接采用推荐版本（有错配风险）',
  'strict': '首个失败立即停止（断点保留）',
  'batch-size': '每批写入歌曲数（默认 10，最大 30）',
  'netease': '只删除网易云登录态',
  'qq': '只删除 QQ 登录态',
  'topic': '命令名',
};

function camel(flag) {
  return flag.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help';
  const definition = COMMANDS[command];
  const flags = { ...GLOBAL_FLAGS, ...(definition?.flags || {}) };
  const options = {};
  const rest = argv.slice(command === 'help' ? 1 : 1);
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '-h') { options.help = true; continue; }
    if (arg === '-v') { options.verbose = true; continue; }
    if (!arg.startsWith('--')) {
      if (command === 'help' && !options.topic && COMMANDS[arg]) { options.topic = arg; continue; }
      throw new Error(`无法识别的位置参数：${arg}\n运行 n2q help ${command} 查看用法。`);
    }
    const [name, inlineValue] = arg.slice(2).split('=');
    const type = flags[name];
    if (!type) throw new Error(`未知参数：--${name}\n运行 n2q help ${command} 查看用法。`);
    const key = camel(name);
    if (type === 'boolean') {
      options[key] = inlineValue === undefined ? true : inlineValue !== 'false';
    } else {
      const value = inlineValue === undefined ? rest[++index] : inlineValue;
      if (value === undefined || value.startsWith('--')) throw new Error(`--${name} 缺少参数`);
      if (type === 'number') {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 0) throw new Error(`--${name} 需要非负整数`);
        options[key] = number;
      } else {
        options[key] = value;
      }
    }
  }
  return { command, options };
}

function printHelp(command) {
  if (!command || command === 'help') {    console.log(`\n${color.bold('网易云音乐 → QQ 音乐')} ${color.dim(`v${VERSION}`)}`);
    console.log(color.dim('本地运行 · 不经过第三方服务器 · 写入前必须确认\n'));
    console.log(color.bold('用法') + `  n2q <命令> [选项]\n`);
    for (const [name, definition] of Object.entries(COMMANDS)) {
      console.log(`  ${name.padEnd(9)} ${definition.summary}`);
    }
    console.log(`\n${color.bold('典型流程')}`);
    console.log('  n2q login              # 保存网易云登录态');
    console.log('  n2q export             # 备份收藏');
    console.log('  n2q prepare            # 匹配 QQ 音乐');
    console.log('  n2q review             # 交互处理待确认项');
    console.log('  n2q import --albums --artists');
    console.log('  n2q verify             # 只读核对结果');
    console.log(`\n${color.bold('全局选项')}`);
    console.log('  --data-dir DIR   数据目录（默认 ./data）');
    console.log('  --port N         网易云本地只读接口端口（默认 39876）');
    console.log('  --python PATH    指定 Python 解释器');
    console.log('  --verbose        显示底层请求与调试信息');
    console.log('  -h, --help       显示帮助');
    console.log(`\n运行 ${color.cyan('n2q help <命令>')} 查看单项用法。\n`);
    return;
  }
  const definition = COMMANDS[command];
  if (!definition) throw new Error(`未知命令：${command}`);
  console.log(`\n${color.bold(`n2q ${command}`)}  ${definition.summary}\n`);
  console.log(`用法：${definition.usage}\n`);
  const flags = { ...GLOBAL_FLAGS, ...definition.flags };
  if (Object.keys(flags).length) {
    console.log(color.bold('选项'));
    for (const [name, type] of Object.entries(flags)) {
      const hint = type === 'boolean' ? '' : type === 'number' ? ' N' : type === 'path' ? ' PATH' : ' VALUE';
      console.log(`  ${`--${name}${hint}`.padEnd(22)}${color.dim(FLAG_DESCRIPTIONS[name] || '')}`);
    }
  }
  if (definition.examples?.length) {
    console.log(`\n${color.bold('示例')}`);
    for (const example of definition.examples) console.log(`  ${color.cyan(example)}`);
  }
  console.log();
}

function context(options) {
  const dataDir = resolveDataDir(options.dataDir);
  const python = findPython(options.python);
  const log = options.verbose ? (line) => console.log(color.dim(`  ${line}`)) : () => {};
  return {
    options,
    dataDir,
    python,
    log,
    migration: new Migration({
      dataDir, python, helper: helperPath(), log, concurrency: options.concurrency,
    }),
  };
}

async function withNetease(options, dataDir, task, { login = true } = {}) {
  const client = new NeteaseClient({ dataDir, port: options.port || 39876, log: options.verbose ? console.log : () => {} });
  try {
    await client.start();
    if (login) {
      const account = await client.login();
      if (!account) throw new Error('网易云未登录。');
    }
    return await task(client);
  } finally {
    await client.stop();
  }
}

async function commandLogin(options, dataDir) {
  await withNetease(options, dataDir, async (client) => {
    if (client.cookie) {
      const account = await client.account();
      if (account) { ok(`已登录：${account.profile?.nickname || account.account.id}（登录态已在本机）`); return; }
    }
    await client.loginManual();
  }, { login: false });
}

async function commandExport(options, dataDir) {
  await withNetease(options, dataDir, async (client) => {
    step('导出收藏');
    const backup = await client.export();
    const filename = `netease-backup-${backup.exportedAt.replace(/[:.]/g, '-')}.json`;
    const file = path.join(dataDir, filename);
    writeJson(file, backup);
    writeJson(path.join(dataDir, 'latest-backup.json'), backup);

    let chunks = 0;
    if (!options.noOfficialChunks) chunks = writeOfficialChunks(dataDir, backup);

    const summary = client.summary(backup);
    step('导出完成');
    console.log(table([
      ['项目', '数量'],
      ['全部歌单', summary.playlists],
      ['本人歌单', summary.owned],
      ['本人曲目位置', String(summary.tracks)],
      ['去重歌曲', String(summary.uniqueTracks)],
      ['收藏专辑', summary.albums],
      ['关注歌手', summary.artists],
    ].map(([a, b]) => [a, String(b)])));
    ok(`备份已保存：${relative(file)}`);
    if (chunks) info(`QQ 官方文本导入分片：${chunks} 份，位于 ${relative(path.join(dataDir, 'official-import'))}`);
    info(`下一步：${color.cyan('n2q prepare')} 搜索 QQ 音乐并生成匹配结果`);
  });
}

function writeOfficialChunks(dataDir, backup) {
  const directory = path.join(dataDir, 'official-import');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let count = 0;
  for (const playlist of backup.playlists) {
    for (let offset = 0; offset < playlist.tracks.length; offset += 100) {
      const content = playlist.tracks.slice(offset, offset + 100)
        .map((track) => `${track.name} - ${track.artists.map((artist) => artist.name).join('/')}`).join('\n');
      const filename = `${String(++count).padStart(3, '0')}-${fileSafe(playlist.name)}-${offset + 1}.txt`;
      fs.writeFileSync(path.join(directory, filename), `${content}\n`, { mode: 0o600 });
    }
  }
  return count;
}

async function commandPrepare(options, dataDir, migration) {
  const backup = migration.readBackup(options.backup);
  if (backup.playlists.length > 60 && !options.ownedOnly && !options.playlist) {
    warn('备份包含较多歌单，默认只匹配本人歌单；收藏他人歌单仅备份。');
    options.ownedOnly = true;
  }

  const selections = backup.playlists
    .filter((playlist) => (options.ownedOnly ? playlist.owned : true))
    .filter((playlist) => (options.playlist ? playlist.name.includes(options.playlist) : true));
  if (!selections.length) throw new Error('没有符合条件的歌单；检查 --owned-only / --playlist。');

  const partialFile = path.join(dataDir, 'matches.partial.json');
  const matchesFile = path.join(dataDir, 'matches.json');
  let matches = { version: 2, exportedAt: backup.exportedAt, playlists: [], albums: [], artists: [] };
  if (!options.rebuild) {
    for (const candidate of [matchesFile, partialFile]) {
      if (!fs.existsSync(candidate)) continue;
      const previous = readJson(candidate, '上次匹配结果');
      if (previous.exportedAt === backup.exportedAt) { matches = previous; break; }
    }
  }
  const completed = new Map(matches.playlists.map((playlist) => [playlist.sourceId, playlist]));

  const bridge = await migration.openBridge();
  const cache = new SearchCache(path.join(dataDir, 'search-cache-authenticated.json'));
  const matcher = new Matcher({ bridge, cache, useFallback: !options.noFallback });
  const started = Date.now();
  try {
    const ordered = selections.filter((playlist) => !completed.has(playlist.sourceId));
    const skipped = selections.length - ordered.length;
    if (skipped) info(`复用已完成 ${skipped} 张歌单的匹配结果。`);

    for (const playlist of ordered) {
      step(`匹配：${playlist.name}（${playlist.tracks.length} 首）`);
      const progress = new Progress('  ', playlist.tracks.length);
      const tracks = [];
      let done = 0;
      for (const [trackIndex, track] of playlist.tracks.entries()) {
        const result = await matcher.song(track);
        tracks.push({
          key: `track:${playlist.sourceId}:${trackIndex}`,
          source: track,
          status: result.status,
          reason: result.reason || '',
          selected: result.best || null,
          candidates: result.candidates,
        });
        done += 1;
        progress.update(done);
      }
      progress.done();
      const playlistResult = { ...playlist, tracks };
      matches.playlists = matches.playlists.filter((item) => item.sourceId !== playlist.sourceId).concat(playlistResult);
      const allKeys = new Set(selections.map((item) => item.sourceId));
      matches.playlists = matches.playlists.filter((item) => allKeys.has(item.sourceId));
      matches.playlists.sort((left, right) => backup.playlists.findIndex((item) => item.sourceId === left.sourceId)
        - backup.playlists.findIndex((item) => item.sourceId === right.sourceId));
      writeJson(partialFile, matches);
      const approved = tracks.filter((track) => track.status === 'approved').length;
      ok(`  自动确认 ${approved}/${tracks.length}，待确认 ${tracks.length - approved}`);
    }

    if (backup.albums.length) {
      step(`匹配收藏专辑（${backup.albums.length}）`);
      matches.albums = [];
      for (const album of backup.albums) {
        const result = await matcher.album(album);
        matches.albums.push({
          key: `album:${album.sourceId}`, source: album, status: result.status,
          reason: result.status === 'approved' ? '' : 'needs-confirmation', selected: result.best, candidates: result.candidates,
        });
      }
    }
    if (backup.artists.length) {
      step(`匹配关注歌手（${backup.artists.length}）`);
      matches.artists = [];
      for (const artist of backup.artists) {
        const result = await matcher.artist(artist);
        matches.artists.push({
          key: `artist:${artist.sourceId}`, source: artist, status: result.status,
          reason: result.status === 'approved' ? '' : 'needs-confirmation', selected: result.best, candidates: result.candidates,
        });
      }
    }
  } finally {
    await bridge.close();
  }

  // 清理不在本次范围内、但历史遗留的歌单条目，避免过期数据参与导入。
  const inScope = new Set(selections.map((item) => item.sourceId));
  matches.playlists = matches.playlists.filter((playlist) => inScope.has(playlist.sourceId));
  writeJson(matchesFile, matches);

  const report = migration.resolve(matches);
  const written = writeReports(dataDir, matches, migration.plan({
    backup, matches, includeAlbums: true, includeArtists: true,
  }));
  const fallbackCount = writeFallbackAudit(dataDir, matches, migration.overrides.data);
  info(`请求 ${matcher.requests} 次，缓存命中 ${matcher.cacheHits} 次，用时 ${elapsed(started)}`);
  if (fallbackCount) info(`替代版本审计已写入 fallback-audit.json（${fallbackCount} 项）`);

  step('匹配结果');
  console.log(table([
    ['状态', '数量'],
    ['自动确认', String(report.approved)],
    ['已手动指定', String(report.overridden)],
    ['已跳过', String(report.skipped)],
    ['待确认', String(report.review)],
    ['无结果', String(report.unmatched)],
    ['合计', String(report.total)],
  ]));
  if (written.pending) {
    info(`待处理 ${written.pending} 项，运行 ${color.cyan('n2q review')} 交互确认，或查看 ${relative(path.join(dataDir, 'review.md'))}`);
  } else {
    ok('所有项目均已确定，可以导入。');
  }
}

async function commandReview(options, dataDir, migration) {
  const matches = migration.readMatches();
  const only = options.only || 'review';
  const items = Migration.flatten(matches).filter((item) => {
    if (item.status === 'skipped') return false;
    if (only === 'all') return true;
    if (only === 'unmatched') return !item.selected;
    return item.status === 'review' || !item.selected;
  });

  if (!items.length) {
    ok('没有待处理项。');
    return;
  }
  if (options.list || !process.stdin.isTTY) {
    for (const item of items.slice(0, 50)) {
      console.log(`\n${color.bold(item.source.name)} ${color.dim(`[${item.key}]`)}`);
      console.log(`  源：${item.source.name} - ${(item.source.artists || []).map((artist) => artist.name).join('/')}`);
      console.log(`  原因：${item.reason || '需要确认'}`);
      item.candidates.slice(0, 5).forEach((candidate, index) => {
        const mark = item.selected?.id === candidate.id ? color.green(' *') : '  ';
        console.log(`  ${mark}${index + 1}. ${candidate.name} - ${(candidate.artists || []).map((artist) => artist.name).join('/')} ${color.dim(`score=${candidate.score ?? '-'} id=${candidate.id}`)}`);
      });
      console.log(`  ${color.dim('选择示例：1 / s=跳过 / e=结束')}`);
    }
    if (items.length > 50) info(`仅显示前 50 项，共 ${items.length} 项。`);
    if (!process.stdin.isTTY) {
      info('非交互环境：请按上面的 key 修改 overrides.json，或运行 n2q review 于本地终端。');
    }
    return;
  }

  const readline = require('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let changed = 0;
  try {
    for (const [index, item] of items.entries()) {
      console.log(`\n${color.bold(`(${index + 1}/${items.length})`)} ${item.source.name} - ${(item.source.artists || []).map((artist) => artist.name).join('/')}`);
      if (item.source.album) console.log(color.dim(`  专辑：${item.source.album}`));
      if (item.reason) console.log(color.dim(`  原因：${item.reason}`));
      item.candidates.slice(0, 6).forEach((candidate, candidateIndex) => {
        const mark = item.selected?.id === candidate.id ? color.green('*') : ' ';
        console.log(`  ${mark}${candidateIndex + 1}. ${candidate.name} - ${(candidate.artists || []).map((artist) => artist.name).join('/')} ${color.dim(`[${candidate.score ?? '-'}]`)}`);
      });
      if (!item.candidates.length) console.log(color.yellow('  无候选'));
      const answer = (await rl.question(`${color.cyan('选择')}（回车=保持，s=跳过，q=结束）> `)).trim().toLowerCase();
      if (answer === 'q') break;
      if (answer === 's') {
        migration.overrides.set(item.key, 'skip');
        changed += 1;
        continue;
      }
      if (!answer) {
        if (item.selected && item.status === 'review') {
          // 回车等于“采用当前推荐版本”，显式记录避免下次重新询问。
          migration.overrides.set(item.key, { id: item.selected.id, mid: item.selected.mid });
          changed += 1;
        }
        continue;
      }
      const pick = Number(answer);
      const candidate = item.candidates[pick - 1];
      if (!candidate) { warn('输入无效，保持原样。'); continue; }
      migration.overrides.set(item.key, { id: candidate.id, mid: candidate.mid });
      changed += 1;
    }
  } finally {
    rl.close();
  }
  migration.overrides.save();
  ok(`已更新 ${changed} 项到 ${relative(migration.overrides.file)}`);
  info('运行 n2q import 应用选择并写入 QQ 音乐。');
}

async function commandImport(options, dataDir, migration) {
  const backup = migration.readBackup(options.backup);
  const matches = migration.readMatches(backup);
  const plan = migration.plan({
    backup, matches,
    includeAlbums: options.albums,
    includeArtists: options.artists,
    copyCollected: options.copyCollected,
    allowReview: options.allowReview,
  });
  if (options.limit) {
    plan.willImport = plan.willImport.slice(0, options.limit);
    plan.counts.playlists = plan.willImport.length;
    plan.counts.tracks = plan.willImport.reduce((sum, playlist) => sum + playlist.tracks, 0);
    plan.counts.pendingTracks = plan.willImport.reduce((sum, playlist) => sum + Math.max(0, playlist.tracks - playlist.done), 0);
  }

  if (plan.report.review && !options.allowReview) {
    const error = new Error(`还有 ${plan.report.review} 项待确认。运行 n2q review 处理，或加 --allow-review 采用推荐版本（不推荐）。`);
    error.hint = 'n2q review';
    throw error;
  }

  step('写入计划');
  console.log(table([
    ['项目', '数量'],
    ['歌单', String(plan.counts.playlists)],
    ['歌曲位置', String(plan.counts.tracks)],
    ['待写入', String(plan.counts.pendingTracks)],
    ['专辑', String(plan.counts.albums)],
    ['歌手', String(plan.counts.artists)],
    ['跳过 / 无结果', `${plan.report.skipped} / ${plan.report.unmatched}`],
  ]));
  if (plan.willImport.length <= 50) console.log(`\n${migration.previewLines(plan).join('\n')}`);
  else info(`${plan.willImport.length} 张歌单将写入；“我喜欢”会直接进入 QQ 我喜欢，不创建同名歌单。`);

  if (options.dryRun) {
    const summary = await migration.run(plan, { dryRun: true });
    const remaining = plan.counts.pendingTracks;
    ok(`演练完成：不会写入任何 QQ 内容。${remaining ? `正式导入将写入约 ${remaining} 首。` : '计划内的歌曲此前均已完成，无需重复写入。'}`);
    return;
  }
  if (!plan.counts.pendingTracks && !plan.counts.albums && !plan.counts.artists) {
    ok('没有需要写入的新内容；如需核对，运行 n2q verify。');
    return;
  }

  await confirmImport(options);
  const started = Date.now();
  const summary = await migration.run(plan, {
    strict: options.strict,
    copyCollected: options.copyCollected,
    batchSize: Math.min(30, Math.max(1, options.batchSize || 10)),
  });

  step('本轮完成');
  console.log(table([
    ['结果', '数量'],
    ['新增歌曲', String(summary.totals.added)],
    ['跳过（已完成/不可播）', String(summary.totals.skipped)],
    ['失败', String(summary.totals.failed)],
    ['歌单', String(summary.totals.playlists)],
  ]));
  info(`用时 ${elapsed(started)}，报告：${relative(path.join(dataDir, 'import-report.json'))}`);
  if (summary.totals.failed) {
    warn('存在失败项；可直接重跑 n2q import，已完成部分会自动跳过。');
    process.exitCode = 2;
  } else {
    ok('完成。建议运行 n2q verify 做一次只读核对。');
  }
}

async function confirmImport(options) {
  if (!process.stdin.isTTY) throw new Error('导入需要本地交互终端确认；无人值守模式不会写入账号。');
  if (options.yes) {
    warn('已通过 --yes 跳过确认。');
    return;
  }
  const readline = require('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n${color.bold('即将写入 QQ 音乐账号')}：创建歌单、添加歌曲、收藏专辑/歌手。`);
    console.log(color.dim('不会删除 QQ 或网易云内容；非官方接口可能随平台调整失效。'));
    const answer = (await rl.question(`确认继续请输入 ${color.cyan('IMPORT')}：`)).trim();
    if (answer !== 'IMPORT') throw new Error('已取消，未写入任何内容。');
  } finally {
    rl.close();
  }
}

async function commandVerify(options, dataDir, migration) {
  const backup = migration.readBackup(options.backup);
  const matches = migration.readMatches(backup);
  const plan = migration.plan({ backup, matches, includeAlbums: true, includeArtists: true });
  step(`只读核验 ${Math.min(options.limit || Infinity, plan.willImport.length)} 张歌单`);
  const results = await migration.verify({ backup, matches, plan, limit: options.limit });
  const rows = [['歌单', 'QQ 歌曲数', '预期', '结果']];
  for (const result of results) {
    rows.push([
      result.name,
      String(result.actual),
      String(result.expected),
      result.status === 'ok' ? color.green('一致') : result.status === 'missing' ? color.red('未创建') : color.yellow(`缺 ${result.missingCount}`),
    ]);
  }
  console.log(table(rows));
  const okCount = results.filter((result) => result.status === 'ok').length;
  const partial = results.filter((result) => result.status === 'partial');
  if (partial.length) {
    warn(`${partial.length} 张歌单存在差异。QQ 会折叠重复歌曲，或部分歌曲因版权不可播，差异不一定代表写入失败。`);
    for (const result of partial.slice(0, 5)) info(`${result.name}：缺 ${result.missingCount} 首，示例 ${result.missing.join(', ')}`);
  }
  writeJson(path.join(dataDir, 'verify-report.json'), { at: new Date().toISOString(), results });
  ok(`${okCount}/${results.length} 张歌单完全一致；报告：${relative(path.join(dataDir, 'verify-report.json'))}`);
  if (okCount !== results.length) process.exitCode = 2;
}

async function commandStatus(options, dataDir, migration) {
  const backupFile = path.join(dataDir, 'latest-backup.json');
  const backup = fs.existsSync(backupFile) ? migration.readBackup(backupFile) : null;
  const matches = fs.existsSync(migration.matchesFile) ? readJson(migration.matchesFile) : null;
  const state = migration.state.summary();
  const reportFile = path.join(dataDir, 'import-report.json');
  const lastImport = fs.existsSync(reportFile) ? readJson(reportFile) : null;

  const payload = {
    dataDir,
    account: backup?.account || null,
    backup: backup ? {
      exportedAt: backup.exportedAt,
      playlists: backup.playlists.length,
      owned: backup.playlists.filter((playlist) => playlist.owned).length,
      tracks: backup.playlists.reduce((sum, playlist) => sum + playlist.tracks.length, 0),
      albums: backup.albums.length,
      artists: backup.artists.length,
    } : null,
    matches: backup && matches ? { ...summarize(migration.plan({ backup, matches })) } : null,
    state,
    lastImport: lastImport ? { startedAt: lastImport.startedAt, finishedAt: lastImport.finishedAt, totals: lastImport.totals } : null,
  };

  if (options.json) { console.log(JSON.stringify(payload, null, 2)); return; }

  step('当前状态');
  if (payload.backup) {
    console.log(`网易云账号：${payload.account?.nickname || '-'}（${payload.account?.id}）`);
    console.log(`备份：${payload.backup.playlists} 张歌单（本人 ${payload.backup.owned}）/ ${payload.backup.tracks} 个曲目位置 / ${payload.backup.albums} 张专辑 / ${payload.backup.artists} 位歌手`);
  } else {
    warn('尚无备份，运行 n2q export。');
  }
  if (payload.matches) {
    console.log(`匹配：自动 ${payload.matches.approved}，手动 ${payload.matches.overridden}，跳过 ${payload.matches.skipped}，待确认 ${payload.matches.review}，无结果 ${payload.matches.unmatched}`);
  } else {
    warn('尚无匹配结果，运行 n2q prepare。');
  }
  console.log(`断点：${state.playlists} 张歌单，${state.done} 项完成，${state.failed} 项失败`);
  if (payload.lastImport) {
    const { totals } = payload.lastImport;
    console.log(`上次导入：新增 ${totals.added}，跳过 ${totals.skipped}，失败 ${totals.failed}（${payload.lastImport.finishedAt || payload.lastImport.startedAt}）`);
  }
  console.log(color.dim(`数据目录：${dataDir}`));
}

async function commandReport(options, dataDir, migration) {
  const backup = migration.readBackup(options.backup);
  const matches = migration.readMatches(backup);
  migration.resolve(matches);
  const written = writeReports(dataDir, matches, migration.plan({ backup, matches, includeAlbums: true, includeArtists: true }));
  const fallbackCount = writeFallbackAudit(dataDir, matches, migration.overrides.data);
  ok(`已生成 review.csv / review.md / unresolved.json / fallback-audit.json；待处理 ${written.pending} 项，替代版本 ${fallbackCount} 项。`);
}

async function commandLogout(options, dataDir) {
  const secretDir = path.join(dataDir, '.secrets');
  if (!fs.existsSync(secretDir)) { ok('没有保存任何登录凭据。'); return; }
  const all = !options.netease && !options.qq;
  const patterns = [];
  if (all || options.netease) patterns.push(/^netease-.*$/);
  if (all || options.qq) patterns.push(/^qq-.*$/);
  let removed = 0;
  for (const entry of fs.readdirSync(secretDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (patterns.some((pattern) => pattern.test(entry.name))) {
      fs.unlinkSync(path.join(secretDir, entry.name));
      removed += 1;
    }
  }
  ok(`已删除 ${removed} 个本机凭据文件。`);
  info('未删除备份、匹配报告或 QQ 中已导入的内容，也不会退出官方 App 的登录。');
  info(`若凭据曾出现在终端历史或截图中，建议在平台侧使旧会话失效。`);
}

async function commandDoctor(options, dataDir) {
  step('环境检查');  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const checks = [];
  checks.push(['Node.js', `v${process.versions.node}`, nodeMajor >= 18, nodeMajor >= 18 ? '' : '需要 Node.js ≥ 18']);
  const python = findPython(options.python);
  const pythonCheck = checkPython(python);
  checks.push(['Python', python ? `${python}${pythonCheck.version ? ` (${pythonCheck.version})` : ''}` : '未找到', pythonCheck.ok, pythonCheck.fix || '']);
  if (pythonCheck.missing?.length) checks.push(['Python 依赖', `缺少 ${pythonCheck.missing.join(', ')}`, false, pythonCheck.fix]);
  checks.push(['数据目录', dataDir, fs.existsSync(dataDir), fs.existsSync(dataDir) ? '' : '运行 n2q export 后自动创建']);
  const secretDir = path.join(dataDir, '.secrets');
  checks.push(['网易云登录态', fs.existsSync(path.join(secretDir, 'netease-session.json')) ? '已保存' : '未登录', true, '']);
  checks.push(['QQ 登录态', fs.existsSync(path.join(secretDir, 'qq-credential.json')) ? '已保存' : '首次导入时扫码', true, '']);
  const backupFile = path.join(dataDir, 'latest-backup.json');
  if (fs.existsSync(backupFile)) {
    const backup = readJson(backupFile, '备份');
    checks.push(['备份', `${backup.playlists.length} 张歌单 / ${backup.exportedAt.slice(0, 10)}`, true, '']);
  } else checks.push(['备份', '尚未导出', false, '运行 n2q export']);
  const matchesFile = path.join(dataDir, 'matches.json');
  checks.push(['匹配结果', fs.existsSync(matchesFile) ? '已生成' : '尚未生成', true, '']);

  for (const [name, value, pass, hint] of checks) {
    console.log(`${pass ? color.green('✓') : color.red('×')} ${name.padEnd(14)} ${value}${hint ? color.dim(`  ${hint}`) : ''}`);
  }
  const failed = checks.filter(([, , pass]) => !pass);
  if (failed.length) {
    process.exitCode = 1;
    warn(`有 ${failed.length} 项需要处理。`);
  } else {
    ok('环境检查通过。');
  }
}

async function run(argv) {
  const { command, options } = parseArgs(argv);
  if (options.version) { console.log(VERSION); return; }
  if (command === 'help') {
    printHelp(options.topic || 'help');
    return;
  }
  if (!COMMANDS[command]) {
    if (options.help) { printHelp('help'); return; }
    throw new Error(`未知命令：${command}\n运行 n2q help 查看全部命令。`);
  }
  if (options.help) { printHelp(command); return; }
  const { dataDir, migration, log } = context(options);
  const started = Date.now();
  switch (command) {
    case 'login': await commandLogin(options, dataDir); break;
    case 'export': await commandExport(options, dataDir); break;
    case 'prepare': await commandPrepare(options, dataDir, migration); break;
    case 'review': await commandReview(options, dataDir, migration); break;
    case 'import': await commandImport(options, dataDir, migration); break;
    case 'verify': await commandVerify(options, dataDir, migration); break;
    case 'status': await commandStatus(options, dataDir, migration); break;
    case 'report': await commandReport(options, dataDir, migration); break;
    case 'logout': await commandLogout(options, dataDir); break;
    case 'doctor': await commandDoctor(options, dataDir); break;
    default: throw new Error(`未知命令：${command}`);
  }
  if (options.verbose) log(`总用时 ${elapsed(started)}`);
}

module.exports = { run, parseArgs, COMMANDS, printHelp };
