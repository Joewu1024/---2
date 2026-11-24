(function (root) {
  'use strict';

  const VIEWER = 'https://joewu1024.github.io/---2/s.html';
  const MAX_TOKEN_LENGTH = 2000000;
  const MAX_CONTENT_LENGTH = 2666704;
  const KEY = /^[A-Za-z0-9_-]{22}$/;
  const TOKEN = /^[cjz][A-Za-z0-9_-]+$/;
  const CONTENT = /^[A-Za-z0-9_-]+$/;
  const TIMEOUT_MS = 20000;

  function failure(message, retryable) {
    const error = new Error(message);
    error.retryable = !!retryable;
    return error;
  }

  function serviceOrigin(value) {
    let url;
    try { url = new URL(value); } catch (error) {}
    if (!url || url.protocol !== 'https:' || !/^[a-z0-9-]+\.netlify\.app$/.test(url.hostname) ||
        url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
      throw failure('分享服务尚未配置，请联系工作台管理员');
    }
    return url.origin;
  }

  function viewerAddress(value) {
    let url;
    try { url = new URL('s.html', value || VIEWER); } catch (error) {}
    if (!url || url.origin !== 'https://joewu1024.github.io' || url.pathname !== '/---2/s.html' ||
        url.username || url.password) {
      throw failure('分享页面地址配置无效');
    }
    url.search = '';
    url.hash = '';
    return url;
  }

  function checkToken(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) throw failure('分享内容格式无效');
    if (token.length > MAX_TOKEN_LENGTH) throw failure('分享内容过大，请联系工作台管理员');
  }

  function base64Url(bytes) {
    const chunks = [];
    for (let at = 0; at < bytes.length; at += 8192) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(at, at + 8192)));
    }
    return btoa(chunks.join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(value) {
    if (!CONTENT.test(value) || value.length % 4 === 1) throw failure('分享数据无法读取');
    let padded = value.replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4) padded += '=';
    let binary;
    try { binary = atob(padded); } catch (error) { throw failure('分享数据无法读取'); }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (base64Url(bytes) !== value) throw failure('分享数据无法读取');
    return bytes;
  }

  function cryptoApi(options) {
    const api = options.crypto || root.crypto;
    if (!api || !api.subtle || typeof api.getRandomValues !== 'function') {
      throw failure('当前浏览器无法安全读取分享，请使用新版浏览器');
    }
    return api;
  }

  async function identifier(bytes, cryptoImpl) {
    const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function assertCurrent(options) {
    if (options.isCurrent && options.isCurrent() === false) {
      throw failure('分享内容或工作区已变更，请重新生成');
    }
  }

  async function sealedToken(token, cryptoImpl) {
    const bytes = new Uint8Array(token.length);
    for (let i = 0; i < token.length; i++) bytes[i] = token.charCodeAt(i);
    const secret = cryptoImpl.getRandomValues(new Uint8Array(16));
    const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
    const key = await cryptoImpl.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt']);
    const encrypted = new Uint8Array(await cryptoImpl.subtle.encrypt({name:'AES-GCM', iv}, key, bytes));
    const combined = new Uint8Array(iv.length + encrypted.length);
    combined.set(iv);
    combined.set(encrypted, iv.length);
    return {
      key: base64Url(secret),
      id: await identifier(secret, cryptoImpl),
      content: base64Url(combined)
    };
  }

  function responseError(status) {
    if (status === 404) return failure('没有找到这份分享，请检查链接是否完整');
    if (status === 413) return failure('分享内容过大，请联系工作台管理员');
    if (status === 429) return failure('分享服务繁忙，请稍后重试', true);
    return failure('分享服务暂时不可用，请稍后重试', status >= 500);
  }

  async function request(origin, route, options, init, consume) {
    const fetchImpl = options.fetchImpl || root.fetch;
    if (typeof fetchImpl !== 'function') throw failure('当前浏览器无法连接分享服务');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer;
    const timedOut = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (controller) controller.abort();
        reject(failure('分享服务连接超时，请稍后重试', true));
      }, TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(origin + route, {
            ...init, cache:'no-store', credentials:'omit', redirect:'error', referrerPolicy:'no-referrer',
            signal: controller ? controller.signal : undefined
          });
          if (!response.ok) throw responseError(response.status);
          return consume(response);
        })(),
        timedOut
      ]);
    } catch (error) {
      if (error && typeof error.retryable === 'boolean') throw error;
      throw failure('分享服务暂时连接失败，请检查网络后重试', true);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readContent(origin, id, options) {
    return request(origin, '/api/shares/' + id, options, {method:'GET'}, async response => {
      const content = await response.text();
      if (content.length < 38 || content.length > MAX_CONTENT_LENGTH || !CONTENT.test(content)) {
        throw failure('分享数据无法读取');
      }
      return content;
    });
  }

  async function decrypt(content, secret, cryptoImpl) {
    try {
      const combined = fromBase64Url(content);
      if (combined.length < 30) throw failure('分享数据无法读取');
      const key = await cryptoImpl.subtle.importKey('raw', secret, 'AES-GCM', false, ['decrypt']);
      const decrypted = new Uint8Array(await cryptoImpl.subtle.decrypt(
        {name:'AES-GCM', iv:combined.subarray(0, 12)}, key, combined.subarray(12)
      ));
      if (decrypted.length > MAX_TOKEN_LENGTH) throw failure('分享数据无法读取');
      const chunks = [];
      for (let at = 0; at < decrypted.length; at += 8192) {
        chunks.push(String.fromCharCode.apply(null, decrypted.subarray(at, at + 8192)));
      }
      const token = chunks.join('');
      checkToken(token);
      return token;
    } catch (error) {
      throw failure('分享内容校验失败，请检查链接是否完整');
    }
  }

  async function create(token, options = {}) {
    checkToken(token);
    const origin = serviceOrigin(options.serviceUrl);
    const viewer = viewerAddress(options.viewerUrl);
    const cryptoImpl = cryptoApi(options);
    assertCurrent(options);
    const archived = await sealedToken(token, cryptoImpl);
    assertCurrent(options);
    const body = JSON.stringify({id:archived.id, content:archived.content});
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        assertCurrent(options);
        const saved = await request(origin, '/api/shares', options, {
          method:'POST', headers:{'Content-Type':'application/json'}, body
        }, response => response.json());
        assertCurrent(options);
        if (!saved || saved.id !== archived.id) throw failure('分享保存未完成，请重试');
        const content = await readContent(origin, archived.id, options);
        assertCurrent(options);
        if (content !== archived.content) throw failure('分享保存校验失败，请重试');
        const restored = await decrypt(content, fromBase64Url(archived.key), cryptoImpl);
        assertCurrent(options);
        if (restored !== token) throw failure('分享保存校验失败，请重试');
        viewer.searchParams.set('n', archived.key);
        return viewer.href;
      } catch (error) {
        assertCurrent(options);
        if (attempt || !error.retryable) throw error;
      }
    }
  }

  async function open(keyString, options = {}) {
    const origin = serviceOrigin(options.serviceUrl);
    if (typeof keyString !== 'string' || !KEY.test(keyString)) throw failure('分享网址不完整，请复制完整链接');
    const cryptoImpl = cryptoApi(options);
    const secret = fromBase64Url(keyString);
    const id = await identifier(secret, cryptoImpl);
    const content = await readContent(origin, id, options);
    return decrypt(content, secret, cryptoImpl);
  }

  const api = {create, open};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BuyerOnlineShare = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
