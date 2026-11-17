(function (root) {
  'use strict';

  // Native API contract: https://developer.chrome.com/docs/ai/translator-api
  // AbortSignal/destroy contract: https://webmachinelearning.github.io/translation-api/
  // No network fallback is performed here. Model creation must be requested from a user click.
  const states = new Set(['available', 'downloadable', 'downloading', 'unavailable']);

  function failure(message, flags = {}, name = 'Error') {
    return Object.assign(new Error(message), flags, { name });
  }

  function cancelled() {
    return failure('Chrome 本地翻译已取消', { cancelled: true }, 'AbortError');
  }

  function language(value) {
    const tag = String(value || '').trim();
    if (!tag || tag.toLowerCase() === 'auto') {
      throw failure('Chrome 本地翻译需要明确的原文语言，请先选择语言', { languageHintRequired: true, permanent: true });
    }
    let canonical;
    try { canonical = Intl.getCanonicalLocales(tag)[0]; }
    catch (error) { throw failure('无法识别的语言代码：' + tag, { unsupported: true, permanent: true }); }
    const parts = canonical.split('-');
    if (parts[0] === 'zh') {
      return parts.includes('Hant') || (!parts.includes('Hans') && parts.some(part => ['TW', 'HK', 'MO'].includes(part))) ? 'zh-Hant' : 'zh';
    }
    return parts[0];
  }

  function duration(value, fallback) {
    value = value === undefined ? fallback : value;
    if (!Number.isFinite(value) || value <= 0 || value > 2147483647) throw new TypeError('timeoutMs 必须是有效的正毫秒数');
    return value;
  }

  function create(options = {}) {
    const TranslatorImpl = options.TranslatorImpl === undefined ? root.Translator : options.TranslatorImpl;
    const timeoutMs = duration(options.timeoutMs, 30000);
    const prepareTimeoutMs = duration(options.prepareTimeoutMs, 180000);
    const pairs = new Map();
    const availability = new Map();
    const lifetime = new AbortController();
    let destroyed = false;
    const supportedAPI = () => !!TranslatorImpl && typeof TranslatorImpl.create === 'function' && typeof TranslatorImpl.availability === 'function';

    function pair(sourceLanguage, targetLanguage = 'zh') {
      const source = language(sourceLanguage), target = language(targetLanguage);
      return { sourceLanguage: source, targetLanguage: target, key: source + '>' + target };
    }

    function disposedError() {
      return failure('Chrome 本地翻译已关闭，请重新启用', { destroyed: true, cancelled: true }, 'AbortError');
    }

    function safeDestroy(instance) {
      try { if (instance && typeof instance.destroy === 'function') instance.destroy(); } catch (error) { /* Already released by native AbortSignal. */ }
    }

    function cleanMonitor(entry) {
      for (const remove of entry.monitorCleanup.splice(0)) {
        try { remove(); } catch (error) { /* A detached native monitor needs no further cleanup. */ }
      }
    }

    function retire(entry, reason = cancelled()) {
      if (entry.state === 'dead') return;
      entry.state = 'dead';
      if (pairs.get(entry.key) === entry) pairs.delete(entry.key);
      entry.controller.abort(reason);
      safeDestroy(entry.instance);
      entry.instance = null;
      cleanMonitor(entry);
    }

    // Race explicitly: a browser implementation may leave a native promise pending after abort.
    function controlled(run, settings = {}) {
      const controller = settings.controller || new AbortController();
      const signals = (settings.signals || []).filter(Boolean);
      return new Promise((resolve, reject) => {
        let settled = false, timer;
        const listeners = [];
        function cleanup() {
          clearTimeout(timer);
          for (const [signal, handler] of listeners) signal.removeEventListener('abort', handler);
        }
        function stop(error) {
          if (settled) return;
          settled = true;
          cleanup();
          controller.abort(error);
          if (settings.onStop) settings.onStop(error);
          reject(error);
        }
        for (const signal of signals) {
          const reason = () => signal.reason instanceof Error ? signal.reason : cancelled();
          if (signal.aborted) { stop(reason()); return; }
          const handler = () => stop(reason());
          signal.addEventListener('abort', handler, { once: true });
          listeners.push([signal, handler]);
        }
        timer = setTimeout(() => stop(failure(settings.timeoutMessage || 'Chrome 本地翻译超时，请重新启用', { timeout: true }, 'TimeoutError')), settings.timeoutMs);
        let work;
        try { work = run(controller.signal); }
        catch (error) { work = Promise.reject(error); }
        Promise.resolve(work).then(value => {
          if (settled) {
            if (settings.onLateValue) settings.onLateValue(value);
            return;
          }
          settled = true;
          cleanup();
          resolve(value);
        }, error => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
      });
    }

    async function available(sourceLanguage, targetLanguage = 'zh') {
      let definition;
      try { definition = pair(sourceLanguage, targetLanguage); } catch (error) { return 'unavailable'; }
      if (destroyed || !supportedAPI()) return 'unavailable';
      const entry = pairs.get(definition.key);
      if (entry && entry.state === 'ready') return 'available';
      try {
        const value = await controlled(() => TranslatorImpl.availability({ sourceLanguage: definition.sourceLanguage, targetLanguage: definition.targetLanguage }), { timeoutMs, signals: [lifetime.signal] });
        if (destroyed) return 'unavailable';
        const state = states.has(value) ? value : 'unavailable';
        availability.set(definition.key, state);
        return state;
      } catch (error) { return 'unavailable'; }
    }

    function emit(entry, status, loaded) {
      const event = { sourceLanguage: entry.sourceLanguage, targetLanguage: entry.targetLanguage, status, loaded, total: 1 };
      for (const callback of entry.listeners) {
        try { callback(event); } catch (error) { /* A display callback cannot break a model operation. */ }
      }
    }

    function start(definition) {
      const entry = { ...definition, state: 'preparing', controller: new AbortController(), instance: null, tail: Promise.resolve(), listeners: new Set(), monitorCleanup: [] };
      pairs.set(entry.key, entry);
      return entry;
    }

    function prepareOne(definition, settings) {
      if (destroyed) return Promise.reject(disposedError());
      if (settings.signal && settings.signal.aborted) return Promise.reject(settings.signal.reason instanceof Error ? settings.signal.reason : cancelled());
      if (!supportedAPI() || availability.get(definition.key) === 'unavailable') {
        return Promise.reject(failure('当前浏览器不支持此本地翻译语言对', { unsupported: true, permanent: true }));
      }
      let entry = pairs.get(definition.key);
      if (!entry) {
        entry = start(definition);
        if (typeof settings.onProgress === 'function') entry.listeners.add(settings.onProgress);
        emit(entry, 'downloading', 0);
        // Keep this synchronous in the prepareLanguages click call stack. Awaiting availability
        // or processing one language at a time here could lose transient user activation.
        entry.preparing = controlled(signal => TranslatorImpl.create({
          sourceLanguage: entry.sourceLanguage,
          targetLanguage: entry.targetLanguage,
          signal,
          monitor(monitor) {
            if (entry.state === 'dead') return;
            const progress = event => {
              if (entry.state === 'dead') return;
              const total = Number(event.total), raw = Number(event.loaded);
              const loaded = Number.isFinite(raw) ? Math.max(0, Math.min(1, total > 1 ? raw / total : raw)) : 0;
              emit(entry, 'downloading', loaded);
            };
            monitor.addEventListener('downloadprogress', progress);
            entry.monitorCleanup.push(() => monitor.removeEventListener('downloadprogress', progress));
          }
        }), {
          controller: entry.controller,
          signals: [settings.signal, entry.controller.signal],
          timeoutMs: settings.timeoutMs,
          timeoutMessage: 'Chrome 本地语言模型准备超时，请重新点击启用',
          onStop: error => retire(entry, error),
          onLateValue: safeDestroy
        }).then(instance => {
          if (!instance || typeof instance.translate !== 'function') {
            safeDestroy(instance);
            throw new Error('浏览器未返回可用的本地翻译模型');
          }
          if (destroyed || entry.state === 'dead') { safeDestroy(instance); throw disposedError(); }
          entry.instance = instance;
          entry.state = 'ready';
          emit(entry, 'available', 1);
          return entry;
        }).catch(error => {
          retire(entry, error);
          throw error;
        }).finally(() => cleanMonitor(entry));
      } else if (typeof settings.onProgress === 'function') {
        entry.listeners.add(settings.onProgress);
      }
      const callback = settings.onProgress;
      const result = entry.state === 'ready' ? Promise.resolve(entry) : controlled(() => entry.preparing, {
        signals: [settings.signal, entry.controller.signal],
        timeoutMs: settings.timeoutMs,
        onStop: error => retire(entry, error)
      });
      if (entry.state === 'ready' && typeof callback === 'function') {
        try { callback({ sourceLanguage: entry.sourceLanguage, targetLanguage: entry.targetLanguage, status: 'available', loaded: 1, total: 1 }); } catch (error) { /* Display only. */ }
      }
      return result.finally(() => { if (callback) entry.listeners.delete(callback); });
    }

    function prepareLanguages(languages, settings = {}) {
      if (!Array.isArray(languages)) return Promise.reject(new TypeError('languages 必须是语言代码数组'));
      let deadline;
      try { deadline = duration(settings.timeoutMs, prepareTimeoutMs); }
      catch (error) { return Promise.reject(error); }
      const seen = new Set();
      const preparations = languages.map(source => {
        let definition;
        try { definition = pair(source, settings.targetLanguage || 'zh'); }
        catch (error) { return Promise.resolve({ sourceLanguage: String(source), targetLanguage: settings.targetLanguage || 'zh', status: 'unavailable', error }); }
        if (seen.has(definition.key)) return null;
        seen.add(definition.key);
        return prepareOne(definition, { ...settings, timeoutMs: deadline }).then(() => ({
          sourceLanguage: definition.sourceLanguage, targetLanguage: definition.targetLanguage, status: 'available'
        }), error => ({
          sourceLanguage: definition.sourceLanguage, targetLanguage: definition.targetLanguage,
          status: error.unsupported || error.name === 'NotSupportedError' ? 'unavailable' : 'error', error
        }));
      }).filter(Boolean);
      return Promise.all(preparations);
    }

    function translate(text, sourceLanguage, settings = {}) {
      let definition, deadline;
      try {
        definition = pair(sourceLanguage, settings.targetLanguage || 'zh');
        deadline = duration(settings.timeoutMs, timeoutMs);
      } catch (error) { return Promise.reject(error); }
      if (destroyed) return Promise.reject(disposedError());
      const entry = pairs.get(definition.key);
      if (!entry || entry.state !== 'ready') return Promise.reject(failure('请先点击启用并准备此语言的 Chrome 本地模型', { notPrepared: true, permanent: true }));
      const source = String(text == null ? '' : text);
      if (!source.trim()) return settings.signal && settings.signal.aborted ? Promise.reject(cancelled()) : Promise.resolve('');
      const previous = entry.tail;
      let started = false;
      const result = controlled(async signal => {
        await previous;
        if (signal.aborted) throw cancelled();
        if (entry.state !== 'ready') throw failure('此本地翻译模型已释放，请重新点击启用', { notPrepared: true, permanent: true });
        started = true;
        const translated = await entry.instance.translate(source, { signal });
        if (typeof translated !== 'string' || !translated.trim()) throw failure('Chrome 本地模型未返回译文', { qualityFailed: true, permanent: true });
        return translated;
      }, {
        signals: [settings.signal, entry.controller.signal],
        timeoutMs: deadline,
        onStop: error => { if (started) retire(entry, error); }
      });
      // A queued caller can cancel before its predecessor finishes. Keep that predecessor
      // in the tail, so cancelling the middle job cannot let a later job overtake it.
      entry.tail = Promise.allSettled([previous, result]).then(() => {});
      return result;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      lifetime.abort(disposedError());
      for (const entry of [...pairs.values()]) retire(entry, disposedError());
      availability.clear();
    }

    return { available, prepareLanguages, translate, destroy };
  }

  const api = { create };
  root.BuyerChromeTranslation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
