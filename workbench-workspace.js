(function (root) {
  'use strict';

  // Workspace IDs select a local namespace; they are not credentials or accounts.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const DEFAULT_DB = 'buyer-pool-workbench';
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function validateId(value) {
    if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) {
      throw new Error('工作区地址无效，请使用“分享空白工作台”生成的链接');
    }
    return value.toLowerCase();
  }

  function optionalId(value) {
    return value == null ? null : validateId(value);
  }

  function baseName(value) {
    if (typeof value !== 'string' || !value || value.length > 180) {
      throw new TypeError('本地存储名称无效');
    }
    return value;
  }

  function dbName(base = DEFAULT_DB, id = null) {
    base = baseName(base);
    id = optionalId(id);
    return id ? base + ':workspace:' + id : base;
  }

  function storageKey(base, id = null) {
    return dbName(baseName(base), id);
  }

  function pageUrl(href) {
    const url = new URL(href == null ? root.location && root.location.href : href);
    if (!['https:', 'http:', 'file:'].includes(url.protocol)) {
      throw new Error('工作台地址必须使用 HTTP、HTTPS 或本地文件');
    }
    return url;
  }

  function cleanUrl(href) {
    const url = pageUrl(href);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url;
  }

  function blankShareUrl(href) {
    const url = cleanUrl(href);
    url.searchParams.set('new', '1');
    return url.href;
  }

  function workspaceLabel(id = null) {
    id = optionalId(id);
    return id ? '本机独立工作区 · ' + id.slice(0, 8) : '本机默认工作区';
  }

  function randomId(cryptoImpl) {
    if (cryptoImpl && typeof cryptoImpl.randomUUID === 'function') {
      return validateId(cryptoImpl.randomUUID());
    }
    if (cryptoImpl && typeof cryptoImpl.getRandomValues === 'function') {
      const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
      return validateId(hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20));
    }
    throw new Error('此浏览器无法安全创建独立工作区，请使用较新版本的浏览器');
  }

  function resolve(options = {}) {
    const url = pageUrl(options.href);
    const ids = url.searchParams.getAll('workspace');
    const newFlags = url.searchParams.getAll('new');
    if (ids.length > 1 || newFlags.length > 1 || (newFlags.length && newFlags[0] !== '1')) {
      throw new Error('工作区地址包含重复或无效参数，请重新打开空白工作台链接');
    }
    let id = ids.length ? validateId(ids[0]) : null;
    const created = newFlags[0] === '1';
    let resolvedHref = url.href;
    if (created) {
      const history = own(options, 'history') ? options.history : root.history;
      if (!history || typeof history.replaceState !== 'function') {
        throw new Error('浏览器无法保留工作区地址，请使用较新版本的浏览器');
      }
      id = randomId(own(options, 'crypto') ? options.crypto : root.crypto);
      const target = cleanUrl(url.href);
      target.searchParams.set('workspace', id);
      resolvedHref = target.href;
      // Replace before touching persistence: refresh must reopen this same namespace.
      history.replaceState(history.state == null ? null : history.state, '', resolvedHref);
    }
    return Object.freeze({
      id,
      isDefault: id === null,
      created,
      href: resolvedHref,
      dbName: (base = DEFAULT_DB) => dbName(base, id),
      storageKey: base => storageKey(base, id),
      blankShareUrl: () => blankShareUrl(resolvedHref),
      workspaceLabel: () => workspaceLabel(id)
    });
  }

  function noWriter(status, error) {
    return Object.freeze({ owner: false, status, error: error || null, release: () => false });
  }

  function acquireWriter(context, options = {}) {
    const id = optionalId(context && context.id);
    const navigator = own(options, 'navigator') ? options.navigator : root.navigator;
    // No localStorage heartbeat: it cannot atomically prevent concurrent writers.
    // Callers must keep the page read-only when Web Locks is unavailable or fails.
    if (!navigator || !navigator.locks || typeof navigator.locks.request !== 'function') {
      return Promise.resolve(noWriter('unsupported'));
    }
    const lockName = dbName(DEFAULT_DB, id) + ':writer';
    return new Promise(resolveResult => {
      let settled = false;
      const finish = result => {
        if (!settled) {
          settled = true;
          resolveResult(result);
        }
      };
      try {
        const request = navigator.locks.request(lockName, { mode: 'exclusive', ifAvailable: true }, lock => {
          if (!lock) {
            finish(noWriter('busy'));
            return;
          }
          return new Promise(releaseLock => {
            let active = true;
            finish(Object.freeze({
              get owner() { return active; },
              get status() { return active ? 'owner' : 'released'; },
              error: null,
              release() {
                if (!active) return false;
                active = false;
                releaseLock();
                return true;
              }
            }));
          });
        });
        Promise.resolve(request).catch(error => finish(noWriter('error', error)));
      } catch (error) {
        finish(noWriter('error', error));
      }
    });
  }

  const api = Object.freeze({ validateId, dbName, storageKey, blankShareUrl, workspaceLabel, resolve, acquireWriter });
  root.BuyerWorkspace = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'object' ? globalThis : this);
