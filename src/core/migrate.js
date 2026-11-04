'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { QQBridge } = require('./qq-bridge');
const { MigrationState } = require('./state');
const { Overrides } = require('./overrides');
const { describeCandidate } = require('./matching');
const { readJson, writeJson, assertObject, cleanError, sleep } = require('../lib/util');
const { Progress, info, ok, warn, step, color } = require('../lib/ui');

const LIKED_DIRID = 201;
const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 3;

/** 把一次迁移拆成可预览、可恢复的计划，import/report/dry-run 共用。 */
class Migration {
  constructor({ dataDir, python, helper, log, concurrency = 4 }) {
    this.dataDir = dataDir;
    this.python = python;
    this.helper = helper;
    this.log = log || (() => {});
    this.concurrency = concurrency;
    this.state = new MigrationState(path.join(dataDir, 'migration-state.json'));
    this.overrides = new Overrides(path.join(dataDir, 'overrides.json'));
    this.matchesFile = path.join(dataDir, 'matches.json');
  }

  readBackup(file = path.join(this.dataDir, 'latest-backup.json')) {
    if (!fs.existsSync(file)) throw new Error(`找不到备份：${file}\n请先执行 n2q export`);
    const backup = assertObject(readJson(file, '网易云备份'), '网易云备份');
    if (backup.version !== 1 || !Array.isArray(backup.playlists) || !Array.isArray(backup.albums) || !Array.isArray(backup.artists)) {
      throw new Error('备份格式不兼容，请重新执行 n2q export。');
    }
    return backup;
  }

  readMatches(backup) {
    if (!fs.existsSync(this.matchesFile)) throw new Error('找不到匹配结果。请先执行 n2q prepare');
    const matches = assertObject(readJson(this.matchesFile), '匹配文件');
    if (backup && matches.exportedAt !== backup.exportedAt) {
      throw new Error('匹配结果来自另一次备份，请重新执行 n2q prepare。');
    }
    return matches;
  }

  /** 应用 overrides，并把每项最终状态写回对象；返回统计和逐项决定。 */
  resolve(matches) {
    const report = { approved: 0, overridden: 0, skipped: 0, review: 0, unmatched: 0, total: 0, plans: [] };
    const all = Migration.flatten(matches);
    for (const item of all) {
      report.total += 1;
      const override = this.overrides.get(item.key);
      if (override === 'skip') {
        item.selected = null;
        item.status = 'skipped';
        item.reason = 'overridden-skip';
        report.skipped += 1;
      } else if (override && typeof override === 'object') {
        const targetId = override.id != null ? String(override.id) : null;
        const targetMid = override.mid || null;
        const selected = item.candidates.find((candidate) => (
          (targetMid && candidate.mid === targetMid) || (targetId && String(candidate.id) === targetId)
        ));
        if (!selected) {
          throw new Error(`「${item.source.name}」的手动选择不在候选中（key=${item.key}）。请运行 n2q prepare --rebuild 后重新选择。`);
        }
        item.selected = selected;
        item.status = 'overridden';
        // 保留原来的匹配解释，供审计区分“人工选择”与“自动替代”。
        item.matchReason = item.matchReason || item.reason;
        item.reason = 'manual';
        report.overridden += 1;
      } else if (item.selected && item.status === 'approved') {
        report.approved += 1;
      } else if (item.status === 'unmatched') {
        report.unmatched += 1;
      } else {
        report.review += 1;
      }
      report.plans.push(item);
    }
    return report;
  }

  static flatten(matches) {
    return [
      ...matches.playlists.flatMap((playlist) => playlist.tracks.map((track) => {
        track.playlistId = playlist.sourceId;
        return track;
      })),
      ...matches.albums,
      ...matches.artists,
    ];
  }

