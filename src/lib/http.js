'use strict';

const { sleep, cleanError } = require('./util');

class HttpError extends Error {
  constructor(message, { status, code, retryable = false, cause } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

/** 带节流和指数退避的 JSON 请求器。对 429/5xx 自动重试，4xx 直接失败。 */
class HttpClient {
  constructor({ delay = 300, retries = 3, timeout = 30000, log = () => {} } = {}) {
    this.delay = delay;
    this.retries = retries;
    this.timeout = timeout;
    this.log = log;
    this.lastRequest = 0;
    this.requestCount = 0;
  }

  async throttle() {
    const wait = Math.max(0, this.lastRequest + this.delay - Date.now());
    if (wait) await sleep(wait);
    this.lastRequest = Date.now();
    this.requestCount += 1;
  }

  async request(url, { method = 'GET', headers = {}, body, timeout = this.timeout, retries = this.retries } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      await this.throttle();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      let retryable = true;
      try {
        const response = await fetch(url, {
          method,
          headers: { Accept: 'application/json, text/plain, */*', ...headers },
          body,
          redirect: 'follow',
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          throw new HttpError(`HTTP ${response.status}`, { status: response.status, retryable });
        }
        try {
          return JSON.parse(text.replace(/^(?:callback|MusicJsonCallback|jsonCallback)\(/, '').replace(/\);?\s*$/, ''));
        } catch {
          throw new HttpError(`接口返回非 JSON：${text.slice(0, 120)}`, { status: response.status, retryable: false });
        }
      } catch (error) {
        lastError = error instanceof HttpError
          ? error
          : new HttpError(cleanError(error), { retryable: error.name === 'AbortError' || error.name === 'TypeError' });
        if (!lastError.retryable || attempt === retries) break;
        const backoff = Math.min(8000, attempt * 1200 * (1 + Math.random() * 0.3));
        this.log(`请求失败（${attempt}/${retries}）：${lastError.message}，${Math.round(backoff)}ms 后重试`);
        await sleep(backoff);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }
}

module.exports = { HttpClient, HttpError };
