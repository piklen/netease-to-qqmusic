'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describeCandidate } = require('./matching');
const { writeJson } = require('../lib/util');

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

/**
 * 生成人可读的报告：
 * - review.md：只需处理的项目，便于快速扫读；
 * - review.csv：全量明细，可用 Excel 筛选；
 * - unresolved.md：无法可靠对应、不会导入的清单。
 */
function writeReports(dataDir, matches, plan) {
  const reviewRows = [['key', 'category', 'playlist', 'source', 'artists', 'status', 'reason', 'selected', 'candidate_1', 'candidate_2', 'candidate_3']];
  const unresolved = [];
  for (const playlist of matches.playlists) {
    for (const track of playlist.tracks) {
      const row = [
        track.key, 'track', playlist.name, track.source.name,
        (track.source.artists || []).map((artist) => artist.name).join('/'),
        track.status, track.reason || '', describeCandidate(track.selected),
        ...track.candidates.slice(0, 3).map((candidate) => describeCandidate(candidate)),
      ];
      reviewRows.push(row);
      if (!track.selected) unresolved.push({ key: track.key, playlist: playlist.name, track });
    }
  }
  for (const item of [...matches.albums, ...matches.artists]) {
    const category = item.key.startsWith('album:') ? 'album' : 'artist';
    reviewRows.push([
      item.key, category, '', item.source.name,
      (item.source.artists || []).map((artist) => artist.name).join('/'),
      item.status, item.reason || '', describeCandidate(item.selected),
      ...item.candidates.slice(0, 3).map((candidate) => describeCandidate(candidate)),
    ]);
    if (!item.selected) unresolved.push({ key: item.key, playlist: '', track: item });
  }

  // UTF-8 BOM 让 Excel 正确识别中文。
  const csv = `﻿${reviewRows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
  fs.writeFileSync(path.join(dataDir, 'review.csv'), csv, { mode: 0o600 });

  const pending = reviewRows.slice(1).filter((row) => row[5] === 'review' || row[5] === 'unmatched');
  const lines = [
    '# 待确认与未匹配',
    '',
    `生成时间：${new Date().toLocaleString('zh-CN')}`,
    `待确认 ${pending.filter((row) => row[5] === 'review').length} 项，无结果 ${pending.filter((row) => row[5] === 'unmatched').length} 项。`,
    '',
    '处理方式：运行 `n2q review` 交互选择，或按下面的 key 修改 `overrides.json`。',
    '值为 `"skip"` 表示跳过，`{ "id": "候选ID", "mid": "候选MID" }` 表示指定版本。',
    '',
  ];
  if (!pending.length) lines.push('全部项目均已确定，可以直接导入。');
  else lines.push('| key | 位置 | 源歌曲 | 自动结果 | 说明 |', '| --- | --- | --- | --- | --- |');
  for (const row of pending) {
    lines.push(`| \`${row[0]}\` | ${row[2] || '收藏'} | ${row[3]} | ${row[7] || '无候选'} | ${row[6] || ''} |`);
  }
  fs.writeFileSync(path.join(dataDir, 'review.md'), `${lines.join('\n')}\n`, { mode: 0o600 });

  writeJson(path.join(dataDir, 'unresolved.json'), unresolved.map((item) => ({
    key: item.key,
    playlist: item.playlist,
    name: item.track.source.name,
    artists: (item.track.source.artists || []).map((artist) => artist.name),
    status: item.track.status,
    reason: item.track.reason || '',
    candidates: (item.track.candidates || []).slice(0, 5).map((candidate) => ({
      id: candidate.id, mid: candidate.mid, name: candidate.name,
      artists: (candidate.artists || []).map((artist) => artist.name), score: candidate.score,
    })),
  })));

  return { pending: pending.length, unresolved: unresolved.length };
}

/**
 * 替代版本审计：只记录“不是精确匹配、但被自动或人工采用”的项，
 * 便于事后回答“这首歌为什么变成了这个版本”。
 */
function writeFallbackAudit(dataDir, matches, overrides) {
  const entries = [];
  for (const playlist of matches.playlists) {
    for (const track of playlist.tracks) {
      if (!track.selected) continue;
      const manual = overrides[track.key];
      // 精确匹配（自动通过的项）不进审计；没有任何决定的项目也不进。
      const confident = !manual && track.status === 'approved' && (
        track.reason === 'title-artist-album-or-duration'
        || (Number(track.selected.score) >= 92 && track.reason !== 'fallback-suggestion')
      );
      if (confident) continue;
      const fallbackReason = track.matchReason || track.reason || '';
      entries.push({
        key: track.key,
        playlist: playlist.name,
        source: {
          name: track.source.name,
          artists: (track.source.artists || []).map((artist) => artist.name),
          album: track.source.album,
          durationMs: track.source.durationMs,
        },
        chosen: {
          id: track.selected.id,
          mid: track.selected.mid,
          name: track.selected.name,
          artists: (track.selected.artists || []).map((artist) => artist.name),
          score: track.selected.score,
          popularity: track.selected.popularity,
        },
        strategy: manual ? 'manual' : (track.selected.score >= 92 ? 'automatic-approved' : 'fallback'),
        reason: fallbackReason,
      });
    }
  }
  writeJson(path.join(dataDir, 'fallback-audit.json'), {
    generatedAt: new Date().toISOString(),
    total: entries.length,
    entries,
  });
  return entries.length;
}

/** 终端摘要：导入前一眼看清各状态数量。 */
function summarize(plan) {
  const { report } = plan;
  return {
    approved: report.approved,
    overridden: report.overridden,
    skipped: report.skipped,
    review: report.review,
    unmatched: report.unmatched,
    total: report.total,
  };
}

module.exports = { writeReports, writeFallbackAudit, summarize };
