(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BuyerShareTransport = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_TOKEN_LENGTH = 2000000;
  const MAX_INPUT_LENGTH = MAX_TOKEN_LENGTH * 3 + 4096;
  const WRAPPING = /[\s\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

  function problem(code) {
    const message = {
      incomplete: '分享链接不完整，请从原消息复制完整链接或分享码',
      invalid: '无法识别分享链接，请粘贴完整链接或分享码',
      too_large: '分享数据过大，请让分享者分批分享'
    }[code];
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function normalize(value) {
    let text = String(value);
    if (text.length > MAX_INPUT_LENGTH) throw problem('too_large');
    // A forwarded link can encode the characters or the already encoded value.
    // Share codes have no percent signs in their canonical form.
    for (let pass = 0; pass < 2 && text.includes('%'); pass++) {
      try { text = decodeURIComponent(text); }
      catch (error) { throw problem('invalid'); }
    }
    return text.replace(WRAPPING, '');
  }

  function requireComplete(value, length) {
    if (value.length < length || /(?:\.{3}|…)$/.test(value)) throw problem('incomplete');
    if (value.length > MAX_TOKEN_LENGTH) throw problem('too_large');
  }

  function payload(value) {
    const token = normalize(value);
    requireComplete(token, 2);
    const compact = token.charAt(0) === 'c';
    if (!(compact ? /^c[A-Za-z0-9_-]+$/ : /^[jz][A-Za-z0-9+/_-]+={0,2}$/).test(token)) {
      throw problem('invalid');
    }
    const body = token.slice(1);
    if ((compact && body.length < 7) || body.replace(/=+$/, '').length % 4 === 1) {
      throw problem('incomplete');
    }
    if (body.includes('=') && body.length % 4 !== 0) throw problem('invalid');
    return { kind: 'payload', value: token };
  }

  function archive(value) {
    const key = normalize(value);
    requireComplete(key, 22);
    if (!/^[A-Za-z0-9_-]{22}$/.test(key)) throw problem('invalid');
    return { kind: 'archive', value: key };
  }

  function getParam(value, name) {
    let result = null;
    for (const part of value.split('&')) {
      const separator = part.indexOf('=');
      if (separator === -1 || part.slice(0, separator) !== name) continue;
      const data = part.slice(separator + 1);
      if (result !== null && result !== data) throw problem('invalid');
      result = data;
    }
    return result;
  }

  function readParts(search = '', hash = '') {
    if (search.length + hash.length > MAX_INPUT_LENGTH) throw problem('too_large');
    const query = search.replace(/^\?/, '');
    const fragment = hash.replace(/^#/, '');
    // Parse only explicit share parameters and preserve literal plus signs in legacy URLs.
    const fromQuery = getParam(query, 'd');
    if (fromQuery !== null) return payload(fromQuery);
    const legacyQuery = getParam(query, 'v');
    if (legacyQuery !== null && /^[cjz]/.test(legacyQuery)) return payload(legacyQuery);
    let fromFragment = getParam(fragment, 'd');
    if (fromFragment === null) fromFragment = getParam(fragment, 'v');
    if (fromFragment !== null) return payload(fromFragment);
    let key = getParam(query, 's');
    if (key === null) key = getParam(fragment, 's');
    if (key !== null) return archive(key);
    const naked = fragment.split(/[&?]/, 1)[0];
    if (/^[cjz][A-Za-z0-9+/_%.-]/.test(naked)) return payload(naked);
    if (legacyQuery !== null) return payload(legacyQuery);
    return { kind: 'missing' };
  }

  function read(input) {
    if (input && typeof input === 'object') return readParts(input.search, input.hash);
    if (typeof input !== 'string') return { kind: 'missing' };
    if (input.length > MAX_INPUT_LENGTH) throw problem('too_large');
    let text = input.trim().replace(WRAPPING, '');
    text = text.replace(/[。；，、]+$/, '');
    for (const pair of ['<>', '「」', '（）', '()']) {
      if (text.startsWith(pair[0]) && text.endsWith(pair[1])) { text = text.slice(1, -1); break; }
    }
    if (/^https?%3a%2f%2f/i.test(text)) {
      try { text = decodeURIComponent(text); } catch (error) { throw problem('invalid'); }
    }
    if (/^https?:\/\//i.test(text)) {
      let target;
      try { target = new URL(text); } catch (error) { throw problem('invalid'); }
      return readParts(target.search, target.hash);
    }
    if (text.startsWith('?')) {
      const hashAt = text.indexOf('#');
      return hashAt === -1 ? readParts(text) : readParts(text.slice(0, hashAt), text.slice(hashAt));
    }
    if (text.startsWith('#')) return readParts('', text);
    if (/^[cjz]/.test(text)) return payload(text);
    return { kind: 'missing' };
  }

  function url(pageHref, token) {
    const data = payload(token);
    const target = new URL('s.html', pageHref);
    if (target.protocol !== 'https:') throw problem('invalid');
    target.search = '?d=' + encodeURIComponent(data.value);
    target.hash = '';
    return target.href;
  }

  // Leave headroom below the host's request URL limit for forwarding parameters.
  function singleProductUrl(pageHref, products, encode, maxLength = 1800) {
    try {
      const link = url(pageHref, encode(products));
      return link.length <= maxLength ? link : '';
    } catch (error) {
      if (/^分享数据过大/.test(error.message)) return '';
      throw error;
    }
  }

  return { read, url, singleProductUrl };
});
