'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');
const zlib = require('node:zlib');
const codec = require('../product-share-codec.js');

const product = {
  id:'00041818940564',
  itemChinese:' 智能电视遥控器 🎉\n适用型号 HTV-9 ',
  modelChinese:'5pcs',
  target:'0.00',
  category:'家用电器 > 遥控器',
  invitation:'000512',
  model:'https://cf.shopee.com.br/file/ab3456',
  shopee:'https://shopee.com.br/product/23456789/9876543210',
  shopeeUrl:'https://shopee.com.br/product/23456789/9876543210',
  badges:[
    {kind:'diamond', icon:'💎', text:'150%投流'},
    {kind:'crown', icon:'👑', text:'运营重点主推款'},
    {kind:'custom', icon:'✨', text:'保留其他标识'}
  ]
};

test('preserves every card field, exact text, badges, duplicate fields and blanks', () => {
  const products = [
    product,
    {...product, id:'000004', itemChinese:'', target:'', modelChinese:'', model:'', badges:[],
      category:'', invitation:'', shopee:'', shopeeUrl:''},
    {...product, modelChinese:product.itemChinese, shopee:'完整原始链接文字', shopeeUrl:'http://example.org/p?x=1&z=2'}
  ];
  const token = codec.encode(products);
  assert.match(token, /^c[A-Za-z0-9_-]+$/);
  assert.deepEqual(codec.decode(token), {v:1, products});
});

test('round-trips image data and a batch larger than a single compressed input chunk', () => {
  const imageBytes = Buffer.concat(Array.from({length:120}, (_, i) =>
    createHash('sha256').update(String(i)).digest()
  ));
  const products = [
    {...product, model:'data:image/webp;base64,' + imageBytes.toString('base64')},
    ...Array.from({length:200}, (_, i) => ({
      ...product, id:String(i), itemChinese:'商品 ' + i + ' 種類 Télécommande 📦', badges:[]
    }))
  ];
  const encoded = codec.encode(products);
  assert.ok(encoded.length > 2048);
  assert.deepEqual(codec.decode(encoded), {v:1, products});
});

function browserCodec(overrides = {}) {
  const context = vm.createContext({atob, TextEncoder:undefined, TextDecoder:undefined, DecompressionStream:undefined, ...overrides});
  const root = path.resolve(__dirname, '..');
  for (const file of ['vendor/fflate-0.8.3.min.js', 'product-share-codec.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {filename:file});
  }
  return context.BuyerShareCodec;
}

test('decodes in a browser context without native text codecs or decompression', () => {
  const decoded = browserCodec().decode(codec.encode([product]));
  assert.deepEqual(JSON.parse(JSON.stringify(decoded)), {v:1, products:[product]});
});

test('WebViews requiring Base64 padding can decode an intact unpadded URL', () => {
  const products = [product];
  const token = codec.encode(products);
  assert.notEqual((token.length - 1) % 4, 0);
  let input;
  const mobile = browserCodec({
    atob(value) {
      input = value;
      if (value.length % 4 !== 0) throw new Error('Base64 padding required');
      return atob(value);
    }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(mobile.decode(token))), {v:1, products});
  assert.match(input, /=+$/);
});

test('WebViews with an unusable TextDecoder still display exact multilingual text', () => {
  let nativeCalls = 0;
  const mobile = browserCodec({
    TextDecoder: class {
      decode() {
        nativeCalls++;
        throw new Error('TextDecoder unsupported');
      }
    }
  });
  const products = [{...product, itemChinese:'遥控器 / Điều khiển 🎉 \uFFFD'}];
  assert.deepEqual(JSON.parse(JSON.stringify(mobile.decode(codec.encode(products)))), {v:1, products});
  assert.ok(nativeCalls >= 2, 'vendor probe and data decode reached the stub');
});

// A zlib stream has the same Adler-32 checksum and DEFLATE data as the packet,
// with a separate two-byte zlib header.
function packetFor(bytes) {
  const stream = zlib.deflateSync(bytes);
  return 'c' + Buffer.concat([stream.subarray(-4), stream.subarray(2, -4)]).toString('base64url');
}

test('the strict fallback rejects malformed UTF-8 even when its checksum matches', () => {
  const corrupt = Buffer.concat([Buffer.from('[["id","'), Buffer.from([0xf0, 0x80, 0x80, 0x80]), Buffer.from('"]]')]);
  const token = packetFor(corrupt);
  const ignoresFatal = class {
    decode(bytes) { return new TextDecoder().decode(bytes); }
  };
  for (const implementation of [codec, browserCodec(), browserCodec({TextDecoder:ignoresFatal})]) {
    assert.throws(() => implementation.decode(token), /损坏|无效/);
  }
});

test('rejects damaged tokens and snapshots with invalid card fields', () => {
  const token = codec.encode([product]);
  const damaged = token.slice(0, 1) + (token[1] === 'A' ? 'B' : 'A') + token.slice(2);
  for (const value of ['', 'c1', 'c!', token.slice(0, -4), damaged, packetFor('[]'),
    packetFor('[["id", {"bad": 1}]]'), packetFor('[[]]')]) {
    assert.throws(() => codec.decode(value), /损坏|无效/);
  }
});

test('bounds both malformed oversized tokens and compressed expansion', () => {
  assert.throws(() => codec.decode('c' + 'A'.repeat(2000000)), /分享数据过大/);
  const expanded = Buffer.alloc(32 * 1024 * 1024 + 4, 0x41);
  assert.throws(() => codec.decode(packetFor(expanded)), /分享数据过大/);
});

test('new tokens are shorter than the original compressed snapshots', () => {
  for (const count of [1,8]) {
    const products = Array.from({length:count}, (_, i) => ({
      ...product, id:String(41818940564 + i),
      shopee:'https://shopee.com.br/product/23456789/' + (9876543210 + i),
      shopeeUrl:'https://shopee.com.br/product/23456789/' + (9876543210 + i)
    }));
    const oldLength = 1 + zlib.gzipSync(JSON.stringify({v:1, products})).toString('base64url').length;
    const newLength = codec.encode(products).length;
    assert.ok(newLength < oldLength, 'batch ' + count + ' saves characters');
    console.log('Synthetic ' + count + ' product(s) ' + oldLength + ' -> ' + newLength + ' token characters');
  }
});
