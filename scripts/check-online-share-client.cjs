'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const client = require('../online-share-client.js');
const codec = require('../product-share-codec.js');

const serviceUrl = 'https://buyer-share-test.netlify.app';
const viewerUrl = 'https://joewu1024.github.io/---2/?workspace=private#local';
const products = count => Array.from({length:count}, (_, i) => ({
  id:'QA-' + i, itemChinese:'演示标题 ' + i + ' < & 🌿', modelChinese:i ? ' 5pcs / 蓝色 ' : '',
  target:'50.00', category:'家用电器 > 遥控器',
  model:'https://example.test/model-' + i + '.jpg', invitation:'', badges:[],
  shopee:'https://example.test/item/' + i, shopeeUrl:'https://example.test/item/' + i
}));
const encoded = count => codec.encode(products(count));

function harness(options = {}) {
  const data = new Map(), calls = [];
  let lostReply = !!options.lostReply;
  const fetchImpl = async (url, init) => {
    calls.push({url, init});
    assert.equal(new URL(url).origin, serviceUrl);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.redirect, 'error');
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.match(body.id, /^[a-f0-9]{64}$/);
      assert.match(body.content, /^[A-Za-z0-9_-]+$/);
      if (options.status) return new Response('{}', {status:options.status});
      const existing = data.get(body.id);
      assert.ok(existing === undefined || existing === body.content);
      data.set(body.id, body.content);
      if (options.afterWrite) options.afterWrite(body);
      if (lostReply) { lostReply = false; throw new TypeError('Reply lost'); }
      return Response.json({id:options.wrongId ? 'b'.repeat(64) : body.id}, {status:201});
    }
    assert.equal(init.method, 'GET');
    const id = new URL(url).pathname.split('/').pop();
    if (!data.has(id)) return new Response('', {status:404});
    return new Response(options.corrupt ? data.get(id).slice(0, -2) + 'aa' : data.get(id));
  };
  return {data, calls, fetchImpl, options:{serviceUrl, viewerUrl, crypto:webcrypto, fetchImpl}};
}

test('one and fifty products use equal length short URLs and preserve every exact card value', async () => {
  let length;
  for (const count of [1, 50]) {
    const h = harness(), token = encoded(count);
    const address = await client.create(token, h.options);
    const url = new URL(address), key = url.searchParams.get('n');
    assert.equal(url.origin, 'https://joewu1024.github.io');
    assert.equal(url.pathname, '/---2/s.html');
    assert.equal(url.searchParams.size, 1);
    assert.equal(url.hash, '');
    assert.match(key, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(address.length, length || address.length);
    length = address.length;
    const restored = await client.open(key, h.options);
    assert.equal(restored, token);
    assert.deepEqual(codec.decode(restored).products, products(count));
    const upload = JSON.parse(h.calls.find(call => call.init.method === 'POST').init.body);
    assert.deepEqual(Object.keys(upload), ['id', 'content']);
    assert.ok(!upload.content.includes(token) && !upload.content.includes(key));
    assert.ok(!h.calls[1].url.includes(key));
  }
});

test('lost upload acknowledgement retries the same immutable snapshot and ID', async () => {
  const h = harness({lostReply:true});
  const address = await client.create(encoded(2), h.options);
  const posts = h.calls.filter(call => call.init.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].init.body, posts[1].init.body);
  assert.equal(h.data.size, 1);
  assert.match(address, /\?n=/);
});

test('a failed or inconsistent save never exposes a successful short URL', async () => {
  for (const options of [{status:403}, {status:503}, {wrongId:true}, {corrupt:true}]) {
    const h = harness(options);
    await assert.rejects(client.create(encoded(1), h.options), /暂时不可用|未完成|校验失败/);
    const posts = h.calls.filter(call => call.init.method === 'POST');
    assert.equal(posts.length, options.status === 503 ? 2 : 1);
  }
});

test('wrong keys, missing records and damaged ciphertext fail with readable messages', async () => {
  const h = harness(), address = await client.create(encoded(1), h.options);
  const key = new URL(address).searchParams.get('n');
  await assert.rejects(client.open('A'.repeat(22), h.options), /没有找到/);
  const ciphertext = [...h.data.values()][0];
  const wrongKeyFetch = async () => new Response(ciphertext);
  await assert.rejects(client.open('B'.repeat(21) + 'A', {...h.options,fetchImpl:wrongKeyFetch}), /校验失败/);
  for (const content of ['<html>error</html>', 'A'.repeat(38), ciphertext.slice(0, -4)]) {
    await assert.rejects(client.open(key, {...h.options,fetchImpl:async () => new Response(content)}), /无法读取|校验失败/);
  }
  await assert.rejects(client.open(key + '…', h.options), /网址不完整/);
});

test('dataset changes stop submission or suppress the completed link', async () => {
  const h = harness();
  await assert.rejects(client.create(encoded(1), {...h.options,isCurrent:() => false}), /工作区已变更/);
  assert.equal(h.calls.length, 0);
  let current = true;
  const changed = harness({afterWrite:() => { current = false; }});
  await assert.rejects(client.create(encoded(1), {...changed.options,isCurrent:() => current}), /工作区已变更/);
  assert.equal(changed.calls.length, 1);
  assert.equal(changed.calls[0].init.method, 'POST');
});

test('bad tokens and unapproved service or viewer destinations never receive a request', async () => {
  const h = harness();
  for (const token of ['', 'xInvalid', 'cA&tracking=evil', 'c' + 'A'.repeat(2000000)]) {
    await assert.rejects(client.create(token, h.options), /格式无效|内容过大/);
  }
  for (const endpoint of [
    'http://buyer-share-test.netlify.app', 'https://attacker.test',
    'https://buyer-share-test.netlify.app/path', 'https://user:pass@buyer-share-test.netlify.app',
    serviceUrl + '?redirect=other'
  ]) await assert.rejects(client.create(encoded(1), {...h.options,serviceUrl:endpoint}), /尚未配置/);
  await assert.rejects(client.create(encoded(1), {...h.options,viewerUrl:'https://attacker.test/'}), /页面地址配置无效/);
  assert.equal(h.calls.length, 0);
});

test('plain and gzip legacy tokens remain byte-for-byte exact', async () => {
  for (const token of ['jAbCd_-0123', 'zAaBbCc123_--']) {
    const h = harness(), address = await client.create(token, h.options);
    assert.equal(await client.open(new URL(address).searchParams.get('n'), h.options), token);
  }
});

test('browser reader works without native text codecs and with strict padded Base64 decoding', async () => {
  const h = harness(), token = encoded(2);
  const address = await client.create(token, h.options);
  const sandbox = {
    URL, Uint8Array, ArrayBuffer, AbortController, setTimeout, clearTimeout, crypto:webcrypto,
    btoa:text => Buffer.from(text, 'latin1').toString('base64'),
    atob:text => {
      assert.equal(text.length % 4, 0);
      return Buffer.from(text, 'base64').toString('latin1');
    }
  };
  const source = fs.readFileSync(path.join(__dirname,'../online-share-client.js'),'utf8');
  vm.runInNewContext(source, sandbox);
  assert.equal(await sandbox.BuyerOnlineShare.open(new URL(address).searchParams.get('n'), h.options), token);
});
