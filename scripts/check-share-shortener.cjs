'use strict';

// All payloads are fabricated. Tests never create public short links or send network requests.
const assert = require('node:assert/strict');
const { test, after, mock } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const shortener = require('../share-shortener.js');

const origin = 'https://example.test';
const source = token => origin + '/pool/share.html#d=' + token;
const shortUrl = 'https://is.gd/AbC_12';
mock.method(globalThis, 'fetch', () => { throw new Error('Network access is forbidden in share-shortener checks'); });
after(() => mock.restoreAll());

function response(data = { shorturl: shortUrl }, status = 200, retryAfter = null) {
  return { status, json: async () => data, headers: { get: name => name.toLowerCase() === 'retry-after' ? retryAfter : null } };
}

function storage(entries = null) {
  const values = new Map(entries || []);
  return { values, getItem: mock.fn(key => values.get(key) || null), setItem: mock.fn((key, value) => values.set(key, value)) };
}

function setup(handler = () => response(), options = {}) {
  const fetchImpl = mock.fn((input, init) => handler(input, init));
  return { ...shortener.create({ fetchImpl, storage: null, allowedOrigin: origin, ...options }), fetchImpl };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(condition) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Timed out waiting for a bounded mock operation');
}

test('exports one browser/CommonJS API and never fetches during script load or construction', () => {
  assert.strictEqual(globalThis.BuyerShareShortener, shortener);
  let calls = 0;
  const sandbox = { URL, URLSearchParams, AbortController, setTimeout, clearTimeout, location: { origin }, fetch: () => { calls++; } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../share-shortener.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.BuyerShareShortener.create, 'function');
  sandbox.BuyerShareShortener.create();
  assert.equal(calls, 0);
});

test('POSTs only format and the complete Unicode/fragment URL with cookies omitted', async () => {
  const longUrl = origin + '/pool/share.html?ids=FICT001&notes=仅供查看#d=中文+&/=?_参数';
  const h = setup((input, init) => {
    assert.equal(input, 'https://is.gd/create.php');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.ok(init.body instanceof URLSearchParams);
    assert.deepEqual([...init.body.keys()], ['format', 'url']);
    assert.equal(init.body.get('format'), 'json');
    assert.equal(init.body.get('url'), longUrl);
    assert.equal(new URLSearchParams(init.body.toString()).get('url'), longUrl);
    assert.equal(init.body.has('ids'), false);
    assert.equal(init.body.has('notes'), false);
    assert.equal(init.body.has('callback'), false);
    assert.match(init.body.toString(), /%E4%B8%AD%E6%96%87/);
    return response();
  });
  assert.deepEqual(await h.shorten(longUrl), { url: shortUrl, shortened: true });
  assert.equal(h.fetchImpl.mock.callCount(), 1);
});

test('the 5000-character boundary is accepted and an overlong complete URL is never transmitted', async () => {
  const base = source('');
  const exact = base + 'x'.repeat(5000 - base.length);
  const h = setup();
  assert.deepEqual(await h.shorten(exact), { url: shortUrl, shortened: true });
  const tooLong = exact + 'x';
  assert.deepEqual(await h.shorten(tooLong), { url: tooLong, shortened: false, reason: 'too_long' });
  const encodedTooLong = source('中'.repeat(1000));
  assert.deepEqual(await h.shorten(encodedTooLong), { url: encodedTooLong, shortened: false, reason: 'too_long' });
  assert.equal(h.fetchImpl.mock.callCount(), 1);
});

for (const invalid of [
  'http://example.test/share.html#d=abc',
  'https://evil.test/share.html#d=abc',
  'https://example.test.evil.test/share.html#d=abc',
  'https://example.test@evil.test/share.html#d=abc',
  'https://evil@example.test/share.html#d=abc',
  'https://example.test:444/share.html#d=abc',
  'https://example.test/evil.html#d=abc',
  'https://example.test/myshare.html#d=abc',
  'https://example.test/share.html/#d=abc',
  'https://example.test/share.html',
  'https://example.test/share.html#d=',
  'https://example.test/share.html#evil=abc',
  'javascript:alert(1)', '/share.html#d=abc',
  ' https://example.test/share.html#d=abc',
  'https://example.test/share.html#d=a\nb'
]) {
  test('invalid or foreign source URLs stay local: ' + JSON.stringify(invalid), async () => {
    const h = setup(() => assert.fail('invalid source must never be sent'));
    assert.deepEqual(await h.shorten(invalid), { url: invalid, shortened: false, reason: 'invalid_response' });
    assert.equal(h.fetchImpl.mock.callCount(), 0);
  });
}

