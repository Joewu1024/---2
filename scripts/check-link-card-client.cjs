'use strict';

// Fabricated URLs and responses only. No external service is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const client = require('../link-card-client.js');
const source = fs.readFileSync(path.join(__dirname, '../link-card-client.js'), 'utf8');
const origin = 'https://link-card-maker.app.workbuddy.host';
const sharecode = '26URNVPWDI';
const original = 'https://buyer.example.test/s.html?d=cA_b-12&label=中文%20标题#完整快照?x=1&y=%26';
const shortUrl = origin + '/c/Test_42-Ab?sharecode=' + sharecode;
const success = data => ({ ok: true, status: 200, json: async () => data });

test('loading either module form performs no network request', () => {
  let requests = 0;
  const context = { URL, AbortController, setTimeout, clearTimeout, fetch() { requests++; throw Error('Unexpected request'); } };
  vm.runInNewContext(source, context);
  assert.equal(typeof context.BuyerLinkCard.generate, 'function');
  assert.equal(requests, 0);
  assert.deepEqual(Object.keys(client), ['generate']);
});

test('sends the exact original URL in a simple CORS POST without cookies or referrer', async () => {
  let calls = 0;
  const result = await client.generate(original, { count: 3, fetch: async (url, init) => {
    calls++;
    assert.equal(url, origin + '/api/make?sharecode=' + sharecode);
    assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, { 'Content-Type': 'text/plain;charset=UTF-8' });
    assert.equal(init.mode, 'cors'); assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.redirect, 'error');
    assert.equal(init.signal instanceof AbortSignal, true);
    assert.deepEqual(JSON.parse(init.body), {
      url: original, title: '寻品产品分享 · 3 个产品',
      desc: '寻品产品信息 · 点击查看详情 · 可截图或保存 PDF', origin, sharecode
    });
    return success({ shortUrl, original });
  } });
  assert.equal(result, shortUrl); assert.equal(calls, 1);
});

test('uses one product by default and accepts a response without the optional original echo', async () => {
  assert.equal(await client.generate(original, { fetch: async (_, init) => {
    assert.equal(JSON.parse(init.body).title, '寻品产品分享 · 1 个产品');
    return success({ shortUrl });
  } }), shortUrl);
});

test('browser global uses its native fetch only after an explicit generate call', async () => {
  let calls = 0;
  const context = { URL, AbortController, setTimeout, clearTimeout, fetch: async function (_, init) {
    calls++; assert.equal(JSON.parse(init.body).url, original); return success({ shortUrl });
  } };
  vm.runInNewContext(source, context);
  assert.equal(calls, 0);
  assert.equal(await context.BuyerLinkCard.generate(original), shortUrl);
  assert.equal(calls, 1);
});

test('rejects invalid input URLs before contacting the service', async () => {
  let calls = 0;
  for (const value of ['', null, {}, '/relative', 'http://example.test/a', 'javascript:alert(1)',
    'https://user:password@example.test/a', 'https://user@example.test/a', ' https://example.test/a', 'https://example.test/a\n']) {
    await assert.rejects(client.generate(value, { fetch: async () => { calls++; return success({ shortUrl }); } }), /原始分享链接无效/);
  }
  assert.equal(calls, 0);
});

test('rejects mismatching echoes and invalid short link destinations', async () => {
  await assert.rejects(client.generate(original, { fetch: async () => success({ shortUrl, original: original + 'x' }) }), /原始链接不一致/);
  const invalid = [
    'http://link-card-maker.app.workbuddy.host/c/abc?sharecode=' + sharecode,
    'https://other.example.test/c/abc?sharecode=' + sharecode,
    origin + '/other/abc?sharecode=' + sharecode, origin + '/c/?sharecode=' + sharecode,
    origin + '/c/a/b?sharecode=' + sharecode, origin + '/c/a%2fb?sharecode=' + sharecode,
    origin + '/c/abc', origin + '/c/abc?sharecode=wrong',
    origin + '/c/abc?sharecode=' + sharecode + '&sharecode=' + sharecode,
    origin + '/c/abc?sharecode=' + sharecode + '#fragment',
    'https://user:password@link-card-maker.app.workbuddy.host/c/abc?sharecode=' + sharecode,
    'javascript:alert(1)', null
  ];
  for (const value of invalid) await assert.rejects(client.generate(original, { fetch: async () => success({ shortUrl: value }) }), /返回链接无效/);
  for (const value of [null, [], 'text']) await assert.rejects(client.generate(original, { fetch: async () => success(value) }), /返回内容无效/);
});

test('network, HTTP and malformed response errors never return the original or retry', async () => {
  const responses = [
    { run: async () => { throw Error('offline'); }, message: /无法连接外链工具/ },
    { run: async () => ({ ok: false, status: 429 }), message: /暂时限流/ },
    { run: async () => ({ ok: false, status: 503 }), message: /生成失败/ },
    { run: async () => ({ ok: true, json: async () => { throw Error('not JSON'); } }), message: /返回内容无效/ }
  ];
  for (const entry of responses) {
    let calls = 0;
    await assert.rejects(client.generate(original, { fetch: (...args) => { calls++; return entry.run(...args); } }), entry.message);
    assert.equal(calls, 1);
  }
});

test('timeout aborts a stalled fetch and does not retry', async () => {
  let signal, calls = 0;
  await assert.rejects(client.generate(original, { timeoutMs: 10, fetch: async (_, init) => {
    calls++; signal = init.signal; return new Promise(() => {});
  } }), /生成超时/);
  assert.equal(signal.aborted, true); assert.equal(calls, 1);
});

test('timeout also bounds response decoding after fetch has resolved', async () => {
  let signal;
  await assert.rejects(client.generate(original, { timeoutMs: 10, fetch: async (_, init) => {
    signal = init.signal; return { ok: true, json: async () => new Promise(() => {}) };
  } }), /生成超时/);
  assert.equal(signal.aborted, true);
});

test('successful requests clear their timeout instead of aborting later', async () => {
  let signal;
  assert.equal(await client.generate(original, { timeoutMs: 10, fetch: async (_, init) => {
    signal = init.signal; return success({ shortUrl, original });
  } }), shortUrl);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(signal.aborted, false);
});