  /** 计划摘要：不连接 QQ，可直接展示给用户。 */
  plan({ backup, matches, includeAlbums = false, includeArtists = false, copyCollected = false, allowReview = false }) {
    const report = this.resolve(matches);
    const playlists = matches.playlists.map((playlist) => {
      const isLiked = playlist.sourceId === backup.likedPlaylistId;
      const willImport = playlist.owned || (copyCollected && !playlist.owned);
      const tracks = playlist.tracks.filter((track) => track.selected || (allowReview && track.status === 'review' && track.candidates[0]));
      const done = playlist.tracks.filter((track) => this.state.isDone(track.key)).length;
      return {
        sourceId: playlist.sourceId,
        name: playlist.name,
        targetName: playlist.owned ? playlist.name : `网易云收藏-${playlist.name}`,
        isLiked,
        owned: playlist.owned,
        willImport: Boolean(willImport),
        tracks: tracks.length,
        totalTracks: playlist.tracks.length,
        done,
        dirid: this.state.playlist(playlist.sourceId)?.dirid || (isLiked ? LIKED_DIRID : null),
      };
    });
    const albums = includeAlbums ? matches.albums.filter((item) => item.selected) : [];
    const artists = includeArtists ? matches.artists.filter((item) => item.selected) : [];
    return {
      report,
      playlists,
      albums,
      artists,
      willImport: playlists.filter((playlist) => playlist.willImport),
      counts: {
        playlists: playlists.filter((playlist) => playlist.willImport).length,
        tracks: playlists.filter((playlist) => playlist.willImport).reduce((sum, playlist) => sum + playlist.tracks, 0),
        pendingTracks: playlists.filter((playlist) => playlist.willImport).reduce((sum, playlist) => sum + Math.max(0, playlist.tracks - playlist.done), 0),
        albums: albums.length,
        artists: artists.length,
      },
    };
  }

  async openBridge() {
    const bridge = new QQBridge({ python: this.python, helper: this.helper, dataDir: this.dataDir, log: this.log });
    await bridge.start();
    return bridge;
  }

