import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker, { escapeHtml, trustedImageUrl, imageSignature, sanitizeProducts, randomId } from '../worker.mjs';

const API = 'https://buyer-share.test';
const ORIGIN = 'https://joewu1024.github.io';
const WRITERS = '/api/writers';
const SHARES = '/api/shares';
const fixture = () => ({ id: 'DEMO-001', model: '', itemChinese: '示例产品甲', modelChinese: '5pcs', category: '家用电器 > 遥控器', invitation: '', target: '50.00', shopee: '查看示例商品', shopeeUrl: 'https://example.test/item', badges: [{ kind: 'crown', icon: '★', text: '示例卖点' }] });
const clone = value => JSON.parse(JSON.stringify(value));

class D1Memory {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    const migrationDir = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(migrationDir).filter(name => name.endsWith('.sql')).sort()) this.sqlite.exec(readFileSync(new URL(file, migrationDir), 'utf8'));
  }
  prepare(sql) {
    const database = this;
    const make = parameters => {
      const statement = {
        sql, parameters,
        bind(...values) { return make(values); },
        execute() {
          const compiled = database.sqlite.prepare(sql);
          if (compiled.columns().length) return { success: true, results: compiled.all(...parameters), meta: { changes: database.sqlite.prepare('SELECT changes() AS n').get().n } };
          const result = compiled.run(...parameters);
          return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        },
        async run() { return statement.execute(); },
        async all() { return statement.execute(); },
        async first(column) {
          const row = database.sqlite.prepare(sql).get(...parameters);
          return row == null ? null : column ? row[column] : row;
        }
      };
      return statement;
    };
    return make([]);
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const result = statements.map(statement => statement.execute()); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  async exec(sql) { this.sqlite.exec(sql); return { count: 1, duration: 0 }; }
  close() { this.sqlite.close(); }
}

class R2Memory {
  objects = new Map();
  failPut = false;
  async put(key, value, options = {}) {
    if (this.failPut) throw new Error('Simulated durable storage outage');
    const bytes = typeof value === 'string' ? Buffer.from(value) : value instanceof ArrayBuffer ? Buffer.from(value) : ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(await new Response(value).arrayBuffer());
    const etag = createHash('sha256').update(bytes).digest('hex');
    const object = { key, bytes: Buffer.from(bytes), size: bytes.length, etag, httpEtag: '"' + etag + '"', uploaded: new Date(), httpMetadata: { ...options.httpMetadata }, customMetadata: { ...options.customMetadata } };
    this.objects.set(key, object);
    return object;
  }
  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { ...object, bytes: Buffer.from(object.bytes), body: new Response(object.bytes).body, async arrayBuffer() { return Uint8Array.from(object.bytes).buffer; }, async text() { return object.bytes.toString('utf8'); }, writeHttpMetadata(headers) { if (object.httpMetadata.contentType) headers.set('Content-Type', object.httpMetadata.contentType); if (object.httpMetadata.cacheControl) headers.set('Cache-Control', object.httpMetadata.cacheControl); } };
  }
  async head(key) { const value = await this.get(key); return value ? { ...value, body: undefined } : null; }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key); }
  async list({ prefix = '', limit = 1000 } = {}) { return { objects: [...this.objects.values()].filter(value => value.key.startsWith(prefix)).slice(0, limit), truncated: false }; }
}