test('a missing or invalid allowedOrigin never grants access to arbitrary HTTPS origins', async () => {
  for (const allowedOrigin of [null, '', 'http://example.test', 'https://example.test/other-path']) {
    const h = setup(() => assert.fail('no permitted origin'), { allowedOrigin });
    assert.equal((await h.shorten(source('valid'))).reason, 'invalid_response');
  }
});

test('default allowedOrigin comes from the current HTTPS location', async () => {
  let calls = 0;
  const sandbox = { URL, URLSearchParams, AbortController, setTimeout, clearTimeout, location: { origin }, fetch: async () => { calls++; return response(); } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../share-shortener.js'), 'utf8'), sandbox);
  const result = await sandbox.BuyerShareShortener.create({ storage: null }).shorten(source('defaultorigin'));
  assert.equal(result.url, shortUrl);
  assert.equal(result.shortened, true);
  assert.equal(calls, 1);
});

test('identical pending calls return the same promise and successful calls use the full-input cache', async () => {
  const gate = deferred();
  const h = setup(() => gate.promise);
  const first = h.shorten(source('one'));
  const second = h.shorten(source('one'));
  assert.strictEqual(first, second);
  assert.equal(h.fetchImpl.mock.callCount(), 1);
  gate.resolve(response());
  assert.deepEqual(await first, { url: shortUrl, shortened: true });
  assert.deepEqual(await h.shorten(source('one')), { url: shortUrl, shortened: true });
  assert.equal(h.fetchImpl.mock.callCount(), 1);
  await h.shorten(source('two'));
  assert.equal(h.fetchImpl.mock.callCount(), 2, 'different complete fragments are separate cache keys');
});

test('at most five API requests run concurrently', async () => {
  const gates = [];
  let active = 0, maximum = 0;
  const h = setup(async () => {
    active++; maximum = Math.max(maximum, active);
    const gate = deferred(); gates.push(gate);
    await gate.promise; active--;
    return response();
  });
  const pending = Array.from({ length: 12 }, (_, i) => h.shorten(source('concurrent' + i)));
  assert.equal(h.fetchImpl.mock.callCount(), 5);
  gates.slice(0, 5).forEach(gate => gate.resolve());
  await waitFor(() => gates.length === 10);
  gates.slice(5, 10).forEach(gate => gate.resolve());
  await waitFor(() => gates.length === 12);
  gates.slice(10).forEach(gate => gate.resolve());
  assert.ok((await Promise.all(pending)).every(value => value.shortened));
  assert.equal(maximum, 5);
});

test('failures return the original complete URL and are not cached or persisted', async () => {
  const saved = storage();
  let calls = 0;
  const h = setup(() => { if (++calls === 1) throw new TypeError('fabricated outage'); return response(); }, { storage: saved });
  const longUrl = source('network');
  assert.deepEqual(await h.shorten(longUrl), { url: longUrl, shortened: false, reason: 'network' });
  assert.equal(saved.setItem.mock.callCount(), 0);
  assert.equal((await h.shorten(longUrl)).shortened, true);
  assert.equal(h.fetchImpl.mock.callCount(), 2);
});

test('timeout aborts once and late success cannot poison the successful cache', { timeout: 2000 }, async () => {
  const gate = deferred();
  let signal, count = 0;
  const h = setup((input, init) => { signal = init.signal; return ++count === 1 ? gate.promise : response(); }, { timeoutMs: 15 });
  const longUrl = source('timeout');
  assert.deepEqual(await h.shorten(longUrl), { url: longUrl, shortened: false, reason: 'timeout' });
  assert.equal(signal.aborted, true);
  gate.resolve(response({ shorturl: 'https://is.gd/Late123' }));
  await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal((await h.shorten(longUrl)).url, shortUrl);
  assert.equal(h.fetchImpl.mock.callCount(), 2);
});

test('HTTP 429 respects Retry-After longer than the minimum cooldown', async () => {
  let time = 1000000, calls = 0;
  const h = setup(() => ++calls === 1 ? response({}, 429, '120') : response(), { now: () => time });
  assert.equal((await h.shorten(source('rate1'))).reason, 'rate_limited');
  time += 60001;
  assert.equal((await h.shorten(source('rate2'))).reason, 'rate_limited');
  assert.equal(h.fetchImpl.mock.callCount(), 1);
  time += 60000;
  assert.equal((await h.shorten(source('rate2'))).shortened, true);
  assert.equal(h.fetchImpl.mock.callCount(), 2);
});

test('errorcode 3 on HTTP 502 pauses for at least 60 seconds even with a shorter Retry-After', async () => {
  let time = 2000000, calls = 0;
  const h = setup(() => ++calls === 1 ? response({ errorcode: 3 }, 502, '5') : response(), { now: () => time });
  assert.equal((await h.shorten(source('code3'))).reason, 'rate_limited');
  time += 59999;
  assert.equal((await h.shorten(source('after3'))).reason, 'rate_limited');
  assert.equal(h.fetchImpl.mock.callCount(), 1);
  time++;
  assert.equal((await h.shorten(source('after3'))).shortened, true);
});

test('HTTP-date Retry-After controls the cooldown', async () => {
  let time = Date.parse('2030-01-01T00:00:00Z');
  const retryAt = time + 180000;
  let calls = 0;
  const h = setup(() => ++calls === 1 ? response({ errorcode: '3' }, 200, new Date(retryAt).toUTCString()) : response(), { now: () => time });
  assert.equal((await h.shorten(source('date1'))).reason, 'rate_limited');
  time = retryAt - 1;
  assert.equal((await h.shorten(source('date2'))).reason, 'rate_limited');
  time++;
  assert.equal((await h.shorten(source('date2'))).shortened, true);
});

test('a rate limit stops queued work before a sixth request can start', async () => {
  const gates = [];
  const h = setup(() => { const gate = deferred(); gates.push(gate); return gate.promise; });
  const calls = Array.from({ length: 6 }, (_, i) => h.shorten(source('queued' + i)));
  assert.equal(gates.length, 5);
  gates[0].resolve(response({}, 429));
  assert.equal((await calls[0]).reason, 'rate_limited');
  assert.equal((await calls[5]).reason, 'rate_limited');
  assert.equal(h.fetchImpl.mock.callCount(), 5);
  gates.slice(1).forEach(gate => gate.resolve(response()));
  await Promise.all(calls);
});

test('the local hourly budget does not exceed 200 new requests', async () => {
  let time = 3000000;
  const h = setup(() => response(), { now: () => time, maxEntries: 0 });
  for (let i = 0; i < 200; i++) assert.equal((await h.shorten(source('hourly' + i))).shortened, true);
  assert.equal((await h.shorten(source('hourly200'))).reason, 'rate_limited');
  assert.equal(h.fetchImpl.mock.callCount(), 200);
  time += 3600001;
  assert.equal((await h.shorten(source('hourly200'))).shortened, true);
  assert.equal(h.fetchImpl.mock.callCount(), 201);
});

for (const evil of [
  'http://is.gd/AbC_12', 'https://evil.test/AbC_12', 'https://is.gd.evil.test/AbC_12',
  'https://evil@is.gd/AbC_12', 'https://is.gd:443/AbC_12', 'https://is.gd/AbC_12?x=1',
  'https://is.gd/AbC_12#evil', 'https://is.gd/a/bcdef', 'https://is.gd/Ab-c12',
  'https://is.gd/abcd', 'https://is.gd/' + 'a'.repeat(31), 'https://is.gd/AbC_12\n',
  'javascript:alert(1)', '//is.gd/AbC_12'
]) {
  test('untrusted short response is never accepted: ' + JSON.stringify(evil), async () => {
    const h = setup(() => response({ shorturl: evil }));
    const longUrl = source('evilresponse');
    assert.deepEqual(await h.shorten(longUrl), { url: longUrl, shortened: false, reason: 'invalid_response' });
  });
}

test('service and malformed-response failures keep their honest fallback reasons', async () => {
  for (const [reply, reason] of [
    [response({ errorcode: 4 }), 'service_unavailable'],
    [response({}, 503), 'service_unavailable'],
    [response({ errorcode: 1 }), 'invalid_response'],
    [response({ errorcode: 1 }, 400), 'invalid_response'],
    [response({ errorcode: 2 }, 406), 'invalid_response'],
    [response({ shorturl: shortUrl, errorcode: 0 }), 'invalid_response'],
    [response(null), 'invalid_response'],
    [response([]), 'invalid_response'],
    [{ status: 200, json: async () => { throw new SyntaxError('fabricated bad JSON'); } }, 'invalid_response']
  ]) {
    const h = setup(() => reply);
    assert.deepEqual(await h.shorten(source('failure')), { url: source('failure'), shortened: false, reason });
  }
});

test('only validated same-origin successful cache records are loaded', async () => {
  const key = 'test-shortener-cache';
  const saved = storage([[key, JSON.stringify({ version: 1, entries: [
    [source('cached'), shortUrl],
    [source('poisoned'), 'https://evil.test/AbC_12'],
    ['https://evil.test/share.html#d=foreign', shortUrl],
    [source('query'), shortUrl + '?evil=1'],
    [source('huge' + 'x'.repeat(5000)), shortUrl],
    ['__proto__', shortUrl]
  ] })]]);
  const h = setup(() => response(), { storage: saved, storageKey: key });
  assert.equal(h.fetchImpl.mock.callCount(), 0);
  assert.equal(saved.setItem.mock.callCount(), 0);
  assert.equal((await h.shorten(source('cached'))).shortened, true);
  assert.equal(h.fetchImpl.mock.callCount(), 0);
  await h.shorten(source('poisoned'));
  assert.equal(h.fetchImpl.mock.callCount(), 1);
  const persisted = JSON.parse(saved.values.get(key));
  assert.equal(persisted.entries.length, 2);
  assert.ok(persisted.entries.every(([longUrl, short]) => longUrl.startsWith(origin) && short === shortUrl));
});

test('successful storage entries follow the configured bounded LRU', async () => {
  const saved = storage();
  const key = 'small-cache';
  const h = setup(() => response(), { storage: saved, storageKey: key, maxEntries: 2 });
  await h.shorten(source('a')); await h.shorten(source('b')); await h.shorten(source('a')); await h.shorten(source('c'));
  assert.deepEqual(JSON.parse(saved.values.get(key)).entries.map(entry => entry[0]), [source('a'), source('c')]);
  assert.equal(h.fetchImpl.mock.callCount(), 3);
  await h.shorten(source('b'));
  assert.equal(h.fetchImpl.mock.callCount(), 4);
});

test('persistent success storage never exceeds eighty entries', async () => {
  const saved = storage(), key = 'maximum-cache';
  const h = setup(() => response(), { storage: saved, storageKey: key, maxEntries: 1000 });
  for (let i = 0; i < 85; i++) await h.shorten(source('stored' + i));
  assert.equal(JSON.parse(saved.values.get(key)).entries.length, 80);
});

test('storage quota and access errors never prevent valid shortening or memory-cache reuse', async () => {
  const saved = { getItem: () => { throw new Error('fabricated storage access failure'); }, setItem: mock.fn(() => { throw new Error('fabricated storage quota'); }) };
  const h = setup(() => response(), { storage: saved });
  assert.equal((await h.shorten(source('quota'))).shortened, true);
  assert.equal((await h.shorten(source('quota'))).shortened, true);
  assert.equal((await h.shorten(source('quota2'))).shortened, true);
  assert.equal(h.fetchImpl.mock.callCount(), 2);
  assert.equal(saved.setItem.mock.callCount(), 1);
});

test('invalid storage JSON is ignored and missing fetch returns a usable original URL', async () => {
  const saved = { getItem: () => 'not-json', setItem: () => {} };
  const h = setup(() => response(), { storage: saved });
  assert.equal((await h.shorten(source('badstorage'))).shortened, true);
  const p = shortener.create({ fetchImpl: null, storage: null, allowedOrigin: origin });
  assert.deepEqual(await p.shorten(source('nofetch')), { url: source('nofetch'), shortened: false, reason: 'service_unavailable' });
});