  /**
   * 执行写入。失败默认不中断：记录错误、继续下一项，最后统一汇总；
   * --strict 时首个失败立即停止（保留断点）。任何情况下已成功项都不会重复写入。
   */
  async run(plan, { dryRun = false, strict = false, copyCollected = false, batchSize = BATCH_SIZE } = {}) {
    const summary = {
      startedAt: new Date().toISOString(),
      playlists: [], albums: [], artists: [],
      totals: { added: 0, skipped: 0, failed: 0, playlists: 0 },
    };
    if (dryRun) {
      for (const playlist of plan.willImport) {
        summary.totals.skipped += playlist.tracks;
        summary.playlists.push({ name: playlist.targetName, dirid: playlist.dirid, added: 0, skipped: playlist.tracks, failed: 0, dryRun: true });
      }
      summary.finishedAt = new Date().toISOString();
      return summary;
    }

    const bridge = await this.openBridge();
    try {
      step(`写入 ${plan.willImport.length} 张歌单`);      const progress = new Progress('总进度', plan.counts.pendingTracks || 1);
      let processed = 0;
      for (const playlist of plan.willImport) {
        const item = summary.playlists.find((entry) => entry.sourceId === playlist.sourceId) || { sourceId: playlist.sourceId, name: playlist.targetName, added: 0, skipped: 0, failed: 0 };
        if (!summary.playlists.includes(item)) summary.playlists.push(item);
        try {
          let dirid = this.state.playlist(playlist.sourceId)?.dirid;
          if (!dirid) {
            if (playlist.isLiked) {
              dirid = LIKED_DIRID;
            } else {
              const created = await bridge.send({ command: 'create_playlist', name: playlist.targetName });
              dirid = Number(created.dirid);
            }
            this.state.setPlaylist(playlist.sourceId, {
              name: playlist.targetName, dirid, sourceId: playlist.sourceId, copied: !playlist.owned,
            });
            this.state.save();
            item.dirid = dirid;
          }

          const tracks = plan.report.plans.filter((entry) => entry.playlistId === playlist.sourceId && entry.selected);
          // 逐首从尾部写入，抵消 QQ “新歌置顶”，保持源歌单顺序。
          const pending = [...tracks].reverse();
          let index = 0;
          while (index < pending.length) {
            const chunk = [];
            while (index < pending.length && chunk.length < batchSize) {
              const track = pending[index];
              index += 1;
              if (this.state.isDone(track.key)) { item.skipped += 1; processed += 1; progress.update(processed); continue; }
              chunk.push(track);
            }
            if (!chunk.length) continue;
            try {
              await this.addChunk(bridge, dirid, chunk);
              for (const track of chunk) this.state.markDone(track.key);
              this.state.save();
              item.added += chunk.length;
              summary.totals.added += chunk.length;
            } catch (error) {
              // 批量失败退化为逐首，定位到具体歌曲，避免整张歌单重来。
              for (const track of chunk) {
                try {
                  await this.addWithRetry(bridge, dirid, track);
                  this.state.markDone(track.key);
                  this.state.save();
                  item.added += 1;
                  summary.totals.added += 1;
                } catch (singleError) {
                  if (singleError.code === 'UNPLAYABLE') {
                    item.skipped += 1;
                    summary.totals.skipped += 1;
                    this.state.markDone(track.key);
                    this.state.save();
                    continue;
                  }
                  item.failed += 1;
                  summary.totals.failed += 1;
                  this.state.markFailed(track.key, cleanError(singleError));
                  this.state.save();
                  item.errors ||= [];
                  item.errors.push({ key: track.key, name: track.source.name, error: cleanError(singleError) });
                  if (strict) throw new Error(`《${playlist.name}》的《${track.source.name}》写入失败：${cleanError(singleError)}`);
                }
              }
            }
            processed += chunk.length;
            progress.update(processed, `失败 ${summary.totals.failed}`);
          }
          summary.totals.playlists += 1;
          const status = item.failed ? color.yellow(`完成（${item.failed} 首失败）`) : color.green('完成');
          ok(`${playlist.targetName}：+${item.added}，跳过 ${item.skipped}${item.failed ? `，失败 ${item.failed}` : ''} ${color.dim(`dirid=${dirid}`)} ${status}`);
        } catch (error) {
          item.failed += 1;
          summary.totals.failed += 1;
          warn(`${playlist.targetName}：${cleanError(error)}`);
          if (strict) throw error;
        }
      }
      progress.done();

      if (plan.artists.length) {
        step(`关注 ${plan.artists.length} 位歌手`);
        for (const artist of plan.artists) {
          const key = artist.key;
          if (this.state.isDone(key)) { summary.artists.push({ name: artist.source.name, status: 'done' }); continue; }
          try {
            await bridge.send({ command: 'follow_artist', mid: artist.selected.mid });
            this.state.markDone(key);
            this.state.save();
            summary.artists.push({ name: artist.source.name, status: 'done' });
            ok(artist.source.name);
          } catch (error) {
            this.state.markFailed(key, cleanError(error));
            this.state.save();
            summary.artists.push({ name: artist.source.name, status: 'failed', error: cleanError(error) });
            warn(`${artist.source.name}：${cleanError(error)}`);
            if (strict) throw error;
          }
        }
      }

      if (plan.albums.length) {
        step(`收藏 ${plan.albums.length} 张专辑`);
        for (const album of plan.albums) {
          const key = album.key;
          if (this.state.isDone(key)) { summary.albums.push({ name: album.source.name, status: 'done' }); continue; }
          try {
            await bridge.send({ command: 'follow_album', albumId: Number(album.selected.id) });
            this.state.markDone(key);
            this.state.save();
            summary.albums.push({ name: album.source.name, status: 'done' });
            ok(album.source.name);
          } catch (error) {
            this.state.markFailed(key, cleanError(error));
            this.state.save();
            summary.albums.push({ name: album.source.name, status: 'failed', error: cleanError(error) });
            warn(`${album.source.name}：${cleanError(error)}`);
            if (strict) throw error;
          }
        }
      }
    } finally {
      await bridge.close();
    }
    summary.finishedAt = new Date().toISOString();
    this.state.data.stats = summary.totals;
    this.state.dirty = true;
    this.state.save();
    writeJson(path.join(this.dataDir, 'import-report.json'), summary);
    return summary;
  }