function setup(overrides = {}) {
  const DB = new D1Memory(), BUCKET = new R2Memory();
  return { DB, BUCKET, env: { DB, BUCKET, ALLOWED_ORIGINS: ORIGIN, ...overrides } };
}
async function request(env, path, { method = 'GET', body, token, origin = method === 'GET' ? null : ORIGIN, headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  if (origin) requestHeaders.set('Origin', origin);
  if (token) requestHeaders.set('Authorization', 'Bearer ' + token);
  if (body !== undefined && !requestHeaders.has('Content-Type')) requestHeaders.set('Content-Type', 'application/json');
  const input = new Request(API + path, { method, headers: requestHeaders, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  return worker.fetch(input, env, { waitUntil() {} });
}
async function writer(env) {
  const response = await request(env, WRITERS, { method: 'POST', body: {} });
  const value = await response.json();
  assert.equal(response.status, 201, JSON.stringify(value));
  assert.match(value.token, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  return value.token;
}
async function share(env, token, products = [fixture()], requestId = randomId()) {
  const response = await request(env, SHARES, { method: 'POST', token, body: { v: 1, products, requestId } });
  const value = await response.json();
  return { response, value, requestId };
}
async function withFetch(implementation, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = implementation;
  try { return await run(); } finally { globalThis.fetch = previous; }
}

function injectCommittedResponseLoss(DB, { failStateReads = false } = {}) {
  const originalPrepare = DB.prepare.bind(DB);
  const state = { committedResponseLost: false, failedReads: 0, allowReads() { failStateReads = false; } };
  DB.prepare = sql => {
    const wrap = statement => ({
      ...statement,
      bind(...parameters) { return wrap(statement.bind(...parameters)); },
      async run() {
        const result = await statement.run();
        if (!state.committedResponseLost && /^\s*UPDATE\s+shares\s+SET\s+status\s*=\s*'ready'/i.test(sql)) {
          state.committedResponseLost = true;
          throw new Error('D1 response lost after a successful durable commit');
        }
        return result;
      },
      async first(...parameters) {
        if (state.committedResponseLost && failStateReads && /^\s*SELECT\b[\s\S]*\bFROM\s+shares\b/i.test(sql)) {
          state.failedReads++;
          throw new Error('D1 temporarily unavailable while resolving the commit outcome');
        }
        return statement.first(...parameters);
      }
    });
    return wrap(originalPrepare(sql));
  };
  return state;
}

test('share fields preserve exact buyer values and copy only the publication allowlist', () => {
  const product = { ...fixture(), itemChinese: '  Buyer\n自填  ', modelChinese: '', hiddenNote: 'PRIVATE-NOTE', raw: { secret: 'PRIVATE-ROW' } };
  const clean = sanitizeProducts([product]);
  assert.notEqual(clean[0], product);
  assert.equal(clean[0].itemChinese, '  Buyer\n自填  ');
  assert.equal(clean[0].modelChinese, '');
  assert.equal(clean[0].badges[0].text, '示例卖点');
  assert.ok(!JSON.stringify(clean).includes('PRIVATE-'));
  product.badges[0].text = 'changed later';
  assert.equal(clean[0].badges[0].text, '示例卖点');
});

test('invalid product envelope, oversized fields and non-string fields are rejected', () => {
  for (const input of [null, {}, [], [null], [42], [[fixture()]], [{ ...fixture(), id: { nested: true } }]]) assert.throws(() => sanitizeProducts(input));
  assert.throws(() => sanitizeProducts([fixture(), fixture()], { maxProducts: 1, maxFieldChars: 20000 }));
  assert.throws(() => sanitizeProducts([{ ...fixture(), itemChinese: 'x'.repeat(11) }], { maxProducts: 200, maxFieldChars: 10 }));
});

test('random public IDs and write capabilities have separate unpredictable lengths', () => {
  const ids = Array.from({ length: 100 }, () => randomId());
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.match(randomId(32), /^[A-Za-z0-9_-]{43}$/);
});

test('HTML escaping does not permit attribute or script injection', () => {
  const escaped = escapeHtml('<script a="x">&\'');
  assert.ok(escaped.includes('&lt;script'));
  assert.ok(escaped.includes('&quot;'));
  assert.ok(!escaped.includes('<script'));
});

test('only exact approved HTTPS image hosts and default ports are accepted', () => {
  assert.equal(trustedImageUrl('https://cf.shopee.com.my/file/demo').hostname, 'cf.shopee.com.my');
  for (const address of ['http://cf.shopee.com.my/file/demo', 'https://cf.shopee.com.my.evil.test/x', 'https://127.0.0.1/x', 'https://192.168.1.2/x', 'https://[::1]/x', 'https://cf.shopee.com.my@127.0.0.1/x', 'https://user:pass@cf.shopee.com.my/x', 'https://cf.shopee.com.my:444/x', 'data:image/svg+xml,<svg></svg>']) assert.throws(() => trustedImageUrl(address), address);
});

test('image content type is checked against the binary file signature', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64');
  assert.equal(imageSignature(png, 'image/png'), true);
  assert.equal(imageSignature(png, 'image/jpeg'), false);
  assert.equal(imageSignature(Buffer.from('<html>error</html>'), 'image/jpeg'), false);
  assert.equal(imageSignature(Buffer.from('<svg/>'), 'image/svg+xml'), false);
});

test('cross-origin preflight is exact and unrelated origins cannot mint writers', async () => {
  const { env, DB } = setup();
  try {
    const preflight = await request(env, SHARES, { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.ok([200, 204].includes(preflight.status));
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    const forbidden = await request(env, WRITERS, { method: 'POST', body: {}, origin: 'https://evil.test' });
    assert.equal(forbidden.status, 403);
    assert.notEqual(forbidden.headers.get('Access-Control-Allow-Origin'), '*');
    const missingOrigin = await request(env, WRITERS, { method: 'POST', body: {}, origin: null });
    assert.equal(missingOrigin.status, 403);
  } finally { DB.close(); }
});

test('share writes require a valid bearer capability', async () => {
  const { env, DB } = setup();
  try {
    for (const token of [undefined, 'invalid', randomId() + '.' + randomId(32)]) {
      const result = await share(env, token);
      assert.equal(result.response.status, 401);
      assert.equal(result.value.url, undefined);
    }
  } finally { DB.close(); }
});

test('write capabilities are stored as hashes and are never exposed by public reads', async () => {
  const { env, DB } = setup();
  try {
    const token = await writer(env);
    const dump = DB.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(({ name }) => DB.sqlite.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all());
    assert.ok(!JSON.stringify(dump).includes(token.split('.')[1]));
    const saved = await share(env, token);
    assert.equal(saved.response.status, 201, JSON.stringify(saved.value));
    const html = await (await request(env, new URL(saved.value.url).pathname)).text();
    assert.ok(!html.includes(token) && !html.includes(token.split('.')[1]));
  } finally { DB.close(); }
});

test('published short URL is an anonymous server-rendered snapshot without redirects or scripts', async () => {
  const { env, DB } = setup();
  try {
    const token = await writer(env);
    const product = { ...fixture(), itemChinese: '<script>alert(1)</script>', modelChinese: '\"><img src=x onerror=alert(1)>', notes: 'DO-NOT-PUBLISH' };
    const { response, value } = await share(env, token, [product]);
    assert.equal(response.status, 201, JSON.stringify(value));
    const url = new URL(value.url);
    assert.equal(url.origin, API);
    assert.match(url.pathname, /^\/s\/[A-Za-z0-9_-]{22}$/);
    assert.equal(url.search + url.hash, '');
    assert.ok(!value.url.includes(token));
    const read = await request(env, url.pathname);
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('Location'), null);
    assert.match(read.headers.get('Content-Type'), /text\/html/);
    const html = await read.text();
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('DEMO-001'));
    assert.ok(!/<script\b/i.test(html));
    assert.ok(!/<[a-z][^>]*\son\w+\s*=/i.test(html));
    assert.ok(!html.includes('DO-NOT-PUBLISH'));
  } finally { DB.close(); }
});

test('idempotent retries reuse one immutable public URL while changed snapshots receive a new URL', async () => {
  const { env, DB } = setup();
  try {
    const token = await writer(env), products = [fixture()], requestId = randomId();
    const first = await share(env, token, products, requestId);
    assert.equal(first.response.status, 201, JSON.stringify(first.value));
    const retry = await share(env, token, products, requestId);
    assert.equal(retry.response.status, 200, JSON.stringify(retry.value));
    assert.equal(retry.value.url, first.value.url);
    const conflicting = await share(env, token, [{ ...fixture(), itemChinese: 'different' }], requestId);
    assert.equal(conflicting.response.status, 409);
    const second = await share(env, token, [{ ...fixture(), itemChinese: '后来编辑' }]);
    assert.equal(second.response.status, 201, JSON.stringify(second.value));
    assert.notEqual(second.value.url, first.value.url);
    const before = await (await request(env, new URL(first.value.url).pathname)).text();
    assert.ok(before.includes('示例产品甲'));
    assert.ok(!before.includes('后来编辑'));
  } finally { DB.close(); }
});

test('model images are copied into durable storage and served under the short share itself', async () => {
  const { env, DB, BUCKET } = setup();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64');
  let calls = 0;
  try {
    await withFetch(async (url, options) => { calls++; assert.equal(new URL(url).hostname, 'cf.shopee.com.my'); assert.equal(options.redirect, 'manual'); const headers = new Headers(options.headers); assert.equal(headers.get('Authorization'), null); assert.equal(headers.get('Cookie'), null); return new Response(png, { headers: { 'Content-Type': 'image/png' } }); }, async () => {
      const token = await writer(env);
      const saved = await share(env, token, [{ ...fixture(), model: 'https://cf.shopee.com.my/file/demo' }]);
      assert.equal(saved.response.status, 201, JSON.stringify(saved.value));
      assert.equal(saved.value.imagesArchived, 1);
      assert.ok(BUCKET.objects.size > 0);
      const html = await (await request(env, new URL(saved.value.url).pathname)).text();
      const imagePath = html.match(/<img\b[^>]*\bsrc="([^\"]+)"/i)?.[1];
      assert.ok(imagePath, html);
      const imageUrl = new URL(imagePath, saved.value.url);
      assert.equal(imageUrl.origin, API);
      assert.match(imageUrl.pathname, /\/s\/[A-Za-z0-9_-]{22}\/images\/[a-f0-9]{64}$/);
      assert.ok(!html.includes('src="https://cf.shopee'));
      const downloaded = await request(env, imageUrl.pathname);
      assert.equal(downloaded.status, 200);
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
    });
    assert.equal(calls, 1);
  } finally { DB.close(); }
});

test('concurrent retries cannot publish duplicate snapshots or overwrite a pending share', { timeout: 10000 }, async () => {
  const { env, DB } = setup();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64');
  let started, finishDownload, calls = 0;
  const downloading = new Promise(resolve => { started = resolve; });
  const download = new Promise(resolve => { finishDownload = resolve; });
  try {
    await withFetch(async () => { calls++; started(); return download; }, async () => {
      const token = await writer(env), requestId = randomId();
      const products = [{ ...fixture(), model: 'https://cf.shopee.com.my/file/demo' }];
      const firstPending = share(env, token, products, requestId);
      let timeout;
      try { await Promise.race([downloading, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('First request did not reach image persistence')), 5000); })]); }
      finally { clearTimeout(timeout); }
      const during = await share(env, token, products, requestId);
      assert.equal(during.response.status, 409);
      assert.equal(during.value.error?.code, 'SHARE_PENDING');
      finishDownload(new Response(png, { headers: { 'Content-Type': 'image/png' } }));
      const first = await firstPending;
      assert.equal(first.response.status, 201, JSON.stringify(first.value));
      const retry = await share(env, token, products, requestId);
      assert.equal(retry.response.status, 200);
      assert.equal(retry.value.url, first.value.url);
      assert.equal(calls, 1);
    });
  } finally { finishDownload(new Response(png, { headers: { 'Content-Type': 'image/png' } })); DB.close(); }
});

