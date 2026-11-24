(function (root) {
  'use strict';

  const VIEWER = 'https://joewu1024.github.io/---2/share.html';
  const KEY = /^[A-Za-z0-9_-]{22}$/;
  const PAYLOAD = /^[jz][A-Za-z0-9_-]+$/;
  const MAX_PAYLOAD = 1800000;
  const encoder = () => new TextEncoder();

  function base64Url(bytes) {
    let binary = '';
    for (let at = 0; at < bytes.length; at += 16384) {
      binary += String.fromCharCode(...bytes.subarray(at, at + 16384));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(value) {
    const encoded = value.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  }

  async function archiveKey(keyBytes, cryptoImpl) {
    const digest = await cryptoImpl.subtle.digest('SHA-256', keyBytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function importShareKey(keyBytes, usage, cryptoImpl) {
    return cryptoImpl.subtle.importKey('raw', keyBytes, 'AES-GCM', false, [usage]);
  }

  async function seal(payload, cryptoImpl = root.crypto) {
    if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD || !PAYLOAD.test(payload)) {
      throw new Error('分享内容过大或格式无效，请减少产品数量后重试');
    }
    if (!cryptoImpl?.subtle) throw new Error('当前浏览器无法加密分享，请使用新版浏览器');
    const keyBytes = cryptoImpl.getRandomValues(new Uint8Array(16));
    const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
    const key = await importShareKey(keyBytes, 'encrypt', cryptoImpl);
    const ciphertext = await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder().encode(payload));
    const sealed = new Uint8Array(iv.length + ciphertext.byteLength);
    sealed.set(iv);
    sealed.set(new Uint8Array(ciphertext), iv.length);
    return { key: base64Url(keyBytes), id: await archiveKey(keyBytes, cryptoImpl), content: base64Url(sealed) };
  }

  function readerError(message) {
    return new Error(message || '暂时无法读取分享，请稍后重新打开');
  }

  async function open(keyString, options = {}) {
    const cryptoImpl = options.crypto || root.crypto;
    if (!KEY.test(keyString)) throw readerError('分享网址不完整，请复制完整链接');
    if (!cryptoImpl?.subtle) throw readerError('请在手机或电脑的浏览器中打开此链接');
    const keyBytes = fromBase64Url(keyString);
    const id = await archiveKey(keyBytes, cryptoImpl);
    const file = new URL('p/data/' + id + '.txt', VIEWER);
    const fetchImpl = options.fetchImpl || root.fetch;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = setTimeout(() => controller?.abort(), 12000);
    try {
      const result = await fetchImpl(file.href, {
        cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        signal: controller?.signal
      });
      if (!result.ok) {
        if (result.status === 404) throw readerError('没有找到这份分享，请检查链接是否复制完整');
        throw readerError();
      }
      const content = (await result.text()).trim();
      if (content.length > 2400080 || !/^[A-Za-z0-9_-]+$/.test(content)) throw readerError('分享数据无法读取');
      const sealed = fromBase64Url(content);
      const key = await importShareKey(keyBytes, 'decrypt', cryptoImpl);
      const plaintext = await cryptoImpl.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12) }, key, sealed.subarray(12));
      const payload = new TextDecoder().decode(plaintext);
      if (!PAYLOAD.test(payload) || payload.length > MAX_PAYLOAD) throw readerError('分享数据无法读取');
      return payload;
    } catch (error) {
      throw readerError(error?.name === 'Error' ? error.message : undefined);
    } finally {
      clearTimeout(timeout);
    }
  }

  const api = { seal, open };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BuyerGithubShare = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