  async addChunk(bridge, dirid, tracks) {
    if (tracks.length === 1) return this.addWithRetry(bridge, dirid, tracks[0]);
    return bridge.send({
      command: 'add_song_batch',
      dirid,
      songs: tracks.map((track) => [Number(track.selected.id), track.selected.type || 1]),
    });
  }

  async addWithRetry(bridge, dirid, track) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await bridge.send({
          command: 'add_song',
          dirid,
          songId: Number(track.selected.id),
          songType: track.selected.type || 1,
        });
        return;
      } catch (error) {
        lastError = error;
        // 版权/下架属于确定性失败，重试没有意义。
        if (/权限|版权|下架|无[法权]|not\s*(?:allowed|available)|-?1000|3000/i.test(cleanError(error))) {
          lastError.code = 'UNPLAYABLE';
          throw lastError;
        }
        if (attempt < MAX_ATTEMPTS) await sleep(attempt * 800);
      }
    }
    throw lastError;
  }

  /** 只读核验：逐张读取 QQ 歌单，与源清单按歌曲 ID 对比。 */
  async verify({ backup, matches, plan, limit } = {}) {
    const bridge = await this.openBridge();
    const results = [];
    try {
      const targets = plan.willImport.slice(0, limit || plan.willImport.length);
      for (const playlist of targets) {
        const dirid = this.state.playlist(playlist.sourceId)?.dirid
          || (playlist.isLiked ? LIKED_DIRID : null);
        if (!dirid) {
          results.push({ sourceId: playlist.sourceId, name: playlist.targetName, status: 'missing', expected: playlist.tracks, actual: 0 });
          continue;
        }
        const response = await bridge.send({ command: 'list_playlist', dirid });
        const actual = new Set(response.songs.map((song) => String(song.id)));
        const source = matches.playlists.find((item) => item.sourceId === playlist.sourceId);
        const selected = (source?.tracks || [])
          .filter((track) => track.selected)
          .map((track) => String(track.selected.id));
        const expectedUnique = new Set(selected);
        const missing = [...expectedUnique].filter((id) => !actual.has(id));
        results.push({
          sourceId: playlist.sourceId,
          name: playlist.targetName,
          dirid,
          status: missing.length ? 'partial' : 'ok',
          expected: expectedUnique.size,
          expectedPositions: selected.length,
          actual: actual.size,
          duplicates: selected.length - expectedUnique.size,
          missing: missing.slice(0, 10),
          missingCount: missing.length,
        });
      }
    } finally {
      await bridge.close();
    }
    return results;
  }

  previewLines(plan) {
    return plan.willImport.map((playlist) => {
      const liked = playlist.isLiked ? color.magenta(' [我喜欢]') : '';
      const state = playlist.dirid ? color.dim(` dirid=${playlist.dirid}`) : '';
      const remaining = Math.max(0, playlist.tracks - playlist.done);
      return `  ${playlist.owned ? '' : color.dim('[收藏] ')}${playlist.targetName}${liked}${state}  ${playlist.tracks} 首${remaining !== playlist.tracks ? color.dim(`（已完成 ${playlist.done}）`) : ''}`;
    });
  }

  /** 供 review 命令展示单项详情。 */
  static describe(item) {
    return `${item.source.name} - ${(item.source.artists || []).map((artist) => artist.name).join('/')} → ${describeCandidate(item.selected)}`;
  }
}

module.exports = { Migration, LIKED_DIRID };
