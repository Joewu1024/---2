(function (root) {
  'use strict';

  const endpoint = 'https://translate.googleapis.com/translate_a/single';
  const hasChinese = value => /[\u3400-\u9fff]/.test(value);
  const genericWords = new Set(('NEW KIT BLACK WHITE BLUE RED GREEN SILVER GOLD YELLOW PINK PURPLE ORANGE BROWN GRAY GREY BEIGE ' +
    'TRANSPARENT CLEAR ORIGINAL MODEL MODELO COLOR COLOUR SIZE TYPE VERSION LARGE SMALL MEDIUM MINI MAX PRO PLUS LITE ' +
    'PRODUCT HOT SALE BEST COVER ADAPTER RECEIVER TRANSMITTER HUB TELEPHONE PHONE TELEVISION TABLET COMPUTER CAMERA ' +
    'WIRELESS BLUETOOTH USB USB-C HDMI AUX RCA XLR WIFI WI-FI FM AM AC DC TV LED LCD SMART UNIVERSAL ' +
    'REMOTE CONTROL CONTROLE REMOTO SPEAKER HEADPHONES EARPHONES MICROPHONE CHARGER CHARGING CASE CABLE ' +
    'PORTABLE BATTERY RECHARGEABLE REPLACEMENT COMPLETE PACK SET PIECES WITH WITHOUT FOR AND THE ' +
    'PRETO PRETA BRANCO BRANCA AZUL VERMELHO VERDE COMPLETO COMPLETA COM PARA SEM FONTE CABO CABOS ' +
    'HITAM PUTIH BIRU MERAH UNTUK DENGAN TANPA').split(' '));

  function qualityError(message) {
    return Object.assign(new Error(message || 'Google 未返回可核对的完整中文译文'), { qualityFailed: true, permanent: true });
  }

  function defaultValidate(source, result) {
    if (!root.BuyerTranslation || typeof root.BuyerTranslation.usable !== 'function') {
      throw new Error('翻译校验器尚未加载');
    }
    return root.BuyerTranslation.usable(source, result);
  }

  function brandOccurrences(source, brand) {
    if (!brand) return [];
    const positions = [], lower = source.toLowerCase(), needle = brand.toLowerCase();
    let from = 0, position;
    while ((position = lower.indexOf(needle, from)) !== -1) {
      const end = position + brand.length;
      const leftOK = !/^[a-z0-9]/i.test(brand) || !/[a-z0-9]/i.test(source[position - 1] || '');
      const rightOK = !/[a-z0-9]$/i.test(brand) || !/[a-z0-9]/i.test(source[end] || '');
      if (leftOK && rightOK) positions.push({ start: position, end, text: source.slice(position, end) });
      from = end;
    }
    return positions;
  }

  function modelBrand(source, explicitBrand) {
    const explicit = brandOccurrences(source, explicitBrand).find(match => match.start === 0);
    if (explicit) return explicit;
    const match = source.match(/^([A-Z]{2,}(?:[&.'-][A-Z]+)*)(?=$|[\s:：,，;；/\\–—-])/);
    if (!match || genericWords.has(match[1])) return null;
    return { start: 0, end: match[1].length, text: match[1] };
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

    async function validated(source, hint, assemble = value => value, original = source) {
      let result = assemble(await request(source, 'auto'));
      if (acceptable(original, result)) return result;
      const language = hintLanguage(hint);
      if (language) {
        result = assemble(await request(source, language));
        if (acceptable(original, result)) return result;
      }
      throw qualityError('Google 未返回可核对的完整中文译文，请核对原文');
    }

    async function restoreBrand(source, occurrences, hint) {
      let cursor = 0, result = '';
      async function fragment(value) {
        const parts = value.match(/^(\s*)([\s\S]*?)(\s*)$/);
        const text = parts[2];
        if (!text || /^[\s\p{P}\p{S}\d]+$/u.test(text)) return value;
        const engine = root.BuyerTranslation;
        if (engine && typeof engine.passthrough === 'function' && engine.passthrough(text)) return value;
        return parts[1] + await validated(text, hint) + parts[3];
      }
      for (const brand of occurrences) {
        result += await fragment(source.slice(cursor, brand.start));
        result += brand.text;
        cursor = brand.end;
      }
      result += await fragment(source.slice(cursor));
      if (!acceptable(source, result)) throw qualityError('品牌保留后仍未获得完整中文译文，请核对原文');
      return result;
    }

    async function translate(text, languageHint = 'auto', context = {}) {
      const source = String(text == null ? '' : text).trim();
      if (!source) return '';
      context = context || {};
      const brand = String(context.brand == null ? '' : context.brand).trim();
      if (context.kind === 'model') {
        const prefix = modelBrand(source, brand);
        if (prefix) {
          const rest = source.slice(prefix.end).match(/^([\s:：,，;；/\\–—-]*)([\s\S]*)$/);
          if (!rest[2]) {
            if (validate(source, source)) return source;
            throw qualityError('型号缺少可翻译的描述，请核对原文');
          }
          return validated(rest[2], languageHint, value => prefix.text + rest[1] + value, source);
        }
      }
      const occurrences = brandOccurrences(source, brand);
      const first = await request(source, 'auto');
      const brandMissing = occurrences.length && occurrences.some(match => !first.includes(match.text));
      if (brandMissing && hasChinese(first)) return restoreBrand(source, occurrences, languageHint);
      if (acceptable(source, first)) return first;
      const language = hintLanguage(languageHint);
      if (language) {
        const result = await request(source, language);
        if (occurrences.length && occurrences.some(match => !result.includes(match.text)) && hasChinese(result)) {
          return restoreBrand(source, occurrences, languageHint);
        }
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
