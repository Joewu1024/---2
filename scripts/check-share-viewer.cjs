'use strict';
// Offline fixtures only. Optional real-link checks print counts, never product data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const githubShare = require('../github-share.js');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'share.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
const product = {
  id: 'DEMO-42', itemChinese: '示例风扇 🌿 – Bộ mới', modelChinese: '5pcs',
  target: '0', category: '家居', invitation: 'DEMO',
  model: 'https://example.test/model.jpg', shopee: '查看', shopeeUrl: 'https://example.test/item',
  badges: [{ kind: 'crown', icon: '★', text: '示例' }]
};
const payload = { v: 1, products: [product] };
const token = (value = payload, mode = 'z') => mode + (mode === 'z' ? zlib.gzipSync(Buffer.from(JSON.stringify(value))) : Buffer.from(JSON.stringify(value))).toString('base64url');
const gzipToken = bytes => 'z' + Buffer.from(bytes).toString('base64url');

function viewer(options = {}) {
  const elements = { summary: { textContent: '' }, cards: { innerHTML: '' } };
  const sandbox = {
    URL, URLSearchParams, Uint8Array, Uint16Array, Uint32Array, ArrayBuffer,
    atob: text => Buffer.from(text, 'base64').toString('latin1'),
    location: { search: options.search || '', hash: options.hash || '' },
    document: { title: '', getElementById: id => elements[id] },
    fetch: options.fetch || (() => { throw new Error('Complete share URLs must not fetch'); }),
    crypto: crypto.webcrypto, setTimeout, clearTimeout, AbortController
  };
  if (options.textDecoder !== false) sandbox.TextDecoder = TextDecoder;
  if (options.Blob) sandbox.Blob = options.Blob;
  if (options.DecompressionStream) sandbox.DecompressionStream = options.DecompressionStream;
  Object.defineProperty(sandbox, 'localStorage', { get() { throw new Error('Viewer must not use localStorage'); } });
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  for (const script of scripts) {
    const source = script[2];
    const at = source.indexOf('\nload().catch');
    vm.runInContext(at < 0 ? source : source.slice(0, at), context, { filename: 'share.html' });
  }
  return { context, elements };
}

const tests = [];
const test = (name, run) => tests.push({ name, run });
const plain = result => JSON.parse(JSON.stringify(result));
async function rejectsToken(raw, pattern = /损坏|格式|版本|缺少|没有产品|过大/, options) {
  await assert.rejects(viewer(options).context.decodeSharePayload(raw), pattern);
}

test('fixed official vendor is embedded exactly, with MIT and SHA-256 provenance', () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'vendor/fflate-0.8.3-source.json'), 'utf8'));
  assert.equal(metadata.version, '0.8.3');
  assert.equal(metadata.source, 'https://registry.npmjs.org/fflate/-/fflate-0.8.3.tgz');
  for (const name of ['fflate-0.8.3.min.js', 'LICENSE.fflate']) {
    const bytes = fs.readFileSync(path.join(root, 'vendor', name));
    assert.equal(bytes.length, metadata.files[name].bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), metadata.files[name].sha256);
  }
  const embedded = scripts.find(script => script[1].includes('data-buyer-share-gzip="fflate-0.8.3"'));
  assert.ok(embedded && embedded[2].includes(fs.readFileSync(path.join(root, 'vendor/fflate-0.8.3.min.js'), 'utf8')));
  assert.ok(embedded[2].includes('Permission is hereby granted, free of charge'));
  assert.equal(scripts.length, 3);
  const sealed = scripts.find(script => script[1].includes('data-buyer-github-share="v1"'));
  assert.equal(sealed[2].trim(), fs.readFileSync(path.join(root, 'github-share.js'), 'utf8').trim());
  assert.ok(!/<script\b[^>]*\bsrc\s*=/i.test(html));
  assert.ok(!/\b(?:fetch|XMLHttpRequest|localStorage|sessionStorage)\s*[.(]/.test(scripts.at(-1)[2]));
});

