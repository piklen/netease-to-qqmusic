'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Migration } = require('../src/core/migrate');
const { songCandidates } = require('../src/core/matching');
const { writeJson } = require('../src/lib/util');
const { parseArgs } = require('../src/cli');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n2q-resolve-'));
  const song = { sourceId: '1', name: '晴天', artists: [{ name: '周杰伦' }], album: '叶惠美', durationMs: 269000 };
  const backup = {
    version: 1, exportedAt: '2026-11-03T12:00:00.000Z', account: { id: '42' }, likedPlaylistId: 'fav',
    playlists: [{ sourceId: 'fav', name: '我喜欢的音乐', owned: true, tracks: [song, song] }], albums: [], artists: [],
  };
  const candidates = songCandidates([
    { songid: 97773, songmid: 'm1', songname: '晴天', singer: [{ name: '周杰伦' }], albumname: '叶惠美', interval: 269 },
    { songid: 888, songmid: 'm2', songname: '晴天', singer: [{ name: '翻唱' }], albumname: '翻唱专辑', interval: 200 },
  ]);
  const matches = {
    version: 2, exportedAt: backup.exportedAt, albums: [], artists: [],
    playlists: [{
      ...backup.playlists[0],
      tracks: backup.playlists[0].tracks.map((source, index) => ({
        key: `track:fav:${index}`, source, status: 'approved', selected: candidates[0], candidates,
      })),
    }],
  };
  writeJson(path.join(dir, 'latest-backup.json'), backup);
  writeJson(path.join(dir, 'matches.json'), matches);
  writeJson(path.join(dir, 'overrides.json'), {});
  return { dir, backup, matches };
}

test('按歌单位置跳过，不影响同歌在其他位置', () => {
  const { dir, matches } = fixture();
  writeJson(path.join(dir, 'overrides.json'), { 'track:fav:0': 'skip' });
  const migration = new Migration({ dataDir: dir });
  const report = migration.resolve(matches);
  assert.equal(report.skipped, 1);
  assert.equal(report.approved, 1);
  assert.equal(matches.playlists[0].tracks[0].selected, null);
  assert.ok(matches.playlists[0].tracks[1].selected);
});

test('手动指定候选', () => {
  const { dir, matches } = fixture();
  writeJson(path.join(dir, 'overrides.json'), { 'track:fav:0': { id: '888' } });
  const migration = new Migration({ dataDir: dir });
  const report = migration.resolve(matches);
  assert.equal(report.overridden, 1);
  assert.equal(matches.playlists[0].tracks[0].selected.id, '888');
});

test('override 不在候选中时给出可操作错误', () => {
  const { dir, matches } = fixture();
  writeJson(path.join(dir, 'overrides.json'), { 'track:fav:0': { id: '404' } });
  const migration = new Migration({ dataDir: dir });
  assert.throws(() => migration.resolve(matches), /手动选择不在候选中/);
});

test('匹配文件与备份不是同一批次时拒绝导入', () => {
  const { dir, backup, matches } = fixture();
  const migration = new Migration({ dataDir: dir });
  matches.exportedAt = '2026-01-01';
  writeJson(path.join(dir, 'matches.json'), matches);
  assert.throws(() => migration.readMatches(backup), /另一次备份/);
});

test('“我喜欢”映射到 QQ dirid 201，不创建同名歌单', () => {
  const { dir, backup, matches } = fixture();
  const migration = new Migration({ dataDir: dir });
  const plan = migration.plan({ backup, matches });
  assert.equal(plan.playlists[0].dirid, 201);
  assert.equal(plan.playlists[0].isLiked, true);
});

test('命令行参数解析：布尔、数值、等号写法', () => {
  const parsed = parseArgs(['import', '--dry-run', '--limit', '10', '--batch-size=5']);
  assert.equal(parsed.command, 'import');
  assert.equal(parsed.options.dryRun, true);
  assert.equal(parsed.options.limit, 10);
  assert.equal(parsed.options.batchSize, 5);
  assert.throws(() => parseArgs(['import', '--nope']), /未知参数/);
  assert.throws(() => parseArgs(['import', '--limit', 'abc']), /非负整数/);
});
