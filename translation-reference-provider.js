(function (root) {
  'use strict';

  const endpoint = 'https://transmart.qq.com/api/imt';
  const marker = /ZXQ\s*\d+\s*QXZ/i;
  const hasChinese = value => /[\u3400-\u9fff]/.test(value);
  const ordinaryPrefixes = new Set(('KIT NEW BLACK WHITE BLUE RED GREEN SILVER GOLD PURPLE PINK YELLOW BROWN ORANGE GREY GRAY ' +
    'BEIGE CLEAR TRANSPARENT ORIGINAL MODEL COLOR COLOUR SIZE TYPE VERSION LARGE SMALL MEDIUM MINI MAX PRO PLUS LITE ' +
    'WIRELESS BLUETOOTH USB HDMI WIFI SMART UNIVERSAL REMOTE CONTROL SPEAKER HEADPHONES EARPHONES MICROPHONE CHARGER ' +
    'CHARGING CASE CABLE PORTABLE BATTERY RECHARGEABLE REPLACEMENT COMPLETE PACK SET PIECES WITH WITHOUT FOR AND THE ' +
    'HOT SALE BEST PRODUCT COVER ADAPTER RECEIVER TRANSMITTER HUB PHONE TELEVISION TABLET COMPUTER CAMERA LCD LED ' +
    'SELF SERVICE CALL SYSTEM DIGITAL ELECTRIC FAN CEILING SWITCH POWER WARRANTY PRETO BRANCO AZUL VERDE NOVO NOVA ' +
    'CONTROLE REMOTO FONTE CABO CABOS COM PARA SEM QUAT TRAN MAU TRANG DEN XANH GOI KHONG DAY NO BRAND NOBRAND UNBRANDED GENERIC NONE OEM').split(' '));

  function findBrand(source, brand) {
    const lower = source.toLowerCase(), needle = brand.toLowerCase();
    let from = 0, start;
    while ((start = lower.indexOf(needle, from)) !== -1) {
      const end = start + brand.length;
      const leftOK = !/^[a-z0-9]/i.test(brand) || !/[a-z0-9]/i.test(source[start - 1] || '');
      const rightOK = !/[a-z0-9]$/i.test(brand) || !/[a-z0-9]/i.test(source[end] || '');
      if (leftOK && rightOK) return { start, end, text: source.slice(start, end) };
      from = end;
    }
    return null;
  }

  function sourceBrand(source, context) {
    const brand = String(context && context.brand || '').trim();
    if (brand && !/^(?:no[ -]?brand|unbranded|generic|none|null|n\/?a|无品牌|其他|oem)$/i.test(brand)) {
      const explicit = findBrand(source, brand);
      if (explicit) return explicit;
    }
    if (!context || context.kind !== 'model') return null;
    // Infer only an independent Latin uppercase prefix; words such as Vietnamese "Bộ" are descriptions.
    const match = source.match(/^([A-Z]{2,30})(?=$|[\s:：,，;；])/);
    if (!match || ordinaryPrefixes.has(match[1])) return null;
    return { start: 0, end: match[1].length, text: match[1] };
  }

  function containsBrand(result, brand) {
    const name = brand.normalize('NFKC').toUpperCase();
    const parts = name.split(/[\s\p{P}\p{S}]+/u).filter(Boolean);
    if (!parts.length) return true;
    const escaped = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\p{P}\\p{S}]*');
    const left = /^[A-Z0-9]/.test(parts[0]) ? '(?:^|[^A-Z0-9])' : '';
    const right = /[A-Z0-9]$/.test(parts[parts.length - 1]) ? '(?:$|[^A-Z0-9])' : '';
    return new RegExp(left + escaped + right, 'u').test(result.normalize('NFKC').toUpperCase());
  }

  function parametersPreserved(source, result) {
    if (root.BuyerTranslation && typeof root.BuyerTranslation.reviewWarnings === 'function') {
      return !root.BuyerTranslation.reviewWarnings(source, result).some(warning => /^译文可能缺少(?:数字|型号)/.test(warning));
    }
    const packed = value => value.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const models = source.match(/\b[A-Z]{1,8}[-]?\d+[A-Z0-9-]*\b/g) || [];
    if (models.some(model => !packed(result).includes(packed(model)))) return false;
    const numeric = value => new Set((value.match(/(?<![A-Za-z0-9])\d+(?:[.,]\d+)*/g) || []).map(token => token.replace(',', '.')));
    const output = numeric(result);
    return [...numeric(source)].every(number => output.has(number));
  }

  function qualityError(message) {
    return Object.assign(new Error(message || '参考翻译服务未完整返回译文'), { qualityFailed: true, split: true });
  }

  function uuid() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (root.crypto && typeof root.crypto.getRandomValues === 'function') root.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0'));
    return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' + hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' + hex.slice(10).join('');
  }

  function clientKey() {
    const navigator = root.navigator || {}, ua = String(navigator.userAgent || '');
    const browsers = [['edge', /Edg\/([\d.]+)/], ['firefox', /Firefox\/([\d.]+)/], ['chrome', /(?:Chrome|CriOS)\/([\d.]+)/], ['safari', /Version\/([\d.]+).*Safari/]];
    const browser = browsers.map(([name, pattern]) => { const match = ua.match(pattern); return match ? [name, match[1]] : null; }).find(Boolean) || ['unknown', '0'];
    const windows = ua.match(/Windows NT ([\d.]+)/);
    const mac = ua.match(/Mac OS X ([\d_]+)/);
    const platform = windows ? 'Windows ' + (windows[1] === '10.0' ? '10' : windows[1]) :
      mac ? 'Mac OS X ' + mac[1].replace(/_/g, '.') : String(navigator.userAgentData && navigator.userAgentData.platform || navigator.platform || 'unknown');
    return 'browser-' + browser[0] + '-' + browser[1] + '-' + platform + '-' + uuid() + '-' + Date.now();
  }

  function retryDelay(response) {
    const value = response.headers && typeof response.headers.get === 'function' ? response.headers.get('Retry-After') : null;
    if (value == null || String(value).trim() === '') return 1500;
    const text = String(value).trim(), seconds = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000 : NaN;
    if (Number.isFinite(seconds)) return seconds;
    const date = Date.parse(text);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1500;
  }

  function languageCode(value, fallback) {
    const text = String(value == null ? fallback : value).trim();
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(text) && text !== 'auto') throw new TypeError('翻译语种代码无效');
    return /^zh(?:-|$)/i.test(text) ? 'zh' : text.toLowerCase();
  }

  function passthrough(source, result) {
    if (source !== result) return false;
    if (root.BuyerTranslation && typeof root.BuyerTranslation.passthrough === 'function') return root.BuyerTranslation.passthrough(source);
    return /^[\u3400-\u9fff\d\s\p{P}\p{S}]+$/u.test(source) ||
      /^(?=.*\d)[A-Z0-9\s\p{P}\p{S}]+$/u.test(source) || /^(?:USB(?:-C)?|AUX|RCA|HDMI|XLR|FM|AM|AC|DC)$/.test(source);
  }

  function create(options = {}) {
    const fetchImpl = options.fetchImpl === undefined ? root.fetch : options.fetchImpl;
    const timeoutMs = options.timeoutMs === undefined ? 20000 : options.timeoutMs;
    if (typeof fetchImpl !== 'function') throw new TypeError('当前环境无法发送参考翻译请求');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new TypeError('timeoutMs 必须是有效的正毫秒数');

    async function request(texts, sourceLanguage, targetLanguage) {
      const payload = {
        header: { fn: 'auto_translation', client_key: clientKey() },
        type: 'plain', model_category: 'normal',
        source: { lang: sourceLanguage, text_list: texts },
        target: { lang: targetLanguage }
      };
      const controller = new AbortController();
      let timer;
      const timeoutError = () => Object.assign(new Error('参考翻译请求超时，请稍后重试'), { timeout: true, pause: true });
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => { reject(timeoutError()); controller.abort(); }, timeoutMs);
      });
      const operation = async () => {
        let response;
        try {
          response = await fetchImpl(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload), signal: controller.signal, credentials: 'omit'
          });
        } catch (error) {
          if (controller.signal.aborted) throw timeoutError();
          throw Object.assign(new Error('参考翻译服务连接失败，请稍后重试'), { pause: true, cause: error });
        }
        if (response && response.status === 429) {
          throw Object.assign(new Error('参考翻译服务限流，请稍后重试'), { rateLimited: true, retryAfter: retryDelay(response), pause: true });
        }
        if (!response || (response.status !== 200 && !(response.status == null && response.ok === true))) {
          throw Object.assign(new Error('参考翻译服务连接失败（HTTP ' + (response && response.status || '未知') + '）'), { pause: true });
        }
        let data;
        try { data = await response.json(); }
        catch (error) { if (controller.signal.aborted) throw timeoutError(); throw qualityError('参考翻译响应不是有效 JSON'); }
        if (!data || !data.header || data.header.ret_code !== 'succ') {
          const detail = String(data && (data.message || data.msg || data.header && (data.header.ret_msg || data.header.message)) || '');
          const unsupported = /unsupported[-_ ]?language|engine|not supported|不支持|语种|引擎/i.test(detail);
          const error = Object.assign(new Error(unsupported ? '参考翻译服务暂不支持该语种通道' : '参考翻译服务暂不可用，请稍后重试'), { pause: true, providerError: true });
          if (unsupported) Object.assign(error, { unsupportedLanguage: true, permanent: true });
          throw error;
        }
        const result = data.auto_translation;
        if (!Array.isArray(result) || result.length !== texts.length || result.some(value => typeof value !== 'string')) {
          throw qualityError('参考翻译返回条数或文本格式不一致');
        }
        return result.map(value => value.trim());
      };
      try { return await Promise.race([operation(), deadline]); }
      finally { clearTimeout(timer); }
    }

    function usable(source, result, target) {
      if (!result || /\uFFFD/.test(result) || marker.test(result)) return false;
      return target !== 'zh' || hasChinese(result) || passthrough(source, result);
    }

    async function translatePart(texts, source, target) {
      let result;
      try { result = await request(texts, source, target); }
      catch (error) {
        if (!error.qualityFailed) throw error;
        if (texts.length === 1) return [''];
        const middle = Math.ceil(texts.length / 2);
        return [...await translatePart(texts.slice(0, middle), source, target), ...await translatePart(texts.slice(middle), source, target)];
      }
      for (let i = 0; i < result.length; i++) {
        if (usable(texts[i], result[i], target)) continue;
        // Preserve good neighboring results; retry only the affected title once as an unmarked single item.
        result[i] = texts.length > 1 ? (await translatePart([texts[i]], source, target))[0] : '';
      }
      return result;
    }

    async function translateStage(texts, source, target) {
      const result = texts.map(() => ''), indices = [];
      for (let i = 0; i < texts.length; i++) if (texts[i]) indices.push(i);
      if (!indices.length) return result;
      const values = await translatePart(indices.map(index => texts[index]), source, target);
      indices.forEach((index, i) => { result[index] = values[i]; });
      return result;
    }

    async function translateValues(values, source, target) {
      const pivot = target === 'zh' && (source === 'th' || source === 'ms');
      const intermediate = pivot ? await translateStage(values, source, 'en') : values;
      return translateStage(intermediate, pivot ? 'en' : source, target);
    }

    async function restoreBrand(sourceText, brand, source, target) {
      const before = sourceText.slice(0, brand.start);
      // Prefix brands can be removed without splitting a sentence or changing a compatibility relation.
      if (!/^[\s\p{P}\p{S}]*$/u.test(before)) return '';
      const rest = sourceText.slice(brand.end).match(/^([\s\p{P}\p{S}]*)([\s\S]*)$/u);
      if (!rest[2]) return before + brand.text + rest[1];
      const description = (await translateValues([rest[2]], source, target))[0];
      if (!description) return '';
      const result = before + brand.text + rest[1] + description;
      return containsBrand(result, brand.text) && parametersPreserved(sourceText, result) ? result : '';
    }

    async function translateBatch(texts, language = 'auto', options = {}) {
      if (!Array.isArray(texts)) throw new TypeError('texts 必须是字符串数组');
      const values = texts.map(text => String(text == null ? '' : text).trim());
      const source = languageCode(language, 'auto'), target = languageCode(options && options.targetLanguage, 'zh');
      if (!values.some(Boolean)) return values;
      const contexts = options && Array.isArray(options.contexts) ? options.contexts : [];
      const result = await translateValues(values, source, target);
      let brandFailed = false;
      for (let i = 0; i < result.length; i++) {
        if (!result[i]) continue;
        const brand = sourceBrand(values[i], contexts[i]);
        if (!brand || containsBrand(result[i], brand.text)) continue;
        result[i] = await restoreBrand(values[i], brand, source, target);
        if (!result[i]) brandFailed = true;
      }
      if (result.every((text, i) => !values[i] || !text)) {
        throw Object.assign(qualityError(brandFailed ? '参考译文未能可靠保留品牌和参数，请核对原文' : '参考翻译服务未返回可用译文，请稍后重试'), { permanent: true, brandIntegrityFailed: brandFailed });
      }
      return result;
    }

    return { translateBatch };
  }

  const api = { create };
  root.BuyerReferenceTranslation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
