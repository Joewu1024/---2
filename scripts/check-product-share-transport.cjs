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

test('new links carry the exact compressed snapshot in a query URL', () => {
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

test('long selections exceed the workbench budget while older URLs remain readable', () => {
  const batch = Array.from({length:50}, (_, i) => {
    const image = createHash('sha256').update(String(i)).digest('hex');
    const details = createHash('sha256').update('title:' + i).digest('hex');
    const shopee = 'https://shopee.com.my/product/100005/' + parseInt(details.slice(-12), 16);
    return {
      id: String(10000 + i),
      itemChinese: '示例产品 ' + i + ' ' + details.slice(0, 53),
      modelChinese: '示例型号 ' + i,
      model: 'https://example.test/' + image + '.png',
      category: '家用电器',
      target: String(i + 1),
      shopee,
      shopeeUrl: shopee
    };
  });
  assert.equal(transport.singleProductUrl(base, batch, codec.encode), '');
  const url = transport.singleProductUrl(base, batch, codec.encode, 7600);
  assert.ok(url.length >= 6500 && url.length <= 7200, 'fixture must exercise a representative long link');
  assert.equal(url.includes('\n'), false);
  const forwarded = new URL(url);
  forwarded.searchParams.append('from', 'singlemessage');
  const restored = codec.decode(transport.read(forwarded).value).products;
  assert.equal(restored.length, 50);
  assert.deepEqual(restored, codec.decode(codec.encode(batch)).products);
});

test('single-link budget includes the complete absolute URL', () => {
  const nestedBase = base + 'qa/';
  const prefixLength = (nestedBase + 's.html?d=c').length;
  const withLength = length => () => 'c' + 'A'.repeat(length - prefixLength);
  assert.equal(transport.singleProductUrl(nestedBase, products, withLength(1800)).length, 1800);
  assert.equal(transport.singleProductUrl(nestedBase, products, withLength(1801)), '');
});

test('oversized selections do not produce a potentially truncated URL', () => {
  const impossible = { id:'oversized' };
  const encode = batch => {
    if (batch.includes(impossible)) throw new Error('分享数据过大，请分批生成分享链接');
    return codec.encode(batch);
  };
  assert.equal(transport.singleProductUrl(base, [...products, impossible], encode), '');
  assert.equal(transport.singleProductUrl(base, products, codec.encode, 25), '');
  assert.throws(() => transport.singleProductUrl(base, products, () => { throw new Error('BOOM'); }), /BOOM/);
});
