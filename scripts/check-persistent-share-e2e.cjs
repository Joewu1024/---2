'use strict';

// Real client -> Fetch Request -> Worker -> migrated SQLite/R2 adapter checks.
// All data is fictional. The transport never opens a live socket; only the
// external image CDN boundary and durable provider APIs are adapted.
const assert = require('node:assert/strict');
const { test, after, mock } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const clientApi = require('../persistent-share-client.js');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = 'https://persistent-share.example.test';
const WORKBENCH = 'https://joewu1024.github.io';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64');
const DATA_PNG = 'data:image/png;base64,' + PNG.toString('base64');
let moduleSerial = 0;
let imageTransport = async () => { throw new Error('Live network is forbidden in persistent-share e2e checks'); };
mock.method(globalThis, 'fetch', (...arguments_) => imageTransport(...arguments_));
after(() => mock.restoreAll());

function product(overrides = {}) {
  return { id: 'FICTIONAL-001', model: '', itemChinese: '  买手\nBuyer & <img src=x onerror=alert(1)>  ', modelChinese: '', category: '家用电器 > 遥控器', invitation: '', target: '0.00', shopee: '', shopeeUrl: '', badges: [{ kind: 'crown', icon: '👑', text: '测试卖点' }], ...overrides };
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function bounded(promise) { let timer; try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Expected controlled image request did not start')), 3000); })]); } finally { clearTimeout(timer); } }

class MigratedD1 {
  constructor(filename, migrate = false) {
    this.sqlite = new DatabaseSync(filename);
    this.queries = [];
    this.sqlite.exec('PRAGMA foreign_keys=ON');
    if (migrate) {
      const directory = path.join(ROOT, 'share-service', 'migrations');
      const files = fs.readdirSync(directory).filter(file => file.endsWith('.sql')).sort();
      assert.ok(files.length > 0, 'The test must execute actual production migrations');
      for (const file of files) this.sqlite.exec(fs.readFileSync(path.join(directory, file), 'utf8'));
    }
  }
  prepare(sql) {
    this.queries.push(sql);
    const database = this;
    const prepared = parameters => {
      const statement = {
        bind(...values) { return prepared(values); },
        execute() {
          const compiled = database.sqlite.prepare(sql);
          if (compiled.columns().length) return { success: true, results: compiled.all(...parameters), meta: { changes: database.sqlite.prepare('SELECT changes() AS count').get().count } };
          const result = compiled.run(...parameters);
          return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        },
        async first(column) {
          if (database.failStatusReads && /\bFROM\s+shares\b/i.test(sql)) throw new Error('Fictional D1 status read outage');
          const row = database.sqlite.prepare(sql).get(...parameters); return row == null ? null : column ? row[column] : row;
        },
        async all() { return statement.execute(); },
        async run() {
          const result = statement.execute();
          if (database.loseReadyAck && /\bUPDATE\s+shares\s+SET\s+status\s*=\s*'ready'/i.test(sql)) {
            database.loseReadyAck = false;
            database.failStatusReads = !!database.loseStatusRead;
            throw new Error('Fictional committed D1 UPDATE with lost acknowledgement');
          }
          return result;
        }
      };
      return statement;
    };
    return prepared([]);
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const result = statements.map(statement => statement.execute()); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  close() { this.sqlite.close(); }
}

class PersistentR2 {
  constructor(objects = new Map()) { this.objects = objects; this.failPut = null; }
  async put(key, value, options = {}) {
    if (this.failPut && this.failPut(key)) throw new Error('Fictional R2 write outage');
    const bytes = typeof value === 'string' ? Buffer.from(value) : value instanceof ArrayBuffer ? Buffer.from(value) : ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(await new Response(value).arrayBuffer());
    const hash = createHash('sha256').update(bytes).digest('hex');
    const object = { key, bytes: Buffer.from(bytes), size: bytes.length, httpEtag: '"' + hash + '"', httpMetadata: { ...options.httpMetadata }, customMetadata: { ...options.customMetadata } };
    this.objects.set(key, object);
    return { ...object };
  }
  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { ...object, body: new Response(object.bytes).body, async text() { return object.bytes.toString('utf8'); }, async arrayBuffer() { return Uint8Array.from(object.bytes).buffer; } };
  }
  async head(key) { const object = this.objects.get(key); return object ? { ...object, body: undefined } : null; }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key); }
}

