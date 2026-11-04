'use strict';

const {
  normalize, baseTitle, versionTags, songTitleSimilarity, formatDuration,
} = require('../lib/util');

const AUTO_APPROVE_SCORE = 92;
const MAX_CANDIDATES = 8;

function artistNames(artists) {
  return (artists || []).map((artist) => artist.name || artist).filter(Boolean);
}

function splitArtists(value) {
  return String(value || '')
    .split(/\s*(?:\/|&|,|、|;| feat\.? | featuring | ft\.? )\s*/i)
    .map((name) => name.trim())
    .filter(Boolean);
}

function artistSimilarity(source, target) {
  const left = artistNames(source);
  const right = target;
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right.map(normalize));
  const leftSet = left.map(normalize);

  const exact = leftSet.filter((name) => rightSet.has(name)).length;
  if (exact) return Math.min(1, exact / Math.max(leftSet.length, 1) + 0.2);
  // feat. 合作歌手经常只出现在一侧，逐个拆分比对。
  const leftParts = new Set(left.flatMap(splitArtists).map(normalize));
  const rightParts = new Set(right.flatMap(splitArtists).map(normalize));
  const overlap = [...leftParts].filter((name) => rightParts.has(name));
  if (overlap.length) return 0.6 * (overlap.length / Math.max(leftParts.size, 1));
  // 包含关系：如 “周杰伦” vs “周杰伦 Jay Chou”。
  const contained = leftSet.some((name) => rightSet.has(name) || [...rightSet].some((other) => other.includes(name) || name.includes(other)));
  return contained ? 0.5 : 0;
}

function songCandidates(raw) {
  return raw.map((song) => ({
    mid: String(song.songmid || song.mid || ''),
    id: String(song.songid || song.id || ''),
    type: Number(song.type || 1),
    name: song.songname || song.name || song.title || '',
    artists: (song.singer || song.singers || []).map((singer) => ({ name: singer.name || singer.title || '' })),
    album: song.albumname || song.album?.name || song.album?.title || '',
    durationMs: song.interval != null ? Number(song.interval) * 1000 : (song.intervalMs || null),
    popularity: Number(song.fav_show || song.listenCount || 0) || 0,
  }));
}

/**
 * 对搜索结果评分并给出可解释的原因。
 * 严格模式下只有“标题完全一致 + 歌手一致 + 专辑或时长佐证 + 无同分”才自动通过。
 */
function scoreSong(source, candidate, index) {
  const sourceArtists = artistNames(source.artists);
  const targetArtists = artistNames(candidate.artists);
  const titleExact = normalize(source.name) === normalize(candidate.name);
  const titleBaseExact = normalize(baseTitle(source.name)) === normalize(baseTitle(candidate.name));
  const titleSimilarity = songTitleSimilarity(source.name, candidate.name);
  const artistScore = artistSimilarity(sourceArtists, targetArtists);
  const albumExact = Boolean(normalize(source.album)) && normalize(source.album) === normalize(candidate.album);
  const durationDiff = source.durationMs && candidate.durationMs
    ? Math.abs(source.durationMs - candidate.durationMs) : null;

  const sourceVersions = versionTags(source.name, source.album);
  const targetVersions = versionTags(candidate.name, candidate.album);
  const missingVersion = [...sourceVersions].filter((tag) => !targetVersions.has(tag));
  const extraVersion = [...targetVersions].filter((tag) => !sourceVersions.has(tag));

  let score = 0;
  if (titleExact) score += 70;
  else if (titleBaseExact) score += 56;
  else score += Math.round(titleSimilarity * 45);
  score += Math.round(artistScore * 30);
  if (albumExact) score += 6;
  if (durationDiff != null) {
    if (durationDiff <= 3000) score += 5;
    else if (durationDiff > 30000) score -= 12;
  }
  if (missingVersion.length) score -= 30;
  if (extraVersion.length) score -= 22;
  if (!artistScore) score -= 15;

  return {
    ...candidate,
    score: Math.max(0, Math.min(100, score)),
    titleExact,
    titleBaseExact,
    titleSimilarity,
    artistScore,
    artistExact: artistScore >= 1,
    albumExact,
    durationDiff,
    versionMismatch: [...missingVersion, ...extraVersion],
    index,
  };
}

