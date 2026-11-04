'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchSong, matchAlbum, matchArtist, songCandidates, pickFallback } = require('../src/core/matching');
const { normalize, normalize: norm, baseTitle, versionTags, songTitleSimilarity } = require('../src/lib/util');

const song = {
  sourceId: '186016', name: '晴天', artists: [{ name: '周杰伦' }], album: '叶惠美', durationMs: 269000,
};
const candidates = [
  { songmid: '0039MnYb0qxYhV', songid: 97773, songname: '晴天', singer: [{ name: '周杰伦' }], albumname: '叶惠美', interval: 269, fav_show: 100000 },
  { songmid: '004Fs2FP1EvZYc', songid: 123, songname: '晴天 (Live)', singer: [{ name: '周杰伦' }], albumname: '演唱会', interval: 249, fav_show: 5000 },
];

test('精确歌名、歌手、专辑及时长可自动匹配', () => {
  const result = matchSong(song, candidates);
  assert.equal(result.status, 'approved');
  assert.equal(result.best.id, '97773');
  assert.equal(result.best.type, 1);
});

test('仅同名不同歌手不会自动写入', () => {
  const wrong = [{ ...candidates[0], singer: [{ name: '其他人' }] }];
  assert.equal(matchSong(song, wrong).status, 'review');
  assert.equal(matchSong(song, []).status, 'unmatched');
});

test('Live 版不会被当作录音室版自动写入', () => {
  const live = { ...song, name: '晴天', album: '叶惠美', durationMs: 269000 };
  const onlyLive = [candidates[1]];
  const result = matchSong(live, onlyLive);
  assert.equal(result.status, 'review');
  assert.ok(result.best.versionMismatch.includes('live') || result.best.score < 92);
});

test('版本一致时 Live 歌单可自动匹配 Live 结果', () => {
  const live = { ...song, name: '晴天 (Live)', album: '演唱会', durationMs: 249000 };
  assert.equal(matchSong(live, candidates).status, 'approved');
});

test('候选同分时必须人工确认', () => {
  const duplicate = [{ ...candidates[0] }, { ...candidates[0], songid: 456 }];
  assert.equal(matchSong(song, duplicate).status, 'review');
});

test('专辑与歌手必须精确匹配', () => {
  const album = { name: '叶惠美', artists: [{ name: '周杰伦' }] };
  assert.equal(matchAlbum(album, [{ albumMID: 'a', albumID: 8220, albumName: '叶惠美', singerName: '周杰伦' }]).status, 'approved');
  assert.notEqual(matchAlbum(album, [{ albumName: '叶惠美', singerName: '翻唱者', albumID: 1 }]).status, 'approved');
  assert.equal(matchArtist({ name: '周杰伦' }, [{ singerMID: 'm', singerID: 4558, singerName: '周杰伦' }]).status, 'approved');
});

test('feat. 合作歌手可以识别为同歌手', () => {
  const source = { name: '合作曲', artists: [{ name: 'A' }, { name: 'B' }], album: '', durationMs: 200000 };
  const raw = [{ songid: 1, songmid: 'x', songname: '合作曲', singer: [{ name: 'A' }], albumname: '', interval: 200 }];
  assert.ok(matchSong(source, raw).best.artistScore > 0);
});

test('归一化保留中文并忽略全角/标点差异', () => {
  assert.equal(normalize('晴天（Live）'), normalize('晴天(live)'));
  assert.notEqual(normalize('周杰伦'), normalize('周杰倫'));
  assert.equal(baseTitle('晴天 (Live)'), '晴天');
  assert.ok(versionTags('晴天 (Live)').has('live'));
  assert.ok(songTitleSimilarity('晴天', '晴天') === 1);
});

test('替代版本优先同歌手，其次相关歌名', () => {
  const cands = songCandidates([
    { songid: 1, songmid: 'a', songname: '晴天', singer: [{ name: '周杰伦' }], fav_show: 10 },
    { songid: 2, songmid: 'b', songname: '晴天', singer: [{ name: '翻唱者' }], fav_show: 99999999 },
  ]);
  const picked = pickFallback(song, cands);
  assert.equal(picked.id, '1');
});

test('无相关结果时不强行选择', () => {
  const cands = songCandidates([{ songid: 9, songmid: 'z', songname: '完全无关', singer: [{ name: '别人' }] }]);
  assert.equal(pickFallback(song, cands), null);
});
