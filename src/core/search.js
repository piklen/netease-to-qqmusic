'use strict';

const { matchSong, matchAlbum, matchArtist, pickFallback } = require('./matching');
const { info } = require('../lib/ui');

/** 生成多组查询词：先用完整信息，再用更宽松的版本，兼顾准确率和召回。 */
function songQueries(track) {
  const artists = (track.artists || []).map((artist) => artist.name).filter(Boolean);
  const queries = [`${track.name} ${artists.join(' ')}`.trim()];
  if (artists.length) queries.push(`${track.name} ${artists[0]}`.trim());
  queries.push(track.name);
  return [...new Set(queries.filter(Boolean))];
}

/**
 * 为一张歌单做匹配。带缓存的查询避免重复请求，真实请求之间保持顺序以防风控。
 */
class Matcher {
  constructor({ bridge, cache, log = () => {}, useFallback = true }) {
    this.bridge = bridge;
    this.cache = cache;
    this.log = log;
    this.useFallback = useFallback;
    this.requests = 0;
    this.cacheHits = 0;
  }

  async search(type, query, limit = 10) {
    if (this.cache.has(type, query)) {
      this.cacheHits += 1;
      return this.cache.get(type, query);
    }
    const result = await this.bridge.send({ command: 'search', query, type, limit });
    this.requests += 1;
    this.cache.set(type, query, result.results || []);
    this.cache.save();
    return result.results || [];
  }

  async song(track) {
    let best = null;
    let candidates = [];
    for (const [index, query] of songQueries(track).entries()) {
      const raw = await this.search(0, query, 10);
      const result = matchSong(track, raw);
      if (!best || result.candidates.length > candidates.length || result.status === 'approved') {
        best = result;
        candidates = result.candidates;
      }
      if (result.status === 'approved') break;
      // 首个查询已覆盖完整信息，后续仅在无结果或存在候选时补充。
      if (index > 1 && !raw.length) break;
    }
    const result = best || { status: 'unmatched', best: null, candidates: [] };
    if (result.status !== 'approved' && this.useFallback) {
      const fallback = pickFallback(track, result.candidates);
      if (fallback) {
        return { status: 'review', best: fallback, candidates: result.candidates, fallback: true, reason: 'fallback-suggestion' };
      }
    }
    return result;
  }

  async album(album) {
    const query = `${album.name} ${(album.artists || []).map((artist) => artist.name).join(' ')}`.trim();
    const raw = await this.search(8, query, 10);
    return matchAlbum(album, raw);
  }

  async artist(artist) {
    const raw = await this.search(9, artist.name, 10);
    return matchArtist(artist, raw);
  }
}

module.exports = { Matcher, songQueries };