test('a redirect to an unapproved host cannot silently count as an archived image', async () => {
  const { env, DB } = setup();
  let calls = 0;
  try {
    await withFetch(async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/private' } }); }, async () => {
      const token = await writer(env);
      const saved = await share(env, token, [{ ...fixture(), model: 'https://cf.shopee.com.my/file/demo' }]);
      if ([200, 201].includes(saved.response.status)) {
        assert.equal(saved.value.imagesArchived, 0);
        assert.ok(Array.isArray(saved.value.imageFailures) && saved.value.imageFailures.length === 1);
      } else assert.ok(saved.response.status >= 400 && !saved.value.url);
    });
    assert.equal(calls, 1);
  } finally { DB.close(); }
});

test('repeated broken image sources are fetched once and report every affected product', async () => {
  const { env, DB } = setup();
  let calls = 0;
  try {
    await withFetch(async () => { calls++; return new Response('not found', { status: 404 }); }, async () => {
      const token = await writer(env), model = 'https://cf.shopee.com.my/file/missing';
      const saved = await share(env, token, [{ ...fixture(), model }, { ...fixture(), id: 'DEMO-002', model }]);
      assert.equal(saved.response.status, 201, JSON.stringify(saved.value));
      assert.equal(saved.value.imagesArchived, 0);
      assert.deepEqual(saved.value.imageFailures.map(failure => failure.index), [0, 1]);
    });
    assert.equal(calls, 1);
  } finally { DB.close(); }
});

