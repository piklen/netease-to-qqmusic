'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Migration } = require('../src/core/migrate');
const { writeJson } = require('../src/lib/util');

function fixture(songIds = [1, 2, 3]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n2q-ipc-'));
  const backup = {
    version: 1, exportedAt: '2026-11-03', account: { id: '42' }, likedPlaylistId: null,
    playlists: [{ sourceId: 'list', name: '测试歌单', owned: true, tracks: [] }], albums: [], artists: [],
  };
  const tracks = songIds.map((id, index) => ({
    key: `track:list:${index}`,
    source: { sourceId: String(index), name: `歌曲${index}`, artists: [] },
    status: 'approved',
    selected: { id: String(id), type: 1, mid: `m${id}`, name: `歌曲${index}`, artists: [] },
    candidates: [],
  }));
  writeJson(path.join(dir, 'latest-backup.json'), backup);
  writeJson(path.join(dir, 'matches.json'), {
    version: 2, exportedAt: backup.exportedAt,
    playlists: [{ ...backup.playlists[0], tracks }], albums: [], artists: [],
  });
  writeJson(path.join(dir, 'overrides.json'), {});
  const migration = new Migration({ dataDir: dir, python: process.env.PYTHON || 'python3', helper: path.join(__dirname, 'mock_qq_bridge.py') });
  const matches = migration.readMatches(backup);
  return { dir, backup, matches, migration };
}

function calls(dir) {
  return fs.readFileSync(path.join(dir, 'mock-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

test('建单后用批量接口倒序写入，全部成功', async () => {
  const { dir, backup, matches, migration } = fixture();
  const plan = migration.plan({ backup, matches });
  const summary = await migration.run(plan, { batchSize: 10 });
  assert.equal(summary.totals.added, 3);
  const recorded = calls(dir);
  assert.equal(recorded[0].command, 'create_playlist');
  assert.equal(recorded[1].command, 'add_song_batch');
  assert.deepEqual(recorded[1].songs.map(([id]) => id), [3, 2, 1]);
  assert.equal(migration.state.summary().done, 3);
});

test('重跑不会重复写入已完成项，也不会重建歌单', async () => {
  const { dir, backup, matches } = fixture();
  const first = fixtureFrom(dir);
  await first.migration.run(first.migration.plan({ backup, matches }), {});
  const before = calls(dir);
  await new Migration({ dataDir: dir, python: process.env.PYTHON || 'python3', helper: path.join(__dirname, 'mock_qq_bridge.py') })
    .run(first.migration.plan({ backup, matches }), {});
  assert.deepEqual(calls(dir), before);
});

test('批量失败退化为逐首，失败的歌曲不标完成但继续处理', async () => {
  const { dir, backup, matches, migration } = fixture([1, 999, 3]);
  const summary = await migration.run(migration.plan({ backup, matches }), { batchSize: 10 });
  assert.equal(summary.totals.added, 2);
  assert.equal(summary.totals.failed, 1);
  assert.equal(migration.state.isDone('track:list:1'), false);
  assert.match(migration.state.data.errors['track:list:1'], /simulated failure/);
  assert.equal(migration.state.isDone('track:list:0'), true);
});

test('strict 模式首个失败立即停止并保留断点', async () => {
  // 倒序写入时 999 位于首项，strict 应立即中止，后续歌曲不会被误标完成。
  const { backup, matches, migration } = fixture([1, 999]);
  await assert.rejects(migration.run(migration.plan({ backup, matches }), { strict: true }), /simulated/);
  assert.equal(migration.state.isDone('track:list:1'), false);
});

test('dry-run 不启动 QQ 桥接、不写入任何记录', async () => {
  const { dir, backup, matches, migration } = fixture();
  const summary = await migration.run(migration.plan({ backup, matches }), { dryRun: true });
  assert.equal(summary.totals.added, 0);
  assert.equal(fs.existsSync(path.join(dir, 'mock-calls.jsonl')), false);
  assert.equal(migration.state.summary().done, 0);
});

function fixtureFrom(dir) {
  const migration = new Migration({ dataDir: dir, python: process.env.PYTHON || 'python3', helper: path.join(__dirname, 'mock_qq_bridge.py') });
  const backup = migration.readBackup();
  return { migration, backup, matches: migration.readMatches(backup) };
}
