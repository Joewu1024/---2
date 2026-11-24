(function (root) {
  'use strict';

  // This client only accepts a server-confirmed immutable snapshot. It never
  // substitutes a browser-local ID map or a redirect-shortener URL.
  const ID = /^[A-Za-z0-9_-]{22}$/;
  const TOKEN = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
  const TOKEN_IN_TEXT = /[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/;
  const FIELDS = ['id', 'model', 'itemChinese', 'modelChinese', 'category', 'invitation', 'target', 'shopee', 'shopeeUrl'];
  const MESSAGES = {
    invalid_config: '分享存储服务配置无效，请联系管理员',
    invalid_products: '请选择有效的产品后再生成分享',
    crypto_unavailable: '当前浏览器无法安全生成分享编号，请更新浏览器后重试',
    invalid_response: '分享服务未确认保存成功，请稍后重试',
    unauthorized: '分享写入授权暂不可用，请稍后重试',
    forbidden: '当前工作台没有分享写入权限，请联系管理员',
    too_large: '分享内容过大，请减少产品数量后重试',
    rate_limited: '分享生成过于频繁，请稍后重试',
    storage_full: '分享存储容量已满，已有分享仍可查看，请联系管理员',
    unavailable: '分享存储服务暂不可用，请稍后重试',
    network: '无法连接分享存储服务，请稍后重试',
    timeout: '保存分享超时，请稍后重试',
    stale: '分享内容或工作区已变更，请重新生成',
    aborted: '分享生成已取消'
  };

  function error(code, extra) {
    const result = new Error(MESSAGES[code] || MESSAGES.unavailable);
    result.code = code;
    if (extra) Object.assign(result, extra);
    return result;
  }

  function validBase(value) {
    if (typeof value !== 'string' || value !== value.trim() || /[\u0000-\u0020\u007f\\]/.test(value)) throw error('invalid_config');
    let url;
    try { url = new URL(value); } catch (ignored) { throw error('invalid_config'); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /%(?:2e|2f|5c)/i.test(url.pathname) ||
      host === 'localhost' || host.endsWith('.localhost') || /^(?:127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) ||
      /^\[(?:::1|::|f[cd][\da-f]{2}:|fe[89ab][\da-f]:)/i.test(host)) throw error('invalid_config');
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url;
  }

  function snapshotProducts(products) {
    if (!Array.isArray(products) || !products.length || products.length > 200) throw error('invalid_products');
    try {
      return products.map(product => {
        if (!product || typeof product !== 'object' || Array.isArray(product)) throw error('invalid_products');
        const saved = {};
        for (const field of FIELDS) saved[field] = String(product[field] == null ? '' : product[field]);
        if (product.badges != null && !Array.isArray(product.badges)) throw error('invalid_products');
        saved.badges = (product.badges || []).map(badge => {
          if (!badge || typeof badge !== 'object' || Array.isArray(badge)) throw error('invalid_products');
          return { kind: String(badge.kind == null ? '' : badge.kind), icon: String(badge.icon == null ? '' : badge.icon), text: String(badge.text == null ? '' : badge.text) };
        });
        return saved;
      });
    } catch (failure) {
      if (failure && failure.code === 'invalid_products') throw failure;
      throw error('invalid_products');
    }
  }

  function create(options = {}) {
    options = options || {};
    const base = validBase(options.baseUrl);
    if (options.allowedOrigin !== undefined) {
      const allowed = validBase(options.allowedOrigin);
      if (allowed.origin !== base.origin || allowed.pathname !== '/') throw error('invalid_config');
    }
    const baseUrl = base.origin + base.pathname.replace(/\/$/, '');
    const fetchImpl = options.fetchImpl === undefined ? root.fetch : options.fetchImpl;
    const timeoutMs = options.timeoutMs === undefined ? 60000 : options.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 180000) throw error('invalid_config');
    const storageKey = typeof options.storageKey === 'string' && options.storageKey ? options.storageKey : 'buyer-persistent-share-writer-v1:' + baseUrl;
    let storage = null, writerToken = '', writerPending = null;
    try {
      storage = options.storage === undefined ? root.localStorage : options.storage;
      if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') storage = null;
    } catch (ignored) { storage = null; }

    if (storage) {
      try {
        const saved = JSON.parse(storage.getItem(storageKey) || 'null');
        if (saved && saved.v === 1 && saved.baseUrl === baseUrl && TOKEN.test(saved.token)) writerToken = saved.token;
      } catch (ignored) {}
    }

    function remember(token) {
      writerToken = token;
      if (storage) {
        try { storage.setItem(storageKey, JSON.stringify({ v: 1, baseUrl, token })); }
        catch (ignored) { storage = null; }
      }
    }

    function forget(token) {
      if (writerToken !== token) return;
      writerToken = '';
      if (storage) {
        try {
          if (typeof storage.removeItem === 'function') storage.removeItem(storageKey);
          else storage.setItem(storageKey, 'null');
        } catch (ignored) { storage = null; }
      }
    }

    // The race enforces a deadline even when a test transport or old WebView
    // ignores AbortSignal. Shared bootstrap has its own independent deadline.
    function withDeadline(operation, callerSignal) {
      const controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
      let timer, rejectStop;
      const stopped = new Promise((resolve, reject) => { rejectStop = reject; });
      const stop = code => { rejectStop(error(code)); if (controller) controller.abort(); };
      const aborted = () => stop('aborted');
      if (callerSignal && callerSignal.aborted) return Promise.reject(error('aborted'));
      if (callerSignal) callerSignal.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => stop('timeout'), timeoutMs);
      const task = Promise.resolve().then(() => operation(controller ? controller.signal : undefined));
      return Promise.race([task, stopped]).finally(() => {
        clearTimeout(timer);
        if (callerSignal) callerSignal.removeEventListener('abort', aborted);
      });
    }

    async function request(path, body, token, signal) {
      if (typeof fetchImpl !== 'function') throw error('unavailable');
      const endpoint = baseUrl + path;
      return withDeadline(async requestSignal => {
        const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
        if (token) headers.Authorization = 'Bearer ' + token;
        let response;
        try {
          response = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit', redirect: 'error', cache: 'no-store', signal: requestSignal });
        } catch (failure) {
          if (requestSignal && requestSignal.aborted) throw error('aborted');
          throw error('network');
        }
        if (!response || response.redirected || (response.url && response.url !== endpoint)) throw error('invalid_response');
        if (response.status === 401) throw error('unauthorized');
        if (response.status === 403) throw error('forbidden');
        if (response.status === 413) throw error('too_large');
        if (response.status === 429) {
          let limited;
          try { limited = await response.json(); } catch (ignored) {}
          if (limited && !Array.isArray(limited) && limited.error && !Array.isArray(limited.error) && limited.error.code === 'STORAGE_LIMIT') throw error('storage_full');
          let retryAfterSeconds;
          try {
            const raw = response.headers && response.headers.get('Retry-After');
            if (raw && /^\d+$/.test(raw) && Number(raw) <= 86400) retryAfterSeconds = Number(raw);
          } catch (ignored) {}
          throw error('rate_limited', retryAfterSeconds === undefined ? undefined : { retryAfterSeconds });
        }
        if (response.status !== 200 && response.status !== 201) throw error('unavailable');
        let data;
        try { data = await response.json(); } catch (ignored) { throw error('invalid_response'); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw error('invalid_response');
        return data;
      }, signal);
    }

    function token() {
      if (writerToken) return Promise.resolve(writerToken);
      if (!writerPending) {
        writerPending = request('/api/writers', {}, '', undefined).then(data => {
          if (typeof data.token !== 'string' || !TOKEN.test(data.token)) throw error('invalid_response');
          remember(data.token);
          return data.token;
        }).finally(() => { writerPending = null; });
      }
      return writerPending;
    }

    function requestId() {
      try {
        if (root.crypto && typeof root.crypto.randomUUID === 'function') {
          const id = root.crypto.randomUUID();
          if (/^[A-Za-z0-9_-]{8,80}$/.test(id)) return id;
        }
      } catch (ignored) {}
      try {
        if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
          const bytes = new Uint8Array(16); root.crypto.getRandomValues(bytes);
          return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
        }
      } catch (ignored) {}
      throw error('crypto_unavailable');
    }

    function result(data, products) {
      const imageCount = products.filter(product => product.model.trim()).length;
      if (typeof data.id !== 'string' || !ID.test(data.id) || data.persisted !== true || data.productCount !== products.length ||
        !Number.isSafeInteger(data.imagesArchived) || data.imagesArchived < 0 || data.imagesArchived > imageCount ||
        !Array.isArray(data.imageFailures)) throw error('invalid_response');
      const expected = baseUrl + '/s/' + data.id;
      if (data.url !== expected || (writerToken && data.url.indexOf(writerToken) !== -1)) throw error('invalid_response');
      const seen = new Set();
      const failures = data.imageFailures.map(failure => {
        if (!failure || typeof failure !== 'object' || Array.isArray(failure) || !Number.isSafeInteger(failure.index) || failure.index < 0 || failure.index >= products.length ||
          !products[failure.index].model.trim() || seen.has(failure.index) || typeof failure.message !== 'string' || failure.message.length > 300 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(failure.message) || TOKEN_IN_TEXT.test(failure.message)) throw error('invalid_response');
        seen.add(failure.index);
        return { index: failure.index, message: failure.message };
      });
      if (data.imagesArchived + failures.length !== imageCount) throw error('invalid_response');
      return { url: expected, id: data.id, persisted: true, imagesArchived: data.imagesArchived, imageFailures: failures, productCount: data.productCount };
    }

    function publish(products, publishOptions = {}) {
      let saved, id;
      try { saved = snapshotProducts(products); id = requestId(); }
      catch (failure) { return Promise.reject(failure); }
      publishOptions = publishOptions || {};
      const signal = publishOptions.signal;
      if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) return Promise.reject(error('invalid_products'));
      const current = () => {
        if (signal && signal.aborted) throw error('aborted');
        try { if (publishOptions.isCurrent && !publishOptions.isCurrent()) throw error('stale'); }
        catch (failure) { if (failure && failure.code === 'stale') throw failure; throw error('stale'); }
      };
      return withDeadline(async operationSignal => {
        current();
        let capability = await token(); current();
        const body = { v: 1, products: saved, requestId: id };
        let data;
        try { data = await request('/api/shares', body, capability, operationSignal); }
        catch (failure) {
          current();
          if (!failure || failure.code !== 'unauthorized') throw failure;
          forget(capability);
          capability = await token(); current();
          try { data = await request('/api/shares', body, capability, operationSignal); }
          catch (renewedFailure) {
            if (renewedFailure && renewedFailure.code === 'unauthorized') forget(capability);
            throw renewedFailure;
          }
        }
        current();
        return result(data, saved);
      }, signal);
    }

    return { publish };
  }

  const api = { create };
  root.BuyerPersistentShareClient = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
