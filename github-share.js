(function (root) {
  'use strict';

  const VIEWER = 'https://joewu1024.github.io/---2/share.html';
  const PUBLISHER = 'http://127.0.0.1:43716';
  const PAIR_KEY = 'buyer-github-share-pair-v1';
  const KEY = /^[A-Za-z0-9_-]{22}$/;
  const PAIR = /^[A-Za-z0-9_-]{43}$/;
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

  let paired = '';
  function pairFromLocation() {
    if (root.location?.origin !== new URL(VIEWER).origin) return;
    const value = new URLSearchParams(String(root.location.hash || '').replace(/^#/, '')).get('publisher');
    if (PAIR.test(value || '')) {
      paired = value;
      try { root.localStorage.setItem(PAIR_KEY, value); } catch (error) {}
      const clean = new URL(root.location.href);
      clean.hash = '';
      root.history.replaceState(root.history.state, '', clean.href);
    }
  }

  function publisherPair() {
    if (root.location?.origin !== new URL(VIEWER).origin) return '';
    if (paired) return paired;
    try { const value = root.localStorage.getItem(PAIR_KEY); return PAIR.test(value || '') ? value : ''; }
    catch (error) { return ''; }
  }

  // Open synchronously from the existing share button so no browser network permission is needed.
  // The popup accepts one encrypted file from the workbench's exact origin.
  function begin() {
    const pair = publisherPair();
    if (!pair) return null;
    const popup = root.open(PUBLISHER + '/publish', '_blank', 'popup,width=420,height=220');
    if (!popup) throw new Error('请允许工作台打开生成链接的窗口');
    let ready = false, sent = false, message = null, done = false, assertCurrent;
    let timer, watch, resolveResult, rejectResult;
    const outcome = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    outcome.catch(() => {});
    function finish(error, value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(watch);
      root.removeEventListener('message', onMessage);
      try { popup.close(); } catch (error) {}
      if (error) rejectResult(error);
      else resolveResult(value);
    }
    function send() {
      if (ready && message && !sent && !done) {
        try { assertCurrent?.(); }
        catch (error) { finish(error); return; }
        sent = true;
        popup.postMessage(message, PUBLISHER);
      }
    }
    function onMessage(event) {
      if (event.origin !== PUBLISHER || event.source !== popup) return;
      const result = event.data;
      if (result?.type === 'buyer-share-publisher-ready') {
        ready = true;
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error('发布等待超时，请稍后重试')), 120000);
        send();
      } else if (sent && result?.type === 'buyer-share-published' && result.id === message.id) {
        finish(null, true);
      } else if (sent && result?.type === 'buyer-share-publish-error') {
        finish(new Error(result.message || '分享发布失败，请稍后重试'));
      }
    }
    root.addEventListener('message', onMessage);
    timer = setTimeout(() => finish(new Error('本机分享发布服务暂不可用')), 5000);
    watch = setInterval(() => {
      if (popup.closed) finish(new Error('分享发布窗口已关闭'));
    }, 500);
    return {
      async publish(payload, checkCurrent) {
        assertCurrent = checkCurrent;
        const archived = await seal(payload);
        if (!done) {
          message = { type: 'buyer-share-publish', pair, id: archived.id, content: archived.content };
          send();
        }
        await outcome;
        return VIEWER + '#s=' + archived.key;
      },
      close() { finish(new Error('已取消生成链接')); }
    };
  }

  const api = { seal, open, begin, pairFromLocation };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BuyerGithubShare = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