test('R2 write failure cannot publish a share with a lost image', async () => {
  const { env, DB, BUCKET } = setup();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64');
  try {
    await withFetch(async () => new Response(png, { headers: { 'Content-Type': 'image/png' } }), async () => {
      const token = await writer(env);
      BUCKET.failPut = true;
      const saved = await share(env, token, [{ ...fixture(), model: 'https://cf.shopee.com.my/file/demo' }]);
      if ([200, 201].includes(saved.response.status)) {
        assert.equal(saved.value.imagesArchived, 0);
        assert.ok(Array.isArray(saved.value.imageFailures) && saved.value.imageFailures.length === 1);
      } else assert.ok(saved.response.status >= 400 && !saved.value.url);
    });
  } finally { DB.close(); }
});

test('unknown short IDs never redirect to another site', async () => {
  const { env, DB } = setup();
  try {
    const response = await request(env, '/s/' + randomId());
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('Location'), null);
  } finally { DB.close(); }
});

test('unavailable durable bindings cannot return a fake successful share', async () => {
  const response = await request({}, SHARES, { method: 'POST', token: randomId() + '.' + randomId(32), body: { v: 1, products: [fixture()], requestId: randomId() } });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.url, undefined);
});

test('anonymous writer bootstrap has a durable daily IP limit with atomic rollback', async () => {
  const { env, DB } = setup({ BOOTSTRAP_IP_DAILY_LIMIT: '1' });
  try {
    await writer(env);
    const denied = await request(env, WRITERS, { method: 'POST', body: {} });
    assert.equal(denied.status, 429);
    assert.equal((await denied.json()).error.code, 'RATE_LIMIT');
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM writers').get().n, 1);
    assert.equal(DB.sqlite.prepare("SELECT used FROM quota_counters WHERE key LIKE 'bootstrap-global:%'").get().used, 1);
  } finally { DB.close(); }
});

