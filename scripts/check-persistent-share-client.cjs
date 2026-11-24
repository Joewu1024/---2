'use strict';

// Fabricated fixtures and controlled transport only. No public snapshots are
// created, and the test process cannot accidentally contact a live service.
const assert = require('node:assert/strict');
const { test, after, mock } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const api = require('../persistent-share-client.js');

const origin = 'https://cards.example.test';
const baseUrl = origin + '/buyer';
const capability = 'W'.repeat(22) + '.' + 'S'.repeat(43);
const renewedCapability = 'N'.repeat(22) + '.' + 'T'.repeat(43);
const id = number => String(number).padStart(22, 'A');
const products = () => [{ id: 'FAKE-1', model: '', itemChinese: '  中文 🟢 ', modelChinese: '5pcs', category: '家用电器 > 遥控器', invitation: '', target: '0.00', shopee: '', shopeeUrl: '', badges: [{ kind: 'crown', icon: '👑', text: '示例' }] }];
mock.method(globalThis, 'fetch', () => { throw new Error('Live network is forbidden in persistent-share-client checks'); });
after(() => mock.restoreAll());

function response(data, status = 200, options = {}) {
  return { status, redirected: false, headers: { get: () => null }, json: async () => JSON.parse(JSON.stringify(data)), ...options };
}

function successful(body, number = 1, overrides = {}) {
  const imageCount = body.products.filter(product => product.model.trim()).length;
  return { id: id(number), url: baseUrl + '/s/' + id(number), persisted: true, productCount: body.products.length, imagesArchived: imageCount, imageFailures: [], ...overrides };
}

function setup(handler, options = {}) {
  const requests = [];
  let count = 0;
  const fetchImpl = mock.fn(async (url, init) => {
    const request = { url, init, body: JSON.parse(init.body), headers: init.headers };
    requests.push(request);
    if (handler) return handler(request, requests);
    if (url.endsWith('/api/writers')) return response({ token: capability }, 201);
    return response(successful(request.body, ++count), 201);
  });
  return { ...api.create({ baseUrl, allowedOrigin: origin, storage: null, fetchImpl, ...options }), requests, fetchImpl };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let count = 0; count < 100; count++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('A bounded mock operation did not start');
}

function memoryStorage(saved) {
  const values = new Map(saved ? [['writer-key', JSON.stringify(saved)]] : []);
  return {
    values,
    getItem: mock.fn(key => values.get(key) || null),
    setItem: mock.fn((key, value) => values.set(key, value)),
    removeItem: mock.fn(key => values.delete(key))
  };
}

