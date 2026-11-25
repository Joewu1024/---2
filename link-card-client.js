(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.BuyerLinkCard = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const ORIGIN = 'https://link-card-maker.app.workbuddy.host';
  const SHARECODE = '26URNVPWDI';
  const ENDPOINT = ORIGIN + '/api/make?sharecode=' + SHARECODE;
  const DESCRIPTION = '寻品产品信息 · 点击查看详情 · 可截图或保存 PDF';

  function readUrl(value) {
    if (typeof value !== 'string' || !value || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) return null;
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed : null;
    } catch (_) { return null; }
  }

  function checkedResult(data, originalUrl) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('外链工具返回内容无效，请重新生成');
    const parsed = readUrl(data.shortUrl);
    if (!parsed || parsed.origin !== ORIGIN || !/^\/c\/[A-Za-z0-9_-]{1,128}$/.test(parsed.pathname) ||
        data.shortUrl.includes('#') || parsed.searchParams.getAll('sharecode').length !== 1 ||
        parsed.searchParams.get('sharecode') !== SHARECODE) throw new Error('外链工具返回链接无效，请重新生成');
    if (Object.prototype.hasOwnProperty.call(data, 'original') && data.original !== originalUrl) {
      throw new Error('外链工具返回的原始链接不一致，请重新生成');
    }
    return data.shortUrl;
  }

  async function generate(originalUrl, options) {
    options = options || {};
    if (!readUrl(originalUrl)) throw new Error('原始分享链接无效，请使用完整的 HTTPS 链接');
    const fetchRequest = typeof options.fetch === 'function' ? options.fetch :
      typeof root.fetch === 'function' ? root.fetch.bind(root) : null;
    if (!fetchRequest) throw new Error('当前浏览器无法连接外链工具');
    const countValue = Number(options.count), count = Number.isFinite(countValue) && countValue >= 1 ? Math.floor(countValue) : 1;
    const timeoutValue = Number(options.timeoutMs), timeoutMs = Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : 15000;
    const controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    const payload = {
      url: originalUrl,
      title: typeof options.title === 'string' && options.title.trim() ? options.title : '寻品产品分享 · ' + count + ' 个产品',
      desc: typeof options.desc === 'string' && options.desc.trim() ? options.desc : DESCRIPTION,
      origin: ORIGIN,
      sharecode: SHARECODE
    };
    let timer, timedOut = false;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller?.abort();
        reject(new Error('外链工具生成超时，请稍后重试'));
      }, timeoutMs);
    });
    const request = (async () => {
      let response;
      try {
        response = await fetchRequest(ENDPOINT, {
          method: 'POST',
          // The service accepts JSON text but does not implement OPTIONS.
          // text/plain keeps this a simple CORS request from the workbench.
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify(payload),
          mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
          ...(controller ? { signal: controller.signal } : {})
        });
      } catch (_) {
        throw new Error(timedOut ? '外链工具生成超时，请稍后重试' : '无法连接外链工具，请检查网络后重试');
      }
      if (!response || !response.ok) {
        if (response?.status === 429) throw new Error('外链工具暂时限流，请稍后重试');
        throw new Error('外链工具生成失败，请稍后重试');
      }
      let data;
      try { data = await response.json(); }
      catch (_) { throw new Error('外链工具返回内容无效，请重新生成'); }
      return checkedResult(data, originalUrl);
    })();
    try { return await Promise.race([request, timeout]); }
    finally { clearTimeout(timer); }
  }

  return { generate };
});