for (const [label, variable] of [['writer', 'SHARE_WRITER_DAILY_LIMIT'], ['IP', 'SHARE_IP_DAILY_LIMIT'], ['global', 'SHARE_GLOBAL_DAILY_LIMIT']]) {
  test('share ' + label + ' quota denies new writes and allows a completed idempotent retry', async () => {
    const { env, DB } = setup({ [variable]: '1' });
    try {
      const token = await writer(env), requestId = randomId();
      const first = await share(env, token, [fixture()], requestId);
      assert.equal(first.response.status, 201, JSON.stringify(first.value));
      const denied = await share(env, token);
      assert.equal(denied.response.status, 429);
      assert.equal(denied.value.error.code, 'RATE_LIMIT');
      assert.equal(denied.value.url, undefined);
      const retry = await share(env, token, [fixture()], requestId);
      assert.equal(retry.response.status, 200);
      assert.equal(retry.value.url, first.value.url);
      assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM shares').get().n, 1);
      for (const { used } of DB.sqlite.prepare("SELECT used FROM quota_counters WHERE key LIKE 'shares-%'").all()) assert.equal(used, 1);
    } finally { DB.close(); }
  });
}

test('global quota covers different authenticated writers and different client IPs', async () => {
  const { env, DB } = setup({ SHARE_GLOBAL_DAILY_LIMIT: '1' });
  try {
    const tokenA = await writer(env), tokenB = await writer(env);
    const first = await share(env, tokenA);
    assert.equal(first.response.status, 201);
    const second = await request(env, SHARES, { method: 'POST', token: tokenB, headers: { 'CF-Connecting-IP': '203.0.113.200' }, body: { v: 1, products: [fixture()], requestId: randomId() } });
    assert.equal(second.status, 429);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM shares').get().n, 1);
  } finally { DB.close(); }
});

test('storage-byte budget failure returns no usable URL and publishes no objects', async () => {
  const { env, DB, BUCKET } = setup({ GLOBAL_BYTES_DAILY_LIMIT: '1' });
  try {
    const token = await writer(env);
    const saved = await share(env, token);
    assert.equal(saved.response.status, 429);
    assert.equal(saved.value.error.code, 'STORAGE_LIMIT');
    assert.equal(saved.value.url, undefined);
    assert.equal(BUCKET.objects.size, 0);
    assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM shares WHERE status='ready'").get().n, 0);
  } finally { DB.close(); }
});

