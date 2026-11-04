'use strict';

const fs = require('node:fs');
const path = require('node:path');
const asyncHooks = require('node:async_hooks');
const readline = require('node:readline');
const { HttpClient } = require('../lib/http');
const { readJson, writeJson, sleep } = require('../lib/util');
const { info, ok, warn, step, Progress, color } = require('../lib/ui');

const ROUTES = [
  '/login/qr/key', '/login/qr/create', '/login/qr/check', '/login/status',
  '/user/account', '/user/playlist', '/playlist/detail', '/playlist/track/all',
  '/song/detail', '/likelist', '/album/sublist', '/artist/sublist',
];

function normalizeTrack(song) {
  return {
    sourceId: String(song.id),
    name: song.name || '',
    artists: (song.ar || song.artists || []).map((artist) => ({ id: String(artist.id ?? ''), name: artist.name || '' })),
    album: song.al?.name || song.album?.name || '',
    albumId: String(song.al?.id || song.album?.id || ''),
    durationMs: song.dt ?? song.duration ?? null,
  };
}

/** 本地只读网易云接口：仅监听 127.0.0.1，只注册登录和收藏读取所需路由。 */
class NeteaseClient {
  constructor({ dataDir, port = 39876, log = () => {} } = {}) {
    this.dataDir = dataDir;
    this.port = port;
    this.base = `http://127.0.0.1:${port}`;
    this.http = new HttpClient({ delay: 150, log });
    this.cookieFile = path.join(dataDir, '.secrets', 'netease-session.json');
    this.cookie = '';
    this.log = log;
    this.silenceThirdPartyLogs();
  }

  /** 第三方库会把带 Cookie 的本地 URL 打进日志；统一拦截，避免凭据落盘。 */
  silenceThirdPartyLogs() {
    this.originalConsole = { log: console.log, warn: console.warn, error: console.error };
    for (const method of ['debug', 'info', 'warn', 'success']) {
      console[method] = (...args) => {
        const text = args.map(String).join(' ');
        if (text.includes('[eapi]') || text.includes('[weapi]') || text.includes('cookie=')) return;
        this.originalConsole.log(...args);
      };
    }
  }

  restoreConsole() {
    for (const [method, fn] of Object.entries(this.originalConsole || {})) console[method] = fn;
  }

  async start() {
    this.ownedTimers = new Set();
    this.timerHook = asyncHooks.createHook({
      init: (_id, type, _trigger, resource) => {
        if (type === 'Timeout') this.ownedTimers.add(resource);
      },
    });
    this.timerHook.enable();
    let ncm;
    try {
      ncm = require('@neteasecloudmusicapienhanced/api');
    } catch {
      throw new Error('缺少网易云接口依赖，请先运行 npm install');
    }
    const defs = await ncm.server.getModulesDefinitions(path.join(path.dirname(require.resolve('@neteasecloudmusicapienhanced/api/package.json')), 'module'));
    const wanted = new Set(ROUTES);
    try {
      this.app = await ncm.server.serveNcmApi({
        port: this.port,
        host: '127.0.0.1',
        checkVersion: false,
        moduleDefs: defs.filter((definition) => wanted.has(definition.route)),
      });
    } catch (error) {
      if (String(error?.code) === 'EADDRINUSE') {
        throw new Error(`端口 ${this.port} 已被占用；可用 --port 指定其他端口。`);
      }
      throw error;
    }
    if (fs.existsSync(this.cookieFile)) {
      this.cookie = readJson(this.cookieFile, '网易云登录态').cookie || '';
    }
  }

  async stop() {
    if (this.app?.server) {
      this.app.server.closeAllConnections?.();
      await new Promise((resolve) => this.app.server.close(resolve));
    }
    this.timerHook?.disable();
    for (const timer of this.ownedTimers || []) clearTimeout(timer);
    this.restoreConsole();
  }

  async api(route, params = {}) {
    return this.call(route, params, 'GET');
  }

  async apiPost(route, params = {}) {
    return this.call(route, params, 'POST');
  }

