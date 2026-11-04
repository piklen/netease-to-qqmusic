'use strict';

const fs = require('node:fs');
const { readJson, writeJson } = require('../lib/util');

/**
 * 断点状态。兼容旧版 v1 文件（playlists/items/errors 三个字段），
 * 让已经跑完的迁移仍可 status / verify。
 */
class MigrationState {
  constructor(file) {
    this.file = file;
    this.data = fs.existsSync(file)
      ? readJson(file, '迁移断点')
      : { version: 1, playlists: {}, items: {}, errors: {} };
    this.data.playlists ||= {};
    this.data.items ||= {};
    this.data.errors ||= {};
    this.data.stats ||= { added: 0, skipped: 0, failed: 0, playlists: 0 };
    this.dirty = false;
  }

  get accountId() { return this.data.accountId; }

  set accountId(value) {
    if (value) this.data.accountId = String(value);
  }

  playlist(sourceId) { return this.data.playlists[sourceId]; }

  setPlaylist(sourceId, mapping) {
    this.data.playlists[sourceId] = mapping;
    this.dirty = true;
  }

  isDone(key) { return this.data.items[key] === 'done'; }

  markDone(key) {
    this.data.items[key] = 'done';
    delete this.data.errors[key];
    this.dirty = true;
  }

  markFailed(key, message) {
    this.data.errors[key] = message;
    this.dirty = true;
  }

  save() {
    if (!this.dirty) return;
    writeJson(this.file, this.data);
    this.dirty = false;
  }

  summary() {
    const items = Object.values(this.data.items);
    return {
      playlists: Object.keys(this.data.playlists).length,
      done: items.filter((value) => value === 'done').length,
      failed: Object.keys(this.data.errors).length,
    };
  }
}

module.exports = { MigrationState };
