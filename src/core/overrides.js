'use strict';

const fs = require('node:fs');
const { readJson, writeJson, assertObject } = require('../lib/util');

/**
 * overrides.json 是唯一的人工决策来源，格式：
 *   "track:<playlistId>:<index>": "skip"
 *   "track:<playlistId>:<index>": { "id": "97773", "mid": "0039MnYb0qxYhV" }
 *   "track:<playlistId>:<index>": { "id": "...", "keep": true }  // 人工确认自动选择
 * 键包含歌单位置，因此同一首歌在多个歌单出现时可分别处理。
 */
class Overrides {
  constructor(file) {
    this.file = file;
    this.data = fs.existsSync(file) ? assertObject(readJson(file, 'overrides.json'), 'overrides.json') : {};
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
  }

  remove(key) {
    delete this.data[key];
  }

  keys() {
    return Object.keys(this.data);
  }

  save() {
    writeJson(this.file, this.data);
  }
}

module.exports = { Overrides };