test('exposes one UMD/CommonJS API and performs no request at construction', () => {
  assert.strictEqual(globalThis.BuyerPersistentShareClient, api);
  const h = setup();
  assert.equal(h.fetchImpl.mock.callCount(), 0);
  const sandbox = { URL, crypto: webcrypto, AbortController, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(require.resolve('../persistent-share-client.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.BuyerPersistentShareClient.create, 'function');
});

test('only permits configured public HTTPS base and an exact trusted origin', () => {
  for (const value of ['http://cards.example.test', 'https://user:secret@cards.example.test', 'https://cards.example.test/?token=x', 'https://cards.example.test/#x', 'https://localhost', 'https://127.0.0.1', 'https://10.0.0.2', 'https://[::1]', 'https://cards.example.test/a%2fb', ' https://cards.example.test', 'https://cards.example.test\\@other.test']) {
    assert.throws(() => api.create({ baseUrl: value }), failure => failure.code === 'invalid_config');
  }
  assert.throws(() => setup(null, { allowedOrigin: 'https://other.test' }), failure => failure.code === 'invalid_config');
  assert.throws(() => setup(null, { allowedOrigin: origin + '/wrong' }), failure => failure.code === 'invalid_config');
  for (const timeoutMs of [0, -1, Infinity, '1000', 180001]) assert.throws(() => setup(null, { timeoutMs }), failure => failure.code === 'invalid_config');
});

test('publishes selected exact fields with capability confined to authorization', async () => {
  const selected = products();
  selected[0].raw = { notes: 'NEVER-UPLOAD', unrelated: 'PRIVATE' };
  selected[0].userEditedFields = ['NEVER-UPLOAD'];
  selected[0].badges[0].internal = 'NEVER-UPLOAD';
  const h = setup();
  const value = await h.publish(selected);
  assert.deepEqual(value, { url: baseUrl + '/s/' + id(1), id: id(1), persisted: true, productCount: 1, imagesArchived: 0, imageFailures: [] });
  assert.equal(h.requests.length, 2);
  const [writer, share] = h.requests;
  assert.equal(writer.url, baseUrl + '/api/writers');
  assert.deepEqual(writer.body, {});
  assert.equal(writer.headers.Authorization, undefined);
  assert.equal(share.url, baseUrl + '/api/shares');
  assert.equal(share.headers.Authorization, 'Bearer ' + capability);
  assert.equal(share.headers['Content-Type'], 'application/json');
  assert.equal(share.init.credentials, 'omit');
  assert.equal(share.init.redirect, 'error');
  assert.equal(share.init.cache, 'no-store');
  assert.deepEqual(Object.keys(share.body).sort(), ['products', 'requestId', 'v']);
  assert.match(share.body.requestId, /^[A-Za-z0-9_-]{8,80}$/);
  assert.equal(share.body.products[0].itemChinese, '  中文 🟢 ');
  assert.equal(share.body.products[0].modelChinese, '5pcs');
  assert.equal(share.body.products[0].target, '0.00');
  assert.ok(!share.init.body.includes('NEVER-UPLOAD'));
  assert.ok(!value.url.includes(capability));
  assert.equal(new URL(value.url).search, '');
  assert.equal(new URL(value.url).hash, '');
});

test('deep-copies every selected card before the first asynchronous operation', async () => {
  const bootstrap = deferred();
  const selected = products();
  const h = setup(request => request.url.endsWith('/api/writers') ? bootstrap.promise : response(successful(request.body)));
  const pending = h.publish(selected);
  selected[0].itemChinese = 'CHANGED';
  selected[0].badges[0].text = 'CHANGED';
  selected.push({ id: 'UNSELECTED-LATER' });
  bootstrap.resolve(response({ token: capability }));
  await pending;
  assert.equal(h.requests[1].body.products.length, 1);
  assert.equal(h.requests[1].body.products[0].itemChinese, '  中文 🟢 ');
  assert.equal(h.requests[1].body.products[0].badges[0].text, '示例');
});

test('empty, numeric, English and mixed buyer text are not translation-gated or trimmed', async () => {
  for (const text of ['', '  ', '5pcs', '125', 'Black / 黑色', '<b>原样</b>']) {
    const selected = products(); selected[0].itemChinese = text; selected[0].modelChinese = text;
    const h = setup(); await h.publish(selected);
    assert.equal(h.requests[1].body.products[0].itemChinese, text);
    assert.equal(h.requests[1].body.products[0].modelChinese, text);
  }
});

test('concurrent publishes share one bootstrap and use unique per-click request IDs', async () => {
  const bootstrap = deferred(); let count = 0;
  const h = setup(request => request.url.endsWith('/api/writers') ? bootstrap.promise : response(successful(request.body, ++count)));
  const a = h.publish(products()), b = h.publish(products()), c = h.publish(products());
  await until(() => h.requests.length === 1);
  bootstrap.resolve(response({ token: capability }));
  const results = await Promise.all([a, b, c]);
  assert.equal(h.requests.filter(request => request.url.endsWith('/api/writers')).length, 1);
  assert.equal(new Set(h.requests.slice(1).map(request => request.body.requestId)).size, 3);
  assert.equal(new Set(results.map(value => value.id)).size, 3);
});

test('persists only a writer capability and exact service scope, never cards or mappings', async () => {
  const storage = memoryStorage();
  const h = setup(null, { storage, storageKey: 'writer-key' });
  await h.publish(products()); await h.publish(products());
  assert.equal(h.requests.filter(request => request.url.endsWith('/api/writers')).length, 1);
  assert.deepEqual(JSON.parse(storage.values.get('writer-key')), { v: 1, baseUrl, token: capability });
  assert.ok(!storage.values.get('writer-key').includes('FAKE-1'));
  const cached = setup(null, { storage, storageKey: 'writer-key' }); await cached.publish(products());
  assert.equal(cached.requests.length, 1);
  assert.equal(cached.requests[0].headers.Authorization, 'Bearer ' + capability);
});

test('ignores malformed or differently scoped capability storage', async () => {
  for (const saved of [{ v: 1, baseUrl: 'https://other.test', token: capability }, { v: 2, baseUrl, token: capability }, { v: 1, baseUrl, token: 'bad\r\nAuthorization:value' }]) {
    const h = setup(null, { storage: memoryStorage(saved), storageKey: 'writer-key' });
    await h.publish(products()); assert.equal(h.requests[0].url, baseUrl + '/api/writers');
  }
});

test('storage getter/read/write denial still permits session-backed publication', async () => {
  for (const storage of [{ getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } }, { getItem() { return null; }, setItem() { throw new Error('quota'); } }]) {
    const h = setup(null, { storage }); await h.publish(products()); await h.publish(products());
    assert.equal(h.requests.filter(request => request.url.endsWith('/api/writers')).length, 1);
  }
  let calls = 0;
  const sandbox = { URL, crypto: webcrypto, AbortController, setTimeout, clearTimeout, fetch: async (url, init) => { calls++; return response(url.endsWith('/api/writers') ? { token: capability } : successful(JSON.parse(init.body))); } };
  Object.defineProperty(sandbox, 'localStorage', { get() { throw new Error('privacy getter denied'); } });
  vm.runInNewContext(fs.readFileSync(require.resolve('../persistent-share-client.js'), 'utf8'), sandbox);
  await sandbox.BuyerPersistentShareClient.create({ baseUrl }).publish(products());
  assert.equal(calls, 2);
});

test('401 renews capability once and preserves idempotency body across that retry', async () => {
  let bootstraps = 0, shares = 0;
  const storage = memoryStorage();
  const h = setup(request => {
    if (request.url.endsWith('/api/writers')) return response({ token: ++bootstraps === 1 ? capability : renewedCapability });
    if (++shares === 1) return response({}, 401);
    return response(successful(request.body));
  }, { storage, storageKey: 'writer-key' });
  await h.publish(products());
  assert.equal(bootstraps, 2); assert.equal(shares, 2);
  assert.deepEqual(h.requests[1].body, h.requests[3].body);
  assert.equal(h.requests[1].headers.Authorization, 'Bearer ' + capability);
  assert.equal(h.requests[3].headers.Authorization, 'Bearer ' + renewedCapability);
  assert.equal(JSON.parse(storage.values.get('writer-key')).token, renewedCapability);
});

test('a second 401 is final and cannot trigger a retry loop', async () => {
  let bootstraps = 0, shares = 0;
  const storage = memoryStorage();
  const h = setup(request => request.url.endsWith('/api/writers') ? (bootstraps++, response({ token: capability })) : (shares++, response({}, 401)), { storage, storageKey: 'writer-key' });
  await assert.rejects(h.publish(products()), failure => failure.code === 'unauthorized');
  assert.equal(bootstraps, 2); assert.equal(shares, 2);
  assert.equal(storage.values.has('writer-key'), false);
});

test('concurrent rejected capabilities share one renewal without discarding the fresh token', async () => {
  const gate = deferred(); let count = 0;
  const storage = memoryStorage({ v: 1, baseUrl, token: capability });
  const h = setup(request => {
    if (request.url.endsWith('/api/writers')) return gate.promise;
    if (request.headers.Authorization === 'Bearer ' + capability) return response({}, 401);
    return response(successful(request.body, ++count));
  }, { storage, storageKey: 'writer-key' });
  const a = h.publish(products()), b = h.publish(products());
  await until(() => h.requests.filter(request => request.url.endsWith('/api/writers')).length === 1);
  gate.resolve(response({ token: renewedCapability }));
  await Promise.all([a, b]);
  assert.equal(h.requests.filter(request => request.url.endsWith('/api/writers')).length, 1);
  assert.equal(h.requests.filter(request => request.headers.Authorization === 'Bearer ' + renewedCapability).length, 2);
  assert.equal(JSON.parse(storage.values.get('writer-key')).token, renewedCapability);
});

test('429 is reported once with bounded Retry-After and no fallback success', async () => {
  const h = setup(request => request.url.endsWith('/api/writers') ? response({ token: capability }) : response({ url: 'https://other.test/short' }, 429, { headers: { get: () => '120' } }));
  await assert.rejects(h.publish(products()), failure => failure.code === 'rate_limited' && failure.retryAfterSeconds === 120);
  assert.equal(h.requests.length, 2);
});

test('the controlled storage-capacity code reports a full archive without retries or server-text leakage', async () => {
  const h = setup(request => request.url.endsWith('/api/writers') ? response({ token: capability }) : response({ error: { code: 'STORAGE_LIMIT', message: 'UNTRUSTED ' + capability } }, 429));
  await assert.rejects(h.publish(products()), failure => failure.code === 'storage_full' && failure.message === '分享存储容量已满，已有分享仍可查看，请联系管理员' && !failure.message.includes(capability));
  assert.equal(h.requests.length, 2);
  for (const body of [{ error: { code: 'OTHER', message: 'STORAGE_LIMIT' } }, { error: ['STORAGE_LIMIT'] }, { message: 'STORAGE_LIMIT' }]) {
    const ordinary = setup(() => response(body, 429));
    await assert.rejects(ordinary.publish(products()), failure => failure.code === 'rate_limited');
    assert.equal(ordinary.requests.length, 1);
  }
  const unavailable = setup(() => response({ error: { code: 'STORAGE_LIMIT' } }, 503));
  await assert.rejects(unavailable.publish(products()), failure => failure.code === 'unavailable');
});

test('403, 413 and server errors are explicit and never called persisted', async () => {
  for (const [status, code] of [[403, 'forbidden'], [413, 'too_large'], [500, 'unavailable']]) {
    const h = setup(() => response({ persisted: true, url: origin + '/wrong' }, status));
    await assert.rejects(h.publish(products()), failure => failure.code === code);
    assert.equal(h.requests.length, 1);
  }
});

test('rejects cross-origin URLs, fragments, query strings, bad IDs and unconfirmed storage', async () => {
  const malformed = [
    { url: 'https://is.gd/ABCDEF' }, { url: 'https://other.test/s/' + id(1) }, { url: baseUrl + '/s/' + id(1) + '?token=' + capability },
    { url: baseUrl + '/s/' + id(1) + '#local-map' }, { url: baseUrl + '/s/../s/' + id(1) }, { id: 'short' }, { id: 123 },
    { persisted: false }, { productCount: 2 }, { imagesArchived: 1 }, { imageFailures: undefined }
  ];
  for (const overrides of malformed) {
    const h = setup(request => request.url.endsWith('/api/writers') ? response({ token: capability }) : response(successful(request.body, 1, overrides)));
    await assert.rejects(h.publish(products()), failure => failure.code === 'invalid_response');
  }
});

test('refuses redirects and response endpoint substitutions before reading success JSON', async () => {
  for (const options of [{ redirected: true }, { url: 'https://other.test/api/writers' }]) {
    const h = setup(() => response({ token: capability }, 200, options));
    await assert.rejects(h.publish(products()), failure => failure.code === 'invalid_response');
    assert.equal(h.requests.length, 1);
  }
});

test('image archival counts and per-product failures remain explicit and internally consistent', async () => {
  const selected = products(); selected[0].model = 'https://cf.shopee.com.my/file/example.jpg';
  const failure = { index: 0, message: '图片下载超时' };
  const h = setup(request => request.url.endsWith('/api/writers') ? response({ token: capability }) : response(successful(request.body, 1, { imagesArchived: 0, imageFailures: [failure] })));
  assert.deepEqual((await h.publish(selected)).imageFailures, [failure]);
  for (const overrides of [
    { imagesArchived: 0, imageFailures: [] }, { imagesArchived: 0, imageFailures: [failure, failure] },
    { imagesArchived: 0, imageFailures: [{ index: 1, message: 'wrong' }] },
    { imagesArchived: 0, imageFailures: [{ index: 0, message: 'Do not echo ' + capability }] }
  ]) {
    const malformed = setup(request => request.url.endsWith('/api/writers') ? response({ token: capability }) : response(successful(request.body, 1, overrides)));
    await assert.rejects(malformed.publish(selected), failure => failure.code === 'invalid_response');
  }
});

test('source image absence is not invented as an archival failure', async () => {
  const selected = products(); selected[0].model = '   ';
  const h = setup(); const value = await h.publish(selected);
  assert.equal(h.requests[1].body.products[0].model, '   ');
  assert.equal(value.imagesArchived, 0); assert.deepEqual(value.imageFailures, []);
});

test('no URL is returned when data becomes stale during bootstrap or upload', async () => {
  for (const stage of ['bootstrap', 'upload']) {
    let current = true;
    const gate = deferred();
    const h = setup(request => {
      if (request.url.endsWith('/api/writers')) return stage === 'bootstrap' ? gate.promise : response({ token: capability });
      return gate.promise;
    });
    const pending = h.publish(products(), { isCurrent: () => current });
    const rejected = assert.rejects(pending, failure => failure.code === 'stale');
    await until(() => h.requests.length === (stage === 'bootstrap' ? 1 : 2)); current = false;
    gate.resolve(stage === 'bootstrap' ? response({ token: capability }) : response(successful(h.requests[1].body)));
    await rejected;
    if (stage === 'bootstrap') assert.equal(h.requests.length, 1);
  }
});

test('an already stale or aborted operation sends nothing', async () => {
  const h = setup();
  await assert.rejects(h.publish(products(), { isCurrent: () => false }), failure => failure.code === 'stale');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.publish(products(), { signal: controller.signal }), failure => failure.code === 'aborted');
  assert.equal(h.requests.length, 0);
});

test('aborting one caller cannot cancel the shared writer bootstrap for another', async () => {
  const gate = deferred();
  const h = setup(request => request.url.endsWith('/api/writers') ? gate.promise : response(successful(request.body)));
  const controller = new AbortController();
  const a = h.publish(products(), { signal: controller.signal });
  const rejected = assert.rejects(a, failure => failure.code === 'aborted');
  const b = h.publish(products());
  await until(() => h.requests.length === 1); controller.abort(); await rejected;
  assert.equal(h.requests[0].init.signal.aborted, false);
  gate.resolve(response({ token: capability }));
  await b;
  assert.equal(h.requests.filter(request => request.url.endsWith('/api/shares')).length, 1);
});

test('aborting an upload cancels its request and cannot return a late persisted URL', async () => {
  const gate = deferred(), controller = new AbortController();
  const h = setup(request => request.url.endsWith('/api/writers') ? response({ token: capability }) : gate.promise);
  const pending = h.publish(products(), { signal: controller.signal });
  const rejected = assert.rejects(pending, failure => failure.code === 'aborted');
  await until(() => h.requests.length === 2); controller.abort(); await rejected;
  assert.equal(h.requests[1].init.signal.aborted, true);
  gate.resolve(response(successful(h.requests[1].body)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.length, 2);
});

test('a failed bootstrap is not cached as a permanent failure', async () => {
  let attempt = 0;
  const h = setup(request => {
    if (request.url.endsWith('/api/writers')) return ++attempt === 1 ? response({}, 503) : response({ token: capability });
    return response(successful(request.body));
  });
  await assert.rejects(h.publish(products()), failure => failure.code === 'unavailable');
  await h.publish(products());
  assert.equal(attempt, 2);
});

test('timeouts settle even if fetch ignores abort or response JSON never resolves', async () => {
  for (const stage of ['fetch', 'json']) {
    const h = setup(() => stage === 'fetch' ? new Promise(() => {}) : response(null, 200, { json: () => new Promise(() => {}) }), { timeoutMs: 10 });
    await assert.rejects(h.publish(products()), failure => failure.code === 'timeout');
    assert.equal(h.requests.length, 1);
  }
});

test('network and JSON errors are sanitized without leaking tokens, URLs or product text', async () => {
  for (const handler of [() => { throw new Error(capability + ' SECRET-PRODUCT'); }, () => response(null, 200, { json: async () => { throw new Error('SECRET-PRODUCT'); } })]) {
    const h = setup(handler);
    await assert.rejects(h.publish(products()), failure => !failure.message.includes(capability) && !failure.message.includes('SECRET-PRODUCT') && ['network', 'invalid_response'].includes(failure.code));
  }
});

test('invalid products, malformed capabilities and missing secure randomness fail closed', async () => {
  const h = setup();
  for (const input of [null, [], [null], ['x'], [{ badges: 'invalid' }], [{ badges: [null] }], Array.from({ length: 201 }, () => ({}))]) await assert.rejects(h.publish(input), failure => failure.code === 'invalid_products');
  assert.equal(h.requests.length, 0);
  for (const value of ['bad', capability + '\r\nX: injected', { token: capability }]) {
    const malformed = setup(() => response({ token: value }));
    await assert.rejects(malformed.publish(products()), failure => failure.code === 'invalid_response');
    assert.equal(malformed.requests.length, 1);
  }
  const sandbox = { URL, AbortController, setTimeout, clearTimeout, fetch() { assert.fail('No crypto must not send'); } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../persistent-share-client.js'), 'utf8'), sandbox);
  await assert.rejects(sandbox.BuyerPersistentShareClient.create({ baseUrl, storage: null }).publish(products()), failure => failure.code === 'crypto_unavailable');
});

test('secure random bytes remain usable without randomUUID or AbortController', async () => {
  let storedRequestId;
  const sandbox = {
    URL, setTimeout, clearTimeout,
    crypto: { randomUUID() { throw new Error('not supported here'); }, getRandomValues: value => webcrypto.getRandomValues(value) },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith('/api/writers')) return response({ token: capability });
      storedRequestId = body.requestId;
      return response(successful(body));
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../persistent-share-client.js'), 'utf8'), sandbox);
  await sandbox.BuyerPersistentShareClient.create({ baseUrl, storage: null }).publish(products());
  assert.match(storedRequestId, /^[a-f0-9]{32}$/);
});