  async call(route, params, method) {
    const body = new URLSearchParams({ ...params, timestamp: String(Date.now()) });
    if (this.cookie) body.set('cookie', this.cookie);
    const headers = { Connection: 'close', 'x-apicache-bypass': '1' };
    let result;
    if (method === 'POST') {
      result = await this.http.request(`${this.base}${route}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } else {
      result = await this.http.request(`${this.base}${route}?${body}`, { headers });
    }
    const accepted = method === 'POST' ? [0, 200, 201] : [0, 200, 201, 800, 801, 802, 803];
    if (result.code !== undefined && !accepted.includes(Number(result.code))) {
      throw new Error(`${route} 返回 ${result.code}：${result.message || result.msg || '未知错误'}`);
    }
    return result;
  }

  async account() {
    const result = await this.api('/login/status');
    return result.data?.account ? result.data : null;
  }

  /** 粘贴网页 Cookie 登录：不回显、不经过第三方；二维码风控失败时的可靠替代。 */
  async loginManual() {
    if (!process.stdin.isTTY) throw new Error('请在本地交互终端执行 n2q login');
    step('网易云网页 Cookie 登录');
    info('在已登录 music.163.com 的浏览器中：F12 → Network → 任选请求 → 复制完整 Cookie。');
    warn('Cookie 等同登录凭据：不要发到聊天、不要粘贴进第三方网站。输入过程不会回显。');
    const cookie = await new Promise((resolve) => {
      const input = readline.createInterface({ input: process.stdin, output: process.stdout });
      input._writeToOutput = (text) => {
        if (text.includes('\n') || text.includes('\r')) input.output.write('\n');
      };
      input.question('粘贴 Cookie，回车确认：', (answer) => { input.close(); resolve(answer.trim()); });
    });
    if (!/(?:^|;\s*)MUSIC_U=/.test(cookie)) throw new Error('Cookie 缺少 MUSIC_U，请确认复制的是已登录完整 Cookie。');
    this.cookie = cookie;
    const account = await this.account();
    if (!account) throw new Error('该 Cookie 未通过网易云登录校验，请确认账号和 Cookie 是否完整。');
    writeJson(this.cookieFile, { cookie, savedAt: new Date().toISOString() });
    fs.chmodSync(this.cookieFile, 0o600);
    ok(`网易云登录成功：${account.profile?.nickname || account.account.id}`);
    return account;
  }

  async login() {
    if (this.cookie) {
      try {
        const account = await this.account();
        if (account) {
          ok(`已复用网易云登录态：${account.profile?.nickname || account.account.id}`);
          return account;
        }
      } catch { /* 登录态失效，继续扫码 */ }
      warn('原网易云登录态已失效。');
    }
    return this.loginQr();
  }

  async loginQr() {
    if (!process.stdin.isTTY) throw new Error('扫码登录需要交互终端；可先执行 n2q login 粘贴 Cookie。');
    const QRCode = require('qrcode');
    const key = (await this.api('/login/qr/key')).data.unikey;
    const qr = (await this.api('/login/qr/create', { key, qrimg: 'true' })).data;
    info('请用网易云音乐 App 扫码（若提示环境异常，改用 n2q login 粘贴网页 Cookie）。');
    console.log(`\n${qr.qrurl}\n`);

    const showQr = () => QRCode.toString(qr.qrurl, { type: 'terminal', small: true }).then((text) => console.log(text));
    await showQr();
    const deadline = Date.now() + 5 * 60 * 1000;
    let lastShown = Date.now();
    while (Date.now() < deadline) {
      const result = await this.api('/login/qr/check', { key, noCookie: 'true' });
      const code = Number(result.code);
      if (code === 803 && result.cookie) {
        this.cookie = result.cookie;
        writeJson(this.cookieFile, { cookie: result.cookie, savedAt: new Date().toISOString() });
        fs.chmodSync(this.cookieFile, 0o600);
        ok('网易云扫码登录成功。');
        return this.account();
      }
      if (code === 800) throw new Error('二维码已过期，请重新执行。');
      if (code === 802) info('已扫码，请在手机 App 中确认。');
      // 每 30 秒重绘一次二维码，避免终端滚动后失效。
      if (code !== 802 && Date.now() - lastShown > 30000) { await showQr(); lastShown = Date.now(); }
      await sleep(3000);
    }
    throw new Error('等待扫码超时，请重新执行；也可用 n2q login 粘贴网页 Cookie。');
  }

  async paginate(route, params, getItems, { limit = 100 } = {}) {
    const items = [];
    for (let offset = 0; offset < 20000; offset += limit) {
      const result = await this.api(route, { ...params, offset, limit });
      const page = getItems(result) || [];
      items.push(...page);
      if (page.length < limit || result.hasMore === false || result.more === false) return items;
    }
    throw new Error(`${route} 分页超过安全上限，已停止以避免死循环。`);
  }

  async playlist(id, name, owned) {
    const meta = await this.apiPost('/playlist/detail', { id });
    const detail = meta.playlist || {};
    const trackIds = (detail.trackIds || []).map((track) => String(track.id));
    if (!trackIds.length && !detail.trackCount) {
      return {
        sourceId: String(id), name: name || detail.name, owned,
        sourceUrl: `https://music.163.com/playlist?id=${id}`, tracks: [],
      };
    }

    const tracks = [];
    const seen = new Set();
    const progress = new Progress(`  ${name || detail.name}`, trackIds.length);
    for (let offset = 0; offset < trackIds.length; offset += 100) {
      const ids = trackIds.slice(offset, offset + 100);
      const result = await this.apiPost('/song/detail', { ids: ids.join(',') });
      for (const song of result.songs || []) {
        if (seen.has(String(song.id))) continue;
        seen.add(String(song.id));
        tracks.push(normalizeTrack(song));
      }
      progress.update(Math.min(offset + ids.length, trackIds.length));
    }
    progress.done();

    if (tracks.length !== trackIds.length) {
      throw new Error(`歌单《${name || detail.name}》导出不完整：${trackIds.length} 首中只读到 ${tracks.length} 首。请重试，勿用不完整备份继续。`);
    }
    return {
      sourceId: String(id), name: name || detail.name, owned,
      sourceUrl: `https://music.163.com/playlist?id=${id}`, tracks,
    };
  }

