'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson } = require('../lib/util');

/**
 * 搜索缓存：按“类型 + 查询词”持久化。
 * 断点续跑和多轮匹配都靠它避免重复请求 QQ，减少触发风控的概率。
 */
class SearchCache {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    if (fs.existsSync(file)) {
      try {
        for (const [key, value] of Object.entries(readJson(file, '搜索缓存'))) this.map.set(key, value);
      } catch {
        // 缓存损坏不应阻塞迁移，直接重建。
        this.map.clear();
      }
    }
    this.hits = 0;
    this.dirty = false;
  }

  get size() { return this.map.size; }

  has(type, query) {
    const hit = this.map.has(SearchCache.key(type, query));
    if (hit) this.hits += 1;
    return hit;
  }

  get(type, query) {
    return this.map.get(SearchCache.key(type, query)) || null;
  }

  set(type, query, results) {
    this.map.set(SearchCache.key(type, query), results);
    this.dirty = true;
  }

  save() {
    if (!this.dirty) return;
    writeJson(this.file, Object.fromEntries(this.map));
    this.dirty = false;
  }

  static key(type, query) {
    return `${type}:${query}`;
  }
}

module.exports = { SearchCache };
