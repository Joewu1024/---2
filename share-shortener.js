(function (root) {
  'use strict';

  const endpoint = 'https://is.gd/create.php';
  const maximumLength = 5000;
  const minimumCooldown = 60000;
  const hour = 3600000;

  function validShortUrl(value) {
    return typeof value === 'string' && value === value.trim() && /^https:\/\/is\.gd\/[A-Za-z0-9_]{5,30}$/.test(value);
  }

  function create(options = {}) {
    options = options || {};
    const fetchImpl = options.fetchImpl === undefined ? root.fetch : options.fetchImpl;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 && options.timeoutMs <= 2147483647 ? options.timeoutMs : 10000;
    const maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries >= 0 ? Math.min(80, Math.floor(options.maxEntries)) : 80;
    const storageKey = typeof options.storageKey === 'string' && options.storageKey ? options.storageKey : 'buyer-share-shortener-isgd-v1';
    const clock = typeof options.now === 'function' ? options.now : Date.now;
    const cache = new Map(), pending = new Map(), queue = [];
    let active = 0, cooldownUntil = 0, attempts = [], storage = null, allowedOrigin = '';

    function now() {
      try { const value = clock(); if (Number.isFinite(value)) return value; } catch (error) {}
      return Date.now();
    }

    try {
      const input = options.allowedOrigin === undefined ? root.location && root.location.origin : options.allowedOrigin;
      if (typeof input === 'string') {
        const url = new URL(input);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/') allowedOrigin = url.origin;
      }
    } catch (error) {}
    try { storage = options.storage === undefined ? root.localStorage : options.storage; } catch (error) {}
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') storage = null;

    function inputReason(value) {
      if (!allowedOrigin || typeof value !== 'string' || !value || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return 'invalid_response';
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.origin !== allowedOrigin || url.username || url.password || !/\/share\.html$/.test(url.pathname) || !url.hash.startsWith('#d=') || url.hash.length <= 3) return 'invalid_response';
        if (value.length > maximumLength || url.href.length > maximumLength) return 'too_long';
      } catch (error) { return 'invalid_response'; }
      return '';
    }

    function remember(longUrl, shortUrl) {
      if (!maxEntries) return;
      cache.delete(longUrl); cache.set(longUrl, shortUrl);
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    }

    function persist() {
      if (!storage) return;
      try { storage.setItem(storageKey, JSON.stringify({ version: 1, entries: [...cache] })); }
      catch (error) { storage = null; }
    }

    if (storage && maxEntries) {
      try {
        const saved = JSON.parse(storage.getItem(storageKey) || 'null');
        if (saved && saved.version === 1 && Array.isArray(saved.entries)) {
          for (const entry of saved.entries) {
            if (!Array.isArray(entry) || entry.length !== 2 || inputReason(entry[0]) || !validShortUrl(entry[1])) continue;
            remember(entry[0], entry[1]);
          }
        }
      } catch (error) {}
    }

    const fallback = (url, reason) => ({ url, shortened: false, reason });

    function blocked() {
      const time = now();
      attempts = attempts.filter(value => value > time - hour);
      if (attempts.length >= 200) cooldownUntil = Math.max(cooldownUntil, attempts[0] + hour, time + minimumCooldown);
      return time < cooldownUntil;
    }

    function rateLimit(response) {
      let delay = minimumCooldown;
      try {
        const raw = response && response.headers && typeof response.headers.get === 'function' ? response.headers.get('Retry-After') : null;
        if (raw != null && String(raw).trim()) {
          const value = String(raw).trim();
          const parsed = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now();
          if (Number.isFinite(parsed)) delay = Math.max(delay, parsed);
        }
      } catch (error) {}
      cooldownUntil = Math.max(cooldownUntil, now() + delay);
    }

    async function request(longUrl) {
      if (typeof fetchImpl !== 'function') return fallback(longUrl, 'service_unavailable');
      const controller = new AbortController();
      let timer, timedOut = false;
      const deadline = new Promise(resolve => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(fallback(longUrl, 'timeout'));
          controller.abort();
        }, timeoutMs);
      });
      const operation = async () => {
        try {
          const body = new URLSearchParams();
          body.set('format', 'json'); body.set('url', longUrl);
          const response = await fetchImpl(endpoint, { method: 'POST', body, credentials: 'omit', redirect: 'error', signal: controller.signal });
          if (response && response.status === 429) {
            rateLimit(response); return fallback(longUrl, 'rate_limited');
          }
          let data;
          try { data = await response.json(); }
          catch (error) { return fallback(longUrl, timedOut ? 'timeout' : response && response.status >= 500 ? 'service_unavailable' : 'invalid_response'); }
          if (data && (data.errorcode === 3 || data.errorcode === '3')) {
            rateLimit(response); return fallback(longUrl, 'rate_limited');
          }
          if (data && (data.errorcode === 4 || data.errorcode === '4')) return fallback(longUrl, 'service_unavailable');
          if (data && data.errorcode !== undefined) return fallback(longUrl, 'invalid_response');
          if (!response || (response.status !== 200 && !(response.status == null && response.ok === true))) return fallback(longUrl, 'service_unavailable');
          if (!data || typeof data !== 'object' || Array.isArray(data) || data.errorcode !== undefined || !validShortUrl(data.shorturl)) return fallback(longUrl, 'invalid_response');
          if (timedOut) return fallback(longUrl, 'timeout');
          remember(longUrl, data.shorturl); persist();
          return { url: data.shorturl, shortened: true };
        } catch (error) { return fallback(longUrl, timedOut ? 'timeout' : 'network'); }
      };
      try { return await Promise.race([operation(), deadline]); }
      finally { clearTimeout(timer); }
    }

    function finish(job, result) {
      pending.delete(job.url); job.resolve(result);
    }

    function pump() {
      while (active < 5 && queue.length) {
        const job = queue.shift();
        if (blocked()) { finish(job, fallback(job.url, 'rate_limited')); continue; }
        active++; attempts.push(now());
        request(job.url).then(result => finish(job, result), () => finish(job, fallback(job.url, 'network'))).finally(() => { active--; pump(); });
      }
    }

    function shorten(longUrl) {
      let value;
      try { value = typeof longUrl === 'string' ? longUrl : String(longUrl == null ? '' : longUrl); }
      catch (error) { return Promise.resolve(fallback('', 'invalid_response')); }
      const reason = inputReason(value);
      if (reason) return Promise.resolve(fallback(value, reason));
      if (cache.has(value)) {
        const result = cache.get(value); remember(value, result);
        return Promise.resolve({ url: result, shortened: true });
      }
      if (pending.has(value)) return pending.get(value);
      if (blocked()) return Promise.resolve(fallback(value, 'rate_limited'));
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      pending.set(value, promise); queue.push({ url: value, resolve }); pump();
      return promise;
    }

    return { shorten };
  }

  const api = { create };
  root.BuyerShareShortener = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
