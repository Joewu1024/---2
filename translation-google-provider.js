(function (root) {
  'use strict';

  const endpoint = 'https://translate.googleapis.com/translate_a/single';
  const hasChinese = value => /[\u3400-\u9fff]/.test(value);

  function qualityError(message) {
    return Object.assign(new Error(message || 'Google 未返回可核对的完整中文译文'), { qualityFailed: true, permanent: true });
  }

  function defaultValidate(source, result) {
    if (!root.BuyerTranslation || typeof root.BuyerTranslation.usable !== 'function') {
      throw new Error('翻译校验器尚未加载');
    }
    return root.BuyerTranslation.usable(source, result);
  }

  function retryDelay(response) {
    const value = response.headers && typeof response.headers.get === 'function' ? response.headers.get('Retry-After') : null;
    if (value == null || String(value).trim() === '') return 1000;
    const text = String(value).trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1000;
    const date = Date.parse(text);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1000;
  }

  function create(options = {}) {
    const fetchImpl = options.fetchImpl === undefined ? root.fetch : options.fetchImpl;
    const timeoutMs = options.timeoutMs === undefined ? 10000 : options.timeoutMs;
    const validate = options.validate === undefined ? defaultValidate : options.validate;
    if (typeof fetchImpl !== 'function') throw new Error('当前环境无法发送 Google 翻译请求');
    if (typeof validate !== 'function') throw new TypeError('validate 必须是函数');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new TypeError('timeoutMs 必须是有效的正毫秒数');

    async function request(source, language) {
      const url = new URL(endpoint);
      url.searchParams.set('client', 'gtx');
      url.searchParams.set('sl', language);
      url.searchParams.set('tl', 'zh-CN');
      url.searchParams.set('dt', 't');
      url.searchParams.set('q', source);
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error('Google 翻译请求超时'), { timeout: true }));
        }, timeoutMs);
      });
      const operation = async () => {
        const response = await fetchImpl(url.toString(), { signal: controller.signal });
        if (response && response.status === 429) {
          throw Object.assign(new Error('Google 翻译请求过于频繁，请稍后重试'), { rateLimited: true, retryAfter: retryDelay(response) });
        }
        // Real Fetch responses must be HTTP 200; accepting an omitted status also supports minimal fetch adapters.
        if (!response || (response.status !== 200 && !(response.status == null && response.ok === true))) {
          throw new Error('Google 翻译请求失败（HTTP ' + (response && response.status || '未知') + '）');
        }
        let data;
        try { data = await response.json(); }
        catch (error) { throw qualityError('Google 翻译响应不是有效 JSON'); }
        if (!Array.isArray(data) || !Array.isArray(data[0]) || !data[0].length ||
            data[0].some(segment => !Array.isArray(segment) || typeof segment[0] !== 'string')) {
          throw qualityError('Google 翻译响应缺少完整文本段');
        }
        return data[0].map(segment => segment[0]).join('').trim();
      };
      try { return await Promise.race([operation(), deadline]); }
      finally { clearTimeout(timer); }
    }

    function acceptable(source, result) {
      return !!result && hasChinese(result) && validate(source, result);
    }

    function hintLanguage(hint) {
      const value = String(hint || '').trim();
      return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value) && value.toLowerCase() !== 'auto' ? value : '';
    }

    async function translate(text, languageHint = 'auto', context = {}) {
      const source = String(text == null ? '' : text).trim();
      if (!source) return '';
      // Keep the same intact query for items and models. Context never rewrites Google's wording.
      const first = await request(source, 'auto');
      if (acceptable(source, first)) return first;
      const language = hintLanguage(languageHint);
      if (language) {
        const result = await request(source, language);
        if (acceptable(source, result)) return result;
      }
      throw qualityError('Google 未返回可核对的完整中文译文，请核对原文');
    }

    return { translate };
  }

  const api = { create };
  root.BuyerGoogleTranslation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