class System {
  constructor(variables = {}) {
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'buyer-share-e2e-'));
    this.filename = path.join(this.directory, 'durable.sqlite');
    this.env = { DB: new MigratedD1(this.filename, true), BUCKET: new PersistentR2(), ALLOWED_ORIGINS: WORKBENCH, ...variables };
    this.requests = [];
    this.background = [];
    this.ctx = { waitUntil: promise => this.background.push(Promise.resolve(promise)) };
  }
  async boot() {
    this.worker = (await import(pathToFileURL(path.join(ROOT, 'share-service', 'worker.mjs')).href + '?e2e=' + (++moduleSerial))).default;
    return this;
  }
  async restart() {
    await Promise.all(this.background.splice(0));
    const objects = this.env.BUCKET.objects;
    this.env.DB.close();
    this.env.DB = new MigratedD1(this.filename);
    this.env.BUCKET = new PersistentR2(objects);
    await this.boot();
  }
  client({ storage = null, ip = '203.0.113.10', origin = WORKBENCH, transport, baseUrl = SERVICE, ...options } = {}) {
    const system = this;
    const fetchImpl = async (url, init) => {
      assert.equal(new URL(url).origin, SERVICE, 'Client unexpectedly left the configured service');
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, 'omit');
      const headers = new Headers(init.headers);
      headers.set('Origin', origin);
      headers.set('CF-Connecting-IP', ip);
      const request = new Request(url, { ...init, headers });
      system.requests.push(request.clone());
      return transport ? transport(request, system) : system.worker.fetch(request, system.env, system.ctx);
    };
    return clientApi.create({ baseUrl, allowedOrigin: SERVICE, storage, fetchImpl, timeoutMs: 5000, ...options });
  }
  async anonymous(url, method = 'GET', headers = {}) {
    const request = new Request(url, { method, headers });
    assert.equal(request.headers.get('Authorization'), null);
    assert.equal(request.headers.get('Cookie'), null);
    return this.worker.fetch(request, this.env, this.ctx);
  }
  manifest(id) { return JSON.parse(this.env.BUCKET.objects.get('shares/' + id + '/manifest.json').bytes.toString('utf8')); }
  async replay(request) { return this.worker.fetch(request.clone(), this.env, this.ctx); }
  async close() {
    await Promise.all(this.background.splice(0));
    this.env.DB.close();
    // Delete only the exact database files this test created, never recursively.
    for (const suffix of ['', '-wal', '-shm', '-journal']) { try { fs.unlinkSync(this.filename + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    fs.rmdirSync(this.directory);
  }
}
async function system(variables) { return new System(variables).boot(); }
async function using(variables, run) { if (typeof variables === 'function') { run = variables; variables = {}; } const value = await system(variables); try { await run(value); } finally { await value.close(); } }
async function withImages(handler, run) { const previous = imageTransport; imageTransport = handler; try { await run(); } finally { imageTransport = previous; } }

test('actual client persists exact selected buyer values and exposes only a short opaque identifier', async () => using(async service => {
  const input = [product({ model: DATA_PNG, notes: 'PRIVATE-NOTE', raw: { title: 'PRIVATE-UNSELECTED' } }), product({ id: 'FICTIONAL-002', model: DATA_PNG, itemChinese: '', modelChinese: '  5pcs / Mới \n新款  ' })];
  const expected = clone(input);
  const promise = service.client().publish(input);
  input[0].itemChinese = 'EDITED AFTER CLICK';
  input[0].badges[0].text = 'EDITED BADGE';
  const result = await promise;
  assert.equal(result.productCount, 2);
  assert.equal(result.persisted, true);
  assert.equal(result.imagesArchived, 2);
  assert.deepEqual(result.imageFailures, []);
  const url = new URL(result.url);
  assert.equal(url.origin, SERVICE);
  assert.match(url.pathname, /^\/s\/[A-Za-z0-9_-]{22}$/);
  assert.equal(url.search + url.hash, '');
  assert.ok(result.url.length < 90);
  const manifest = service.manifest(result.id);
  for (let index = 0; index < expected.length; index++) for (const field of ['id', 'itemChinese', 'modelChinese', 'category', 'target']) assert.equal(manifest.products[index][field], expected[index][field]);
  assert.equal(manifest.products[0].badges[0].text, '测试卖点');
  assert.ok(!JSON.stringify(manifest).includes('PRIVATE-'));
  assert.equal([...service.env.BUCKET.objects.keys()].filter(key => key.includes('/images/')).length, 1, 'A repeated image must be stored once per snapshot');
  const htmlResponse = await service.anonymous(result.url);
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlResponse.headers.get('Location'), null);
  assert.match(htmlResponse.headers.get('Content-Type'), /text\/html/);
  assert.ok(html.includes('  买手\nBuyer &amp; &lt;img src=x onerror=alert(1)&gt;  '));
  assert.ok(html.includes('  5pcs / Mới \n新款  '));
  assert.ok(html.includes('未填写'));
  assert.equal((html.match(/<article>/g) || []).length, 2);
  assert.ok(!/<script\b|<[a-z][^>]*\son\w+\s*=/i.test(html));
  assert.match(htmlResponse.headers.get('Content-Security-Policy'), /default-src 'none'/);
  assert.ok(!html.includes('PRIVATE-') && !html.includes('EDITED AFTER CLICK'));
  assert.ok(!service.env.DB.queries.some(sql => /^\s*(CREATE|ALTER|DROP)\b/i.test(sql)), 'Requests must not initialize schema');
}));

test('new browser clients and fresh Worker/SQLite connections read one immutable snapshot without writer credentials', async () => using(async service => {
  const clientA = service.client();
  const original = await clientA.publish([product({ model: DATA_PNG })]);
  const before = await (await service.anonymous(original.url)).text();
  const clientB = service.client({ ip: '203.0.113.20' });
  const other = await clientB.publish([product({ id: 'FICTIONAL-OTHER', itemChinese: '另一位买手的标题' })]);
  assert.notEqual(other.id, original.id);
  assert.equal(service.env.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM writers').get().count, 2);
  service.env.DB.sqlite.prepare('UPDATE writers SET disabled=1,created_at=1').run();
  service.env.DB.sqlite.prepare('UPDATE shares SET created_at=1').run();
  await service.restart();
  const after = await service.anonymous(original.url, 'GET', { 'User-Agent': 'Fictional mobile browser' });
  assert.equal(after.status, 200);
  assert.equal(await after.text(), before);
  const independent = await service.anonymous(other.url, 'GET', { 'User-Agent': 'Fictional desktop browser' });
  assert.equal(independent.status, 200);
  assert.ok((await independent.text()).includes('另一位买手的标题'));
  const head = await service.anonymous(original.url, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('Location'), null);
  const tokenText = service.requests.filter(request => request.headers.has('Authorization')).map(request => request.headers.get('Authorization').slice(7));
  assert.ok(tokenText.length > 0 && tokenText.every(token => !before.includes(token) && !original.url.includes(token)));
}));

test('stored images remain readable after source disappearance and a new Worker instance', async () => using(async service => {
  let sourceRequests = 0;
  let saved;
  await withImages(async (url, init) => {
    sourceRequests++;
    assert.equal(new URL(url).hostname, 'cf.shopee.com.my');
    assert.equal(init.redirect, 'manual');
    assert.equal(new Headers(init.headers).get('Authorization'), null);
    return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
  }, async () => { saved = await service.client().publish([product({ model: 'https://cf.shopee.com.my/file/fictional.png' })]); });
  assert.equal(sourceRequests, 1);
  await service.restart();
  const html = await (await service.anonymous(saved.url)).text();
  assert.ok(!html.includes('src="https://cf.shopee'));
  const imagePaths = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
  assert.equal(imagePaths.length, 1);
  const imageUrl = new URL(imagePaths[0], saved.url);
  assert.equal(imageUrl.origin, SERVICE);
  const image = await service.anonymous(imageUrl.href);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.equal(image.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
}));

test('short URL length does not grow with product count and snapshots never overwrite prior links', async () => using(async service => {
  const client = service.client();
  const first = await client.publish([product({ itemChinese: '第一次标题' })]);
  const many = await client.publish(Array.from({ length: 20 }, (_, index) => product({ id: 'FICTIONAL-' + index, itemChinese: '后续标题 ' + index })));
  assert.notEqual(first.url, many.url);
  assert.equal(first.url.length, many.url.length);
  assert.equal((await (await service.anonymous(many.url)).text()).match(/<article>/g).length, 20);
  const unchanged = await (await service.anonymous(first.url)).text();
  assert.ok(unchanged.includes('第一次标题') && !unchanged.includes('后续标题'));
}));

test('a service mounted under a path returns and serves the exact client-validated canonical short URL', async () => using({ PUBLIC_BASE_URL: SERVICE + '/buyer' }, async service => {
  const saved = await service.client({ baseUrl: SERVICE + '/buyer' }).publish([product({ model: DATA_PNG })]);
  assert.match(new URL(saved.url).pathname, /^\/buyer\/s\/[A-Za-z0-9_-]{22}$/);
  const page = await service.anonymous(saved.url);
  assert.equal(page.status, 200);
  const imagePath = (await page.text()).match(/<img\b[^>]*\bsrc="([^"]+)"/)[1];
  assert.ok(imagePath.startsWith('/buyer/s/'));
  assert.equal((await service.anonymous(new URL(imagePath, saved.url).href)).status, 200);
}));

test('lost HTTP response retries reach real idempotency without reserving duplicate rows or quota', async () => using(async service => {
  let replayStatus;
  const client = service.client({ transport: async (request, current) => {
    if (!new URL(request.url).pathname.endsWith('/api/shares')) return current.worker.fetch(request, current.env, current.ctx);
    const first = await current.worker.fetch(request.clone(), current.env, current.ctx);
    assert.equal(first.status, 201);
    const replay = await current.worker.fetch(request.clone(), current.env, current.ctx);
    replayStatus = replay.status;
    return replay;
  } });
  const saved = await client.publish([product()]);
  assert.equal(saved.persisted, true);
  assert.equal(replayStatus, 200);
  assert.equal(service.env.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM shares').get().count, 1);
  for (const { used } of service.env.DB.sqlite.prepare("SELECT used FROM quota_counters WHERE key LIKE 'shares-%'").all()) assert.equal(used, 1);
}));

test('concurrent duplicate HTTP delivery cannot race image archiving or publish two records', async () => using(async service => {
  const started = deferred(), finish = deferred();
  let pending;
  await withImages(async () => { started.resolve(); return finish.promise; }, async () => {
    try {
      pending = service.client().publish([product({ model: 'https://cf.shopee.com.my/file/slow.png' })]);
      await bounded(started.promise);
      const originalRequest = service.requests.find(request => new URL(request.url).pathname.endsWith('/api/shares'));
      const duplicate = await service.replay(originalRequest);
      assert.equal(duplicate.status, 409);
      assert.equal((await duplicate.json()).error.code, 'SHARE_PENDING');
      finish.resolve(new Response(PNG, { headers: { 'Content-Type': 'image/png' } }));
      const saved = await pending;
      const retry = await service.replay(originalRequest);
      assert.equal(retry.status, 200);
      assert.equal((await retry.json()).url, saved.url);
      const conflictingBody = await originalRequest.clone().json();
      conflictingBody.products[0].modelChinese = 'different payload';
      const conflict = await service.worker.fetch(new Request(originalRequest.url, { method: 'POST', headers: originalRequest.headers, body: JSON.stringify(conflictingBody) }), service.env, service.ctx);
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');
      assert.equal(service.env.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM shares WHERE status='ready'").get().count, 1);
    } finally { finish.resolve(new Response(PNG, { headers: { 'Content-Type': 'image/png' } })); if (pending) await pending.catch(() => {}); }
  });
}));

test('provider write failures reject the real client and never return a fake persisted short URL', async () => using(async service => {
  service.env.BUCKET.failPut = key => key.endsWith('/index.html');
  await assert.rejects(service.client().publish([product({ model: DATA_PNG })]), error => error.code === 'unavailable');
  await Promise.all(service.background.splice(0));
  assert.equal(service.env.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM shares WHERE status='ready'").get().count, 0);
  assert.equal(service.env.BUCKET.objects.size, 0);
}));

for (const loseStatusRead of [false, true]) {
  test('committed D1 update with lost acknowledgement preserves the public archive when status probe ' + (loseStatusRead ? 'also fails' : 'succeeds'), async () => using(async service => {
    service.env.DB.loseReadyAck = true;
    service.env.DB.loseStatusRead = loseStatusRead;
    let result;
    try { result = await service.client().publish([product({ model: DATA_PNG })]); }
    catch (error) { assert.equal(error.code, 'unavailable', 'A lost provider acknowledgement must remain an explicit failure'); }
    await Promise.all(service.background.splice(0));
    const row = service.env.DB.sqlite.prepare("SELECT * FROM shares WHERE status='ready'").get();
    assert.ok(row, 'The injected UPDATE really committed before its acknowledgement was lost');
    assert.ok(service.env.BUCKET.objects.has(row.html_key), 'Cleanup must not delete HTML belonging to an already committed snapshot');
    assert.equal([...service.env.BUCKET.objects.keys()].filter(key => key.startsWith('shares/' + row.id + '/images/')).length, 1, 'Cleanup must preserve the already committed image');
    if (result) assert.equal(result.id, row.id);
    await service.restart();
    const url = SERVICE + '/s/' + row.id;
    const publicRead = await service.anonymous(url);
    assert.equal(publicRead.status, 200);
    const html = await publicRead.text();
    const imagePath = html.match(/<img\b[^>]*\bsrc="([^"]+)"/)[1];
    assert.equal((await service.anonymous(new URL(imagePath, url).href)).status, 200);
    const retry = await service.replay(service.requests.find(request => new URL(request.url).pathname.endsWith('/api/shares')));
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).url, url);
  }));
}

test('missing or unreadable storage responds visibly rather than rendering a blank document', async () => using(async service => {
  const saved = await service.client().publish([product()]);
  service.env.BUCKET.objects.delete('shares/' + saved.id + '/index.html');
  const missing = await service.anonymous(saved.url);
  assert.equal(missing.status, 503);
  const text = await missing.text();
  assert.ok(text.includes('分享暂时无法打开') && text.includes('暂时无法读取'));
  assert.ok(!/<script\b/i.test(text));
  service.env.BUCKET = null;
  await assert.rejects(service.client().publish([product()]), error => error.code === 'unavailable');
}));

test('unreachable or unsafe images are explicit per-product warnings, without remote fallback dependencies', async () => using(async service => {
  let fetched = 0;
  await withImages(async () => { fetched++; return new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/private' } }); }, async () => {
    const saved = await service.client().publish([product({ model: 'https://cf.shopee.com.my/file/bad.png' }), product({ id: 'FICTIONAL-002', model: 'https://cf.shopee.com.my/file/bad.png' })]);
    assert.equal(saved.imagesArchived, 0);
    assert.deepEqual(saved.imageFailures.map(failure => failure.index), [0, 1]);
    assert.equal(fetched, 1);
    const html = await (await service.anonymous(saved.url)).text();
    assert.ok(html.includes('图片未能归档'));
    assert.ok(!/<img\b/i.test(html));
    assert.ok(!html.includes('127.0.0.1') && !html.includes('src="https://'));
  });
}));

test('global quota is atomic across different real client identities and keeps prior public links usable', async () => using({ SHARE_GLOBAL_DAILY_LIMIT: '1' }, async service => {
  const first = await service.client({ ip: '203.0.113.31' }).publish([product()]);
  await assert.rejects(service.client({ ip: '203.0.113.32' }).publish([product({ id: 'FICTIONAL-002' })]), error => error.code === 'rate_limited');
  assert.equal(service.env.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM shares').get().count, 1);
  assert.equal(service.env.DB.sqlite.prepare("SELECT used FROM quota_counters WHERE key LIKE 'shares-global:%'").get().used, 1);
  assert.equal((await service.anonymous(first.url)).status, 200);
}));

test('lifetime capacity exhaustion reports storage_full and preserves every previously published object', async () => using(async service => {
  const client = service.client();
  const first = await client.publish([product({ model: DATA_PNG })]);
  const originalKeys = [...service.env.BUCKET.objects.keys()].sort();
  const used = service.env.DB.sqlite.prepare("SELECT used FROM quota_counters WHERE key='bytes-total'").get().used;
  service.env.GLOBAL_BYTES_TOTAL_LIMIT = String(used + 1);
  await assert.rejects(client.publish([product({ id: 'FICTIONAL-NO-SPACE' })]), error => error.code === 'storage_full' && /容量/.test(error.message) && /管理员/.test(error.message));
  await Promise.all(service.background.splice(0));
  assert.deepEqual([...service.env.BUCKET.objects.keys()].sort(), originalKeys);
  assert.equal(service.env.DB.sqlite.prepare("SELECT used FROM quota_counters WHERE key='bytes-total'").get().used, used);
  assert.equal(service.env.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM shares WHERE status='ready'").get().count, 1);
  await service.restart();
  const page = await service.anonymous(first.url);
  assert.equal(page.status, 200);
  const imagePath = (await page.text()).match(/<img\b[^>]*\bsrc="([^"]+)"/)[1];
  assert.equal((await service.anonymous(new URL(imagePath, first.url).href)).status, 200);
}));

test('write origin restrictions and missing durable bindings propagate honest client failures', async () => using(async service => {
  await assert.rejects(service.client({ origin: 'https://unrelated.example.test' }).publish([product()]), error => error.code === 'forbidden');
  assert.equal(service.env.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM writers').get().count, 0);
  const database = service.env.DB;
  service.env.DB = null;
  try { await assert.rejects(service.client().publish([product()]), error => error.code === 'unavailable'); }
  finally { service.env.DB = database; }
}));