test('HTTP body limit is enforced before any share is reserved', async () => {
  const { env, DB } = setup({ MAX_BODY_BYTES: '64' });
  try {
    const token = await writer(env);
    const saved = await share(env, token);
    assert.equal(saved.response.status, 413);
    assert.equal(saved.value.url, undefined);
    assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM shares').get().n, 0);
  } finally { DB.close(); }
});

test('old published snapshots stay readable without a live writer session or a time-to-live', async () => {
  const { env, DB } = setup();
  try {
    const token = await writer(env), saved = await share(env, token);
    assert.equal(saved.response.status, 201);
    DB.sqlite.prepare('UPDATE shares SET created_at=1').run();
    DB.sqlite.prepare('UPDATE writers SET created_at=1,disabled=1').run();
    const read = await request(env, new URL(saved.value.url).pathname);
    assert.equal(read.status, 200);
    assert.ok((await read.text()).includes('示例产品甲'));
    const deniedNew = await share(env, token);
    assert.equal(deniedNew.response.status, 401);
  } finally { DB.close(); }
});

test('anonymous HEAD exposes the published metadata without a response body', async () => {
  const { env, DB } = setup();
  try {
    const token = await writer(env), saved = await share(env, token);
    assert.equal(saved.response.status, 201);
    const head = await request(env, new URL(saved.value.url).pathname, { method: 'HEAD', origin: null });
    assert.equal(head.status, 200);
    assert.match(head.headers.get('Content-Type'), /text\/html/);
    assert.equal(await head.text(), '');
  } finally { DB.close(); }
});

test('remote image request budget counts redirect hops and retains all failure records', async () => {
  const { env, DB } = setup({ MAX_REMOTE_IMAGE_FETCHES: '1' });
  let calls = 0;
  try {
    await withFetch(async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'https://cf.shopee.com.my/file/redirected' } }); }, async () => {
      const token = await writer(env);
      const saved = await share(env, token, [{ ...fixture(), model: 'https://cf.shopee.com.my/file/first' }, { ...fixture(), id: 'DEMO-002', model: 'https://cf.shopee.com.my/file/second' }]);
      assert.equal(saved.response.status, 201, JSON.stringify(saved.value));
      assert.equal(saved.value.imagesArchived, 0);
      assert.deepEqual(saved.value.imageFailures.map(failure => failure.index), [0, 1]);
    });
    assert.equal(calls, 1);
  } finally { DB.close(); }
});

