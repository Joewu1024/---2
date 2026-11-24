'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const transport = require('../product-share-transport.js');
const codec = require('../product-share-codec.js');

const base = 'https://joewu1024.github.io/---2/';
const products = [{ id: 'TEST-01', itemChinese: '示例遥控器', modelChinese: 'RT-86 黑色', target: '0' }];
const compact = codec.encode(products);
const payload = value => ({ kind: 'payload', value });
const archiveKey = 'a'.repeat(22);

test('new links carry the exact compressed snapshot in a short query URL', () => {
  const url = transport.url(base + 'index.html?workspace=hidden#old', compact);
  assert.equal(url, base + 's.html?d=' + compact);
  assert.equal(new URL(url).hash, '');
  const result = transport.read(new URL(url));
  assert.deepEqual(result, payload(compact));
  assert.equal(codec.decode(result.value).products[0].modelChinese, products[0].modelChinese);
});

test('previous direct and archived URLs resolve without reinterpretation', () => {
  const legacy = 'zAb+/AB==';
  for (const input of [
    base + 'share.html#' + compact,
    base + 'share.html#d=' + compact,
    base + 's.html?d=' + compact + '&from=singlemessage#ignored',
    '#' + compact,
    compact
  ]) assert.deepEqual(transport.read(input), payload(compact));
  for (const input of [
    { search: '?v=' + encodeURIComponent(legacy), hash: '#d=' + compact },
    { search: '?v=' + legacy },
    { hash: '#d=' + legacy }
  ]) assert.deepEqual(transport.read(input), payload(legacy));
  assert.deepEqual(transport.read(base + 'share.html#s=' + archiveKey), {kind:'archive', value:archiveKey});
  assert.deepEqual(transport.read(base + 's.html?s=' + archiveKey), {kind:'archive', value:archiveKey});
});

test('pasting a wrapped or percent-encoded copy yields the unaltered code', () => {
  const generated = transport.url(base, compact);
  const cut = Math.floor(generated.length / 2);
  const wrapped = '<' + generated.slice(0, cut) + '\r\n \u200B' + generated.slice(cut) + '>';
  assert.deepEqual(transport.read(wrapped), payload(compact));
  assert.deepEqual(transport.read(encodeURIComponent(generated)), payload(compact));
  assert.deepEqual(transport.read({search: '?d=c%2520' + compact.slice(1)}), payload(compact));
});

test('distinguishes missing data, detectable truncation, and invalid input', () => {
  assert.deepEqual(transport.read(base + 's.html?from=singlemessage'), {kind:'missing'});
  for (const query of ['?d=', '?d=cA', '?d=' + compact.slice(0, 14) + '…']) {
    assert.throws(() => transport.read({search:query}), { code:'incomplete' });
  }
  for (const query of ['?d=c$xyz', '?d=c%j', '?d=' + compact + '&d=' + compact + 'x']) {
    assert.throws(() => transport.read({search:query}), { code:'invalid' });
  }
  assert.throws(() => transport.read({hash:'#s=abc'}), { code:'incomplete' });
  assert.throws(() => transport.read({search:'?d=c' + 'A'.repeat(2000000)}), { code:'too_large' });
});

test('fifty products produce bounded links with exact ordered coverage', () => {
  const batch = Array.from({length:50}, (_, i) => ({
    id: String(10000 + i),
    modelChinese: '示例型号 ' + i,
    model: 'https://example.test/' + createHash('sha256').update(String(i)).digest('hex') + '.png'
  }));
  const links = transport.splitProducts(base, batch, codec.encode);
  assert.ok(links.length > 1 && links.length < batch.length);
  assert.ok(links.every(link => link.length <= 1800));
  const restored = links.flatMap(link => codec.decode(transport.read(link).value).products);
  assert.deepEqual(restored, codec.decode(codec.encode(batch)).products);
});

test('singletons that cannot fit produce a full-snapshot fallback, never partial links', () => {
  const impossible = { id:'oversized' };
  const encode = batch => {
    if (batch.includes(impossible)) throw new Error('分享数据过大，请分批生成分享链接');
    return codec.encode(batch);
  };
  assert.deepEqual(transport.splitProducts(base, [...products, impossible], encode), []);
  assert.deepEqual(transport.splitProducts(base, products, codec.encode, 25), []);
  assert.throws(() => transport.splitProducts(base, products, () => { throw new Error('BOOM'); }), /BOOM/);
});