test('one product and a batch have the same length short URL and render from a public encrypted file', async () => {
  for (const count of [1, 11]) {
    const products = Array.from({ length: count }, (_, i) => ({ ...product, id: 'DEMO-' + i }));
    const archived = await githubShare.seal(token({ v: 1, products }), crypto.webcrypto);
    assert.equal(archived.key.length, 22);
    assert.equal(archived.id.length, 64);
    assert.ok(!archived.content.includes(archived.key) && !archived.content.includes(token({ v: 1, products })));
    let reads = 0;
    const { context, elements } = viewer({
      hash: '#s=' + archived.key,
      fetch(url, options) {
        reads++;
        assert.equal(url, 'https://joewu1024.github.io/---2/p/data/' + archived.id + '.txt');
        assert.equal(options.referrerPolicy, 'no-referrer');
        return { ok: true, text: async () => archived.content };
      }
    });
    assert.equal(await context.load(), count);
    assert.equal(reads, 1);
    assert.match(elements.cards.innerHTML, /示例风扇 🌿 – Bộ mới/);
    assert.match(elements.cards.innerHTML, /5pcs/);
    assert.equal((elements.cards.innerHTML.match(/class="product"/g) || []).length, count);
  }
});

test('bad or missing short snapshot fails with a readable error', async () => {
  const archived = await githubShare.seal(token(), crypto.webcrypto);
  const missing = viewer({ hash: '#s=' + archived.key, fetch: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(missing.context.load(), /没有找到这份分享/);
  const corrupted = viewer({ hash: '#s=' + archived.key, fetch: async () => ({ ok: true, text: async () => archived.content + 'abc' }) });
  await assert.rejects(corrupted.context.load(), /无法读取/);
});

test('gzip works with DecompressionStream, Blob and TextDecoder all absent', async () => {
  const { context } = viewer({ textDecoder: false });
  assert.deepEqual(plain(await context.decodeSharePayload(token())), payload);
});

test('native constructor failure falls back', async () => {
  let calls = 0;
  const { context } = viewer({ Blob, DecompressionStream: class { constructor() { calls++; throw new Error('unsupported gzip'); } } });
  assert.deepEqual(plain(await context.decodeSharePayload(token())), payload);
  assert.equal(calls, 1);
});

test('old Blob implementation without stream falls back', async () => {
  const { context } = viewer({ Blob: class {}, DecompressionStream });
  assert.deepEqual(plain(await context.decodeSharePayload(token())), payload);
});

test('native read failure cancels the stream and uses offline fallback', async () => {
  let cancelled = 0, released = 0;
  const fakeBlob = class { stream() { return { pipeThrough() { return { getReader() { return {
    async read() { throw new Error('stream failed'); }, async cancel() { cancelled++; }, releaseLock() { released++; }
  }; } }; } }; } };
  const { context } = viewer({ Blob: fakeBlob, DecompressionStream: class {} });
  assert.deepEqual(plain(await context.decodeSharePayload(token())), payload);
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
});

test('working native stream does not run the fallback', async () => {
  const { context } = viewer({ Blob, DecompressionStream });
  context.offlineShareGunzip = () => { throw new Error('unnecessary fallback'); };
  assert.deepEqual(plain(await context.decodeSharePayload(token())), payload);
});

test('Unicode, astral characters and long chunk boundaries survive fallback', async () => {
  const data = { v: 1, products: [{ ...product, itemChinese: '越南语 Bộ mẫu mới · 中文 😀 𠮷 é\n'.repeat(1400) }] };
  const { context } = viewer({ textDecoder: false });
  assert.deepEqual(plain(await context.decodeSharePayload(token(data))), data);
});

test('uncompressed j payload and legacy envelope without v remain supported', async () => {
  const data = { products: [{ ...product, itemChinese: '', modelChinese: 'overseas model' }] };
  assert.deepEqual(plain(await viewer({ textDecoder: false }).context.decodeSharePayload(token(data, 'j'))), data);
});

test('legacy query v supports both j and z with query parameters', async () => {
  for (const mode of ['j', 'z']) {
    const { context, elements } = viewer({ search: '?other=1&v=' + encodeURIComponent(token(payload, mode)) + '&after=2' });
    assert.equal(await context.load(), 1);
    assert.match(elements.summary.textContent, /1 个产品/);
    assert.match(elements.cards.innerHTML, /5pcs/);
  }
});

test('fragment d is decoded as a parameter and ignores other fragment fields', async () => {
  const raw = token();
  const { context, elements } = viewer({ hash: '#before=1&d=' + encodeURIComponent(raw).replace(/^z/, '%7A') + '&after=2' });
  assert.equal(context.readShareToken(), raw);
  assert.equal(await context.load(), 1);
  assert.match(elements.cards.innerHTML, /示例风扇/);
  assert.match(context.document.title, /1 个产品/);
});

test('query v retains precedence over fragment d', async () => {
  const data = { products: [{ ...product, modelChinese: 'query model' }] };
  const { context } = viewer({ search: '?v=' + token(data, 'j'), hash: '#d=' + token() });
  assert.deepEqual(plain(await context.decodeSharePayload(context.readShareToken())), data);
});

test('snapshot fields, blank values and safe link rendering are unchanged', async () => {
  const data = { products: [{ ...product, itemChinese: '', modelChinese: '5pcs', invitation: 'DEMO-INVITE', target: 0 }] };
  const { context, elements } = viewer({ hash: '#d=' + token(data) });
  await context.load();
  assert.match(elements.cards.innerHTML, /未填写/);
  for (const text of ['5pcs', '目标价', '上新类目', '邀请ID', 'DEMO-INVITE', 'noopener']) assert.ok(elements.cards.innerHTML.includes(text));
  assert.match(elements.summary.textContent, /分享时内容快照/);
});

test('original card signatures still escape text and reject executable URLs', () => {
  const { context } = viewer();
  assert.equal(context.card.length, 2);
  assert.equal(context.chineseField.length, 2);
  const card = context.card({ ...product, itemChinese: '<img src=x onerror=alert(1)>', model: 'javascript:alert(1)', shopeeUrl: 'javascript:alert(1)', badges: [{ kind: '" onclick="bad', icon: '<', text: '<script>' }] }, 0);
  assert.ok(!card.includes('<script>') && !card.includes('<img src=x') && !card.includes('href="javascript:'));
  assert.match(card, /&lt;img/);
});

test('standard base64 with percent-encoded query also remains readable', async () => {
  const raw = 'j' + Buffer.from(JSON.stringify(payload)).toString('base64');
  const { context } = viewer({ search: '?v=' + encodeURIComponent(raw) });
  assert.deepEqual(plain(await context.decodeSharePayload(context.readShareToken())), payload);
});

test('unknown modes, missing tokens and malformed base64 are rejected', async () => {
  for (const raw of ['', 'x' + token().slice(1), 'j', 'jA', 'jab=c', 'j====', 'jAA===', 'j!!', 'jYQ=']) await rejectsToken(raw);
});

test('malformed JSON and incompatible payloads are rejected', async () => {
  await rejectsToken('j' + Buffer.from('{').toString('base64url'));
  for (const value of [null, [], {}, { v: 2, products: [product] }, { products: 'bad' }, { products: [] }, { products: [null] }, { products: ['bad'] }, { products: [[]] }]) await rejectsToken(token(value));
});

test('invalid and truncated UTF-8 are rejected without TextDecoder', async () => {
  for (const bytes of [[0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
    const raw = Buffer.concat([Buffer.from('{"products":[{"itemChinese":"'), Buffer.from(bytes), Buffer.from('"}]}')]);
    await rejectsToken('j' + raw.toString('base64url'), /损坏/, { textDecoder: false });
  }
});

test('gzip CRC32, ISIZE, reserved flags, compression method and truncation are checked', async () => {
  const original = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  const corruptions = [];
  for (const at of [original.length - 8, original.length - 4, 0, 2]) {
    const altered = Buffer.from(original); altered[at] ^= 1; corruptions.push(altered);
  }
  const reserved = Buffer.from(original); reserved[3] |= 0x20; corruptions.push(reserved);
  corruptions.push(original.subarray(0, 8), original.subarray(0, original.length - 1), original.subarray(0, original.length - 9));
  for (const bytes of corruptions) await rejectsToken(gzipToken(bytes));
});

test('native rejection of corrupted gzip is not bypassed by the JS decoder', async () => {
  const corrupt = zlib.gzipSync(Buffer.from(JSON.stringify(payload))); corrupt[corrupt.length - 8] ^= 1;
  await rejectsToken(gzipToken(corrupt), /损坏/, { Blob, DecompressionStream });
});

test('concatenated gzip members and trailing junk are rejected', async () => {
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  await rejectsToken(gzipToken(Buffer.concat([bytes, bytes])));
  for (const trailing of [Buffer.from([0]), Buffer.from('junk'), Buffer.alloc(20)]) await rejectsToken(gzipToken(Buffer.concat([bytes, trailing])));
});

test('unterminated gzip optional filename is rejected', async () => {
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify(payload))); bytes[3] |= 8;
  await rejectsToken(gzipToken(Buffer.concat([bytes.subarray(0, 10), Buffer.alloc(20, 65), bytes.subarray(bytes.length - 8)])));
});

test('gzip optional extra, filename, comment and header CRC are supported', async () => {
  const { context } = viewer();
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  const header = Buffer.concat([bytes.subarray(0, 10), Buffer.from([3, 0, 11, 22, 33]), Buffer.from('demo.json\0offline fixture\0')]);
  header[3] = 4 | 8 | 16 | 2;
  const crc = context.shareCrc32(header) & 65535;
  const optional = Buffer.concat([header, Buffer.from([crc & 255, crc >> 8]), bytes.subarray(10)]);
  assert.deepEqual(plain(await context.decodeSharePayload(gzipToken(optional))), payload);
  optional[header.length] ^= 1;
  await rejectsToken(gzipToken(optional));
});

test('token length and declared expansion limits fail before decoding', async () => {
  const { context } = viewer();
  context.SHARE_MAX_TOKEN_LENGTH = 20;
  await assert.rejects(context.decodeSharePayload('j' + 'A'.repeat(21)), /过大/);
  const bytes = zlib.gzipSync(Buffer.from(JSON.stringify(payload))); bytes.writeUInt32LE(33554433, bytes.length - 4);
  await rejectsToken(gzipToken(bytes), /过大/);
});

test('forged small ISIZE cannot bypass the streaming expansion limit', async () => {
  const bytes = zlib.gzipSync(Buffer.from('A'.repeat(8192))); bytes.writeUInt32LE(1, bytes.length - 4);
  const { context } = viewer(); context.SHARE_MAX_DECODED_BYTES = 512;
  await assert.rejects(context.decodeSharePayload(gzipToken(bytes)), /过大/);
});

test('boot error rendering remains escaped and does not expose the input URL', async () => {
  const { context, elements } = viewer({ hash: '#d=jinvalid<script>' });
  const main = scripts.at(-1)[2];
  vm.runInContext(main.slice(main.indexOf('\nload().catch')), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.summary.textContent, '无法显示分享内容');
  assert.ok(elements.cards.innerHTML.includes('emptyState'));
  assert.ok(!elements.cards.innerHTML.includes('<script>') && !elements.cards.innerHTML.includes('jinvalid'));
});

(async () => {
  let passed = 0;
  for (const { name, run } of tests) {
    try { await run(); passed++; }
    catch (error) { console.error('FAIL: ' + name); throw error; }
  }
  console.log('share-viewer: ' + passed + '/' + tests.length + ' offline checks passed');
  const realFile = process.env.BUYER_SHARE_VIEWER_REAL_URL_FILE;
  if (realFile) {
    // Local opt-in only: the URL and decoded product fields never enter output or fixtures.
    try {
      const url = new URL(fs.readFileSync(realFile, 'utf8').trim());
      const { context, elements } = viewer({ search: url.search, hash: url.hash, textDecoder: false });
      const count = await context.load();
      if (process.env.BUYER_SHARE_VIEWER_EXPECTED_COUNT && count !== Number(process.env.BUYER_SHARE_VIEWER_EXPECTED_COUNT)) throw new Error('count mismatch');
      assert.equal((elements.cards.innerHTML.match(/<article class="product">/g) || []).length, count);
      console.log(JSON.stringify({ realLink: 'local opt-in', cards: count, mode: context.readShareToken().charAt(0), nativeDecompression: false, textDecoder: false }));
    } catch (error) { throw new Error('Real-link compatibility check failed; private input omitted'); }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