test('archive wall-clock budget stops further remote work without losing product outcomes', async () => {
  const { env, DB } = setup({ MAX_IMAGE_ARCHIVE_MS: '1' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64');
  let calls = 0;
  try {
    await withFetch(async () => { calls++; await new Promise(resolve => setTimeout(resolve, 2)); return new Response(png, { headers: { 'Content-Type': 'image/png' } }); }, async () => {
      const token = await writer(env);
      const saved = await share(env, token, [{ ...fixture(), model: 'https://cf.shopee.com.my/file/first' }, { ...fixture(), id: 'DEMO-002', model: 'https://cf.shopee.com.my/file/second' }]);
      assert.equal(saved.response.status, 201, JSON.stringify(saved.value));
      assert.ok(calls <= 1);
      assert.equal(saved.value.imagesArchived + saved.value.imageFailures.length, 2);
      assert.ok(saved.value.imageFailures.some(failure => failure.index === 1));
    });
  } finally { DB.close(); }
});

test('public base-path deployments keep HTML and stored image URLs on the configured prefix', async () => {
  const { env, DB } = setup({ PUBLIC_BASE_URL: API + '/prefix' });
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=';
  try {
    const token = await writer(env);
    const saved = await share(env, token, [{ ...fixture(), model: 'data:image/png;base64,' + pngBase64 }]);
    assert.equal(saved.response.status, 201, JSON.stringify(saved.value));
    assert.equal(saved.value.imagesArchived, 1);
    assert.match(new URL(saved.value.url).pathname, /^\/prefix\/s\/[A-Za-z0-9_-]{22}$/);
    const read = await request(env, new URL(saved.value.url).pathname);
    assert.equal(read.status, 200);
    const html = await read.text(), imagePath = html.match(/<img\b[^>]*\bsrc="([^\"]+)"/i)?.[1];
    assert.match(imagePath, /^\/prefix\/s\/[A-Za-z0-9_-]{22}\/images\/[a-f0-9]{64}$/);
    const image = await request(env, imagePath);
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(pngBase64, 'base64'));
  } finally { DB.close(); }
});

test('a lost successful D1 commit response does not delete the already-published R2 snapshot', async () => {
  const { env, DB, BUCKET } = setup();
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=';
  const deleted = [], originalDelete = BUCKET.delete.bind(BUCKET);
  BUCKET.delete = async keys => { deleted.push(...(Array.isArray(keys) ? keys : [keys])); return originalDelete(keys); };
  try {
    const token = await writer(env), fault = injectCommittedResponseLoss(DB);
    const product = { ...fixture(), model: 'data:image/png;base64,' + pngBase64 };
    const saved = await share(env, token, [product]);
    assert.equal(fault.committedResponseLost, true);
    assert.ok([200, 201].includes(saved.response.status), JSON.stringify(saved.value));
    assert.equal(saved.value.persisted, true);
    assert.equal(saved.value.imagesArchived, 1);
    assert.equal(DB.sqlite.prepare('SELECT status FROM shares').get().status, 'ready');
    assert.equal(BUCKET.objects.size, 3);
    assert.deepEqual(deleted, []);
    const read = await request(env, new URL(saved.value.url).pathname);
    assert.equal(read.status, 200);
    assert.ok((await read.text()).includes('示例产品甲'));
  } finally { DB.close(); }
});

test('an uncertain D1 commit outcome keeps R2 objects until durable state can be checked again', async () => {
  const { env, DB, BUCKET } = setup();
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=';
  const deleted = [], originalDelete = BUCKET.delete.bind(BUCKET);
  BUCKET.delete = async keys => { deleted.push(...(Array.isArray(keys) ? keys : [keys])); return originalDelete(keys); };
  try {
    const token = await writer(env), fault = injectCommittedResponseLoss(DB, { failStateReads: true });
    const saved = await share(env, token, [{ ...fixture(), model: 'data:image/png;base64,' + pngBase64 }]);
    assert.equal(fault.committedResponseLost, true);
    assert.ok(fault.failedReads > 0);
    assert.equal(saved.response.status, 503);
    assert.equal(saved.value.url, undefined);
    const row = DB.sqlite.prepare('SELECT id,status FROM shares').get();
    assert.equal(row.status, 'ready');
    assert.equal(BUCKET.objects.size, 3);
    assert.deepEqual(deleted, []);
    fault.allowReads();
    const recovered = await request(env, '/s/' + row.id);
    assert.equal(recovered.status, 200);
    assert.ok((await recovered.text()).includes('示例产品甲'));
  } finally { DB.close(); }
});

test('lifetime storage cap rolls back the daily reservation and keeps previous public snapshots intact', async () => {
  const { env, DB, BUCKET } = setup();
  try {
    const token = await writer(env), first = await share(env, token);
    assert.equal(first.response.status, 201, JSON.stringify(first.value));
    const lifetimeBefore = DB.sqlite.prepare("SELECT used FROM quota_counters WHERE key='bytes-total'").get().used;
    const dailyBefore = DB.sqlite.prepare("SELECT key,used FROM quota_counters WHERE key LIKE 'bytes-global:%'").get();
    const objectKeysBefore = [...BUCKET.objects.keys()].sort();
    assert.ok(lifetimeBefore > 1);
    env.GLOBAL_BYTES_TOTAL_LIMIT = String(lifetimeBefore + 1);
    DB.sqlite.prepare('UPDATE shares SET created_at=1').run();
    const second = await share(env, token);
    assert.equal(second.response.status, 429, JSON.stringify(second.value));
    assert.equal(second.value.error.code, 'STORAGE_LIMIT');
    assert.equal(second.value.url, undefined);
    assert.equal(DB.sqlite.prepare("SELECT used FROM quota_counters WHERE key='bytes-total'").get().used, lifetimeBefore);
    assert.equal(DB.sqlite.prepare('SELECT used FROM quota_counters WHERE key=?').get(dailyBefore.key).used, dailyBefore.used);
    assert.deepEqual([...BUCKET.objects.keys()].sort(), objectKeysBefore);
    assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM shares WHERE status='ready'").get().n, 1);
    const old = await request(env, new URL(first.value.url).pathname);
    assert.equal(old.status, 200);
    assert.ok((await old.text()).includes('示例产品甲'));
  } finally { DB.close(); }
});