function matchSong(source, rawCandidates) {
  const candidates = songCandidates(rawCandidates);
  const ranked = candidates
    .map((candidate, index) => scoreSong(source, candidate, index))
    .sort((left, right) => right.score - left.score || right.popularity - left.popularity || left.index - right.index);
  const best = ranked[0];
  if (!best) return { status: 'unmatched', best: null, candidates: [], reason: 'qq-has-no-result' };

  const tied = ranked.filter((candidate) => candidate.score === best.score);
  const corroborated = best.albumExact || best.durationDiff == null || best.durationDiff <= 3000;
  const autoOk = best.score >= AUTO_APPROVE_SCORE
    && (best.titleExact || best.titleBaseExact)
    && best.artistScore >= 1
    && corroborated
    && best.versionMismatch.length === 0
    && tied.length === 1;

  return {
    status: autoOk ? 'approved' : 'review',
    best,
    candidates: ranked.slice(0, MAX_CANDIDATES),
    reason: autoOk ? 'title-artist-album-or-duration' : explainReview(best, tied.length),
  };
}

function explainReview(best, tiedCount) {
  if (tiedCount > 1) return '多个候选同分';
  if (best.score < AUTO_APPROVE_SCORE) return `相关度不足（${best.score} 分）`;
  if (best.artistScore < 1) return '歌手不完全一致';
  if (best.versionMismatch.length) return `版本不同：${best.versionMismatch.join('/')}`;
  if (best.durationDiff != null && best.durationDiff > 3000) return '时长差异较大';
  return '需要人工确认';
}

function matchAlbum(source, rawCandidates) {
  const candidates = rawCandidates.map((album) => ({
    mid: String(album.albumMID || album.albumMid || album.mid || ''),
    id: String(album.albumID || album.albumId || album.id || ''),
    name: album.albumName || album.name || album.title || '',
    artists: album.singer_list || album.singerList || [{ name: album.singerName || album.singer_name || '' }],
    score: 0,
  })).map((candidate) => ({
    ...candidate,
    score: (normalize(candidate.name) === normalize(source.name) ? 80 : Math.round(songTitleSimilarity(source.name, candidate.name) * 40))
      + Math.round(artistSimilarity(artistNames(source.artists), artistNames(candidate.artists)) * 20),
  })).sort((left, right) => right.score - left.score);
  const matches = candidates.filter((candidate) => normalize(candidate.name) === normalize(source.name)
    && artistSimilarity(artistNames(source.artists), artistNames(candidate.artists)) >= 1);
  return {
    status: matches.length === 1 ? 'approved' : candidates.length ? 'review' : 'unmatched',
    best: matches[0] || candidates[0] || null,
    candidates: candidates.slice(0, MAX_CANDIDATES),
  };
}

function matchArtist(source, rawCandidates) {
  const candidates = rawCandidates.map((artist) => ({
    mid: String(artist.singerMID || artist.singerMid || artist.mid || ''),
    id: String(artist.singerID || artist.singerId || artist.id || ''),
    name: artist.singerName || artist.name || artist.title || '',
    score: normalize(artist.name) === normalize(source.name) || normalize(artist.singerName).includes(normalize(source.name)) ? 90 : 0,
  })).sort((left, right) => right.score - left.score);
  const matches = candidates.filter((candidate) => normalize(candidate.name) === normalize(source.name));
  return {
    status: matches.length === 1 ? 'approved' : candidates.length ? 'review' : 'unmatched',
    best: matches[0] || candidates[0] || null,
    candidates: candidates.slice(0, MAX_CANDIDATES),
  };
}

/** 从候选中挑出“同歌手 + 相关歌名”的热门版本，用于无精确匹配时的替代。 */
function pickFallback(source, candidates) {
  const pool = candidates.length ? candidates : [];
  const sameArtist = pool.filter((candidate) => artistSimilarity(artistNames(source.artists), artistNames(candidate.artists)) > 0);
  const related = pool.filter((candidate) => songTitleSimilarity(source.name, candidate.name) >= 0.5);
  const base = sameArtist.length ? sameArtist : related;
  if (!base.length) return null;
  return [...base].sort((left, right) => (right.score + Math.log10(1 + right.popularity) * 8) - (left.score + Math.log10(1 + left.popularity) * 8))[0];
}

function describeCandidate(candidate) {
  if (!candidate) return '无候选';
  const artists = artistNames(candidate.artists).join('/') || '未知歌手';
  const duration = candidate.durationMs ? ` ${formatDuration(candidate.durationMs)}` : '';
  return `${candidate.name} - ${artists}${duration} [id=${candidate.id}; mid=${candidate.mid}]`;
}

module.exports = {
  songCandidates,
  matchSong,
  matchAlbum,
  matchArtist,
  pickFallback,
  describeCandidate,
  artistSimilarity,
  AUTO_APPROVE_SCORE,
};