  async export({ onProgress = () => {} } = {}) {
    const account = await this.account();
    if (!account) throw new Error('网易云未登录或登录态失效，请执行 n2q login。');
    const uid = account.account.id;
    const rawPlaylists = await this.paginate('/user/playlist', { uid }, (result) => result.playlist);
    const playlists = [];
    for (const [index, item] of rawPlaylists.entries()) {
      onProgress(index, rawPlaylists.length, item.name);
      const owned = Number(item.creator?.userId) === Number(uid);
      playlists.push(await this.playlist(item.id, item.name, owned));
    }

    step('导出收藏专辑');
    const rawAlbums = await this.paginate('/album/sublist', {}, (result) => result.data);
    const albums = rawAlbums.map((album) => ({
      sourceId: String(album.id), name: album.name,
      artists: (album.artists || [album.artist]).filter(Boolean).map((artist) => ({ id: String(artist.id), name: artist.name })),
    }));

    step('导出关注歌手');
    const rawArtists = await this.paginate('/artist/sublist', {}, (result) => result.data);
    const artists = rawArtists.map((artist) => ({ sourceId: String(artist.id), name: artist.name }));

    // 网易云“我喜欢的音乐”是本人歌单；名称随语言变化，用 specialType/ID + 归属双重判断。
    const liked = playlists.find((item) => item.owned && (
      rawPlaylists.find((raw) => String(raw.id) === item.sourceId)?.specialType === 5
      || /喜欢的音乐|liked/i.test(item.name)
    ));

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      account: { id: String(uid), nickname: account.profile?.nickname || '' },
      likedPlaylistId: liked?.sourceId || null,
      playlists, albums, artists,
      stats: {
        playlists: playlists.length,
        ownedPlaylists: playlists.filter((playlist) => playlist.owned).length,
        tracks: playlists.reduce((sum, playlist) => sum + playlist.tracks.length, 0),
        albums: albums.length,
        artists: artists.length,
      },
      note: '收藏他人的歌单只备份；默认只迁移本人歌单，避免把他人歌单混入自己的 QQ 账号。',
    };
  }

  /** 只导出不写 QQ 的“干跑”资源清单，供报告使用。 */
  summary(backup) {
    const owned = backup.playlists.filter((playlist) => playlist.owned);
    return {
      playlists: backup.playlists.length,
      owned: owned.length,
      liked: backup.likedPlaylistId,
      tracks: owned.reduce((sum, playlist) => sum + playlist.tracks.length, 0),
      uniqueTracks: new Set(owned.flatMap((playlist) => playlist.tracks.map((track) => track.sourceId))).size,
      albums: backup.albums.length,
      artists: backup.artists.length,
    };
  }
}

module.exports = { NeteaseClient, normalizeTrack };
