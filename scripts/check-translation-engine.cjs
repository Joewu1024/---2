'use strict';

// Run with: node scripts/check-translation-engine.cjs
// Every response is fabricated. An accidental fetch fails immediately.
const assert = require('node:assert/strict');
const { test, after, afterEach, mock } = require('node:test');
const { Queue, normalize, passthrough, usable } = require('../translation-engine.js');

const engines = new Set();
mock.method(globalThis, 'fetch', () => {
  throw new Error('Network access is forbidden in translation-engine checks');
});
after(() => mock.restoreAll());
afterEach(() => {
  for (const queue of engines) {
    queue.setPaused(true);
    queue.cancelQueued();
    clearTimeout(queue.timer);
  }
  engines.clear();
});

function engine(options = {}) {
  const queue = new Queue({ requestBatch: mock.fn(async texts => texts.map(chineseFor)), ...options });
  engines.add(queue);
  return queue;
}

function chineseFor(text) {
  const models = text.match(/\b[A-Z]{1,8}[-]?\d+[A-Z0-9-]*\b/g) || [];
  const digits = text.match(/\d+(?:[.,]\d+)*/g) || [];
  return ['虚构商品中文译文', ...models, ...digits].join(' ');
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(condition, message, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail('Timed out: ' + message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('normalizes whitespace/NFC and deduplicates queued and cached requests', { timeout: 5000 }, async () => {
  assert.equal(normalize('  Cafe\u0301\n\t speaker  '), 'Café speaker');
  const transport = mock.fn(async texts => texts.map(chineseFor));
  const queue = engine({ requestBatch: transport });
  queue.setPaused(true);
  const first = queue.request('  Wireless  speaker\n FICT01  ');
  const second = queue.request('Wireless speaker FICT01');
  assert.strictEqual(first, second);
  assert.equal(queue.jobs.size, 1);
  assert.equal(queue.queue.length, 1);
  queue.setPaused(false);
  assert.equal(await first, chineseFor('Wireless speaker FICT01'));
  assert.equal(await queue.request('\tWireless   speaker FICT01'), await second);
  assert.equal(transport.mock.callCount(), 1);
  assert.deepEqual(transport.mock.calls[0].arguments[0], ['Wireless speaker FICT01']);
  assert.equal(queue.stats.cacheHits, 1);
});

test('a current-page request promotes an already queued background job', { timeout: 5000 }, async () => {
  const transport = mock.fn(async texts => texts.map(chineseFor));
  const queue = engine({ requestBatch: transport, concurrency: 1, batchSize: 1 });
  queue.setPaused(true);
  const first = queue.request('Wireless speaker FICT11', { priority: 0 });
  const second = queue.request('Wireless speaker FICT12', { priority: 0 });
  const current = queue.request('Wireless speaker FICT13', { priority: 0 });
  queue.demoteQueued();
  assert.ok(queue.queue.every(job => job.priority === 2));
  const promoted = queue.request('Wireless speaker FICT13', { priority: 0 });
  assert.strictEqual(current, promoted);
  queue.setPaused(false);
  await Promise.all([first, second, current]);
  assert.deepEqual(transport.mock.calls.map(call => call.arguments[0][0]), [
    'Wireless speaker FICT13', 'Wireless speaker FICT11', 'Wireless speaker FICT12'
  ]);
});

test('array batches contain exactly one source language', { timeout: 5000 }, async () => {
  const fixtures = [
    ['en', 'Wireless speaker FICTE01'], ['en', 'Wireless speaker FICTE02'],
    ['pt', 'Caixa de som FICTP01'], ['pt', 'Caixa de som FICTP02'],
    ['th', 'ลำโพง FICTT01'], ['th', 'ลำโพง FICTT02'],
    ['vi', 'Loa không dây FICTV01'], ['vi', 'Loa không dây FICTV02'],
    ['ms', 'Pembesar suara FICTM01'], ['ms', 'Pembesar suara FICTM02']
  ];
  const expectedLanguage = new Map(fixtures.map(([lang, text]) => [text, lang]));
  const transport = mock.fn(async (texts, lang) => {
    assert.ok(texts.length > 0);
    for (const text of texts) assert.equal(expectedLanguage.get(text), lang);
    return texts.map(chineseFor);
  });
  const queue = engine({ requestBatch: transport });
  queue.setPaused(true);
  const pending = fixtures.map(([lang, text]) => queue.request(text, { language: lang }));
  queue.setPaused(false);
  assert.ok((await Promise.all(pending)).every(Boolean));
  assert.deepEqual(new Set(transport.mock.calls.map(call => call.arguments[1])), new Set(['en', 'pt', 'th', 'vi', 'ms']));
  assert.ok(transport.mock.calls.some(call => call.arguments[0].length > 1));
});

test('uses batches larger than three while never exceeding three concurrent transports', { timeout: 5000 }, async () => {
  const gates = [];
  let active = 0, maximum = 0;
  const transport = mock.fn(async texts => {
    const gate = deferred();
    gates.push(gate);
    active++;
    maximum = Math.max(maximum, active);
    try {
      await gate.promise;
      return texts.map(chineseFor);
    } finally {
      active--;
    }
  });
  const queue = engine({ requestBatch: transport, concurrency: 3, batchSize: 12 });
  queue.setPaused(true);
  const pending = Array.from({ length: 43 }, (_, i) => queue.request('Wireless speaker FICT' + String(i + 101)));
  queue.setPaused(false);
  await waitFor(() => gates.length === 3, 'three initial batches');
  assert.equal(queue.active, 3);
  assert.equal(queue.queue.length, 7);
  assert.ok(transport.mock.calls.every(call => call.arguments[0].length === 12));
  gates.slice(0, 3).forEach(gate => gate.resolve());
  await waitFor(() => gates.length === 4, 'last batch');
  gates[3].resolve();
  assert.ok((await Promise.all(pending)).every(Boolean));
  await waitFor(() => queue.active === 0, 'all concurrent batches finish');
  assert.equal(maximum, 3);
  assert.equal(transport.mock.callCount(), 4);
  assert.equal(queue.stats.completed, 43);
});

test('429 cooldown preserves queued jobs and retries after the minimum delay', { timeout: 6000 }, async () => {
  let first = true;
  const transport = mock.fn(async texts => {
    if (first) {
      first = false;
      throw Object.assign(new Error('Fabricated 429'), { rateLimited: true, retryAfter: 1 });
    }
    return texts.map(chineseFor);
  });
  const queue = engine({ requestBatch: transport, concurrency: 1, batchSize: 3 });
  queue.setPaused(true);
  let settled = 0;
  const pending = Array.from({ length: 9 }, (_, i) => queue.request('Wireless speaker FICT' + (201 + i)).then(value => {
    settled++;
    return value;
  }));
  const started = Date.now();
  queue.setPaused(false);
  await waitFor(() => queue.cooldown > Date.now(), 'rate-limit cooldown');
  assert.equal(transport.mock.callCount(), 1);
  assert.equal(queue.jobs.size, 9);
  assert.equal(queue.queue.length, 9);
  assert.equal(settled, 0);
  assert.ok(queue.cooldown - started >= 1000);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(transport.mock.callCount(), 1);
  assert.equal(settled, 0);
  assert.ok((await Promise.all(pending)).every(Boolean));
  assert.ok(Date.now() - started >= 950, 'retryAfter is clamped to at least one second');
  assert.equal(settled, 9);
  assert.equal(queue.jobs.size, 0);
  assert.equal(queue.queue.length, 0);
  assert.equal(queue.stats.failed, 0);
  assert.equal(transport.mock.callCount(), 4);
});

test('rejects corrupt cache values, ZXQ markers and substantial untranslated fragments', { timeout: 5000 }, async () => {
  const sourceA = 'Wireless speaker FICT301';
  const sourceB = 'Microphone FICT302';
  const sourceC = 'Wireless rechargeable portable speaker FICT303';
  const badValues = [sourceA, '错误译文 ZXQ0001QXZ FICT302', '部分中文 ' + sourceC];
  const sources = [sourceA, sourceB, sourceC];
  const cache = new Map(sources.map((text, i) => [text, badValues[i]]));
  for (let i = 0; i < sources.length; i++) assert.equal(usable(sources[i], badValues[i]), false);
  assert.equal(usable(sourceA, '译文\uFFFD FICT301'), false);
  assert.equal(usable(sourceA, 'ZXQ00000QXZ 译文 FICT301'), false);
  const transport = mock.fn(async texts => texts.map(chineseFor));
  const queue = engine({ cache, requestBatch: transport });
  const result = await Promise.all(sources.map(text => queue.request(text)));
  assert.deepEqual(result, sources.map(chineseFor));
  assert.equal(transport.mock.callCount(), 1);
  sources.forEach((source, i) => {
    assert.equal(cache.get(source), result[i]);
    assert.notEqual(cache.get(source), badValues[i]);
  });
});

test('contextual product terminology is refined in both service results and existing cache', { timeout: 5000 }, async () => {
  const remote = 'Kit Controle Remoto Aurora ZX901 com Fonte 12V e 2 Cabos';
  const remoteResult = 'Aurora ZX901远程控制套件，带12V电源和2根电缆';
  const cases = [
    ['กล่องชาร์จ FICT1501', 'FICT1501 充电器外壳'],
    ['Wireless charging case FICT1502', 'FICT1502 充电器外壳'],
    ['Charger case FICT1503', 'FICT1503 充电器外壳'],
    ['充电盒 FICT1504', 'FICT1504 充电器外壳']
  ];
  const outputs = new Map([[remote, remoteResult], ...cases]);
  const transport = mock.fn(async texts => texts.map(text => outputs.get(text)));
  const queue = engine({ requestBatch: transport });
  queue.setPaused(true);
  const pending = [...outputs.keys()].map(text => queue.request(text));
  queue.setPaused(false);
  const result = await Promise.all(pending);
  assert.match(result[0], /遥控器/);
  assert.match(result[0], /套装/);
  assert.doesNotMatch(result[0], /远程控制|套件/);
  result.slice(1).forEach(value => {
    assert.match(value, /充电盒/);
    assert.doesNotMatch(value, /充电器外壳/);
  });
  const cachedTransport = mock.fn(async () => assert.fail('valid cached terminology needs no transport'));
  const cached = engine({ cache: new Map([[remote, remoteResult], ...cases]), requestBatch: cachedTransport });
  assert.match(await cached.request(remote), /遥控器.*套装/);
  for (const [source] of cases) assert.match(await cached.request(source), /充电盒/);
  assert.equal(cachedTransport.mock.callCount(), 0);
  const unrelated = engine({ cache: new Map([['Speaker stand FICT1505', 'FICT1505 充电器外壳']]), requestBatch: cachedTransport });
  assert.equal(await unrelated.request('Speaker stand FICT1505'), 'FICT1505 充电器外壳', 'contextual replacement must not affect an unrelated source');
});

test('preserves legitimate SKU/numeric passthrough and requires models and numbers in translations', { timeout: 5000 }, async () => {
  const transport = mock.fn(async () => assert.fail('SKU passthrough must not call a transport'));
  const queue = engine({ requestBatch: transport });
  for (const sku of ['FICT-1200', '36', '1.5M', 'USB-C', 'FICT1200 (2 MIC)']) {
    assert.equal(passthrough(sku), true, sku);
    assert.equal(await queue.request(sku), sku);
  }
  assert.equal(transport.mock.callCount(), 0);
  assert.equal(usable('FICT1200', '蓝色'), false, 'a cached Chinese label must not erase a SKU');
  const source = 'Wireless speaker FICTION-203 12V 2 pieces';
  assert.equal(usable(source, '无线音箱 FICTION-203 12V，2件'), true);
  assert.equal(usable(source, '无线音箱 203 12V，2件'), false, 'model letters must remain');
  assert.equal(usable(source, '无线音箱 FICTION-203 12V'), false, 'quantity must remain');
  assert.equal(usable(source, '无线音箱 FICTION-203 2件'), false, 'voltage must remain');
  assert.equal(usable('Wireless speaker FICT203 1.5m 4 pieces', '无线音箱 FICT203 15m 4件'), false, 'a decimal value must not change magnitude');
  assert.equal(usable('Wireless speaker FICT203 12V 2 pieces', 'FICT203无线音箱，含12V充电器和2件配件'), true, 'Chinese text may directly adjoin preserved numbers');
  assert.equal(usable('Wireless speaker FICT203 1.5m 4 pieces', '无线音箱 FICT203 1,5米 4件'), true, 'a decimal comma preserves the original decimal value');
  const portuguese = 'Kit Controle Remoto Aurora ZX901 com Fonte 12V e 2 Cabos';
  assert.equal(usable(portuguese, 'Aurora ZX 901远程控制套件，带12 V电源和双电缆'), true, 'dual cables preserve a quantity of two');
  assert.equal(usable(portuguese, 'Aurora ZX 901远程控制套件，带12 V电源和两根电缆'), true, 'a Chinese quantity preserves a quantity of two');
  assert.equal(usable(portuguese, 'Aurora ZX 901远程控制套件，带12 V电源和电缆'), false, 'the cable quantity must not disappear');
});

test('color plus SKU translates locally without truncating a SKU that begins with a color word', { timeout: 5000 }, async () => {
  const transport = mock.fn(async () => assert.fail('color/SKU variants should translate locally'));
  const queue = engine({ requestBatch: transport });
  for (const [source, expected] of [
    ['Preto ZX901', '黑色 ZX901'],
    ['ZX902 black', 'ZX902 黑色'],
    ['white - AB-1200', '白色 AB-1200'],
    ['สีดำ ZX903', '黑色 ZX903'],
    ['Màu trắng ZX904', '白色 ZX904']
  ]) assert.equal(await queue.request(source), expected);
  for (const sku of ['REDFOX12', 'BLACKBIRD12', 'GOLDSTAG01']) assert.equal(await queue.request(sku), sku);
  assert.equal(transport.mock.callCount(), 0);
});

test('already Chinese specifications with uppercase models remain local passthrough', { timeout: 5000 }, async () => {
  const transport = mock.fn(async () => assert.fail('Chinese model specifications must not use a transport'));
  const queue = engine({ requestBatch: transport });
  for (const source of ['V70 U（白色，新）', 'FICT-123（蓝色）', 'FICT 12V（白色）']) {
    assert.equal(passthrough(source), true);
    assert.equal(usable(source, source), true);
    assert.equal(await queue.request(source), source);
  }
  assert.equal(passthrough('Wireless speaker（白色）'), false, 'ordinary English text still needs translation');
  assert.equal(transport.mock.callCount(), 0);
});

test('splits only failed items, retains good batch results and eventually resolves permanent failures', { timeout: 5000 }, async () => {
  const sources = Array.from({ length: 4 }, (_, i) => 'Wireless speaker FICT' + (401 + i));
  const transport = mock.fn(async texts => {
    if (texts.length > 1) return [chineseFor(texts[0]), texts[1], chineseFor(texts[2]), ''];
    return [texts[0] === sources[3] ? '' : chineseFor(texts[0])];
  });
  const onError = mock.fn();
  const queue = engine({ requestBatch: transport, onError, concurrency: 1, batchSize: 12 });
  queue.setPaused(true);
  const pending = sources.map(text => queue.request(text));
  queue.setPaused(false);
  assert.deepEqual(await Promise.all(pending), [chineseFor(sources[0]), chineseFor(sources[1]), chineseFor(sources[2]), '']);
  const batches = transport.mock.calls.map(call => call.arguments[0]);
  assert.equal(batches[0].length, 4);
  assert.ok(batches.slice(1).every(texts => texts.length === 1));
  const occurrences = source => batches.flat().filter(text => text === source).length;
  assert.equal(occurrences(sources[0]), 1, 'first good result is not retried');
  assert.equal(occurrences(sources[2]), 1, 'second good result is not retried');
  assert.equal(occurrences(sources[1]), 2, 'recoverable item gets one isolated retry');
  assert.equal(occurrences(sources[3]), 3, 'permanent failure stops after bounded attempts');
  assert.equal(queue.stats.completed, 3);
  assert.equal(queue.stats.failed, 1);
  assert.equal(onError.mock.callCount(), 1);
  assert.equal(queue.jobs.size, 0);
});

test('pause permits active work to finish and holds pending jobs until resume', { timeout: 5000 }, async () => {
  const gate = deferred();
  const transport = mock.fn(async texts => {
    if (texts[0] === 'Wireless speaker FICT501') await gate.promise;
    return texts.map(chineseFor);
  });
  const queue = engine({ requestBatch: transport, concurrency: 1, batchSize: 1 });
  const first = queue.request('Wireless speaker FICT501');
  await waitFor(() => transport.mock.callCount() === 1, 'first active request');
  queue.setPaused(true);
  let secondSettled = false;
  const second = queue.request('Wireless speaker FICT502').then(value => {
    secondSettled = true;
    return value;
  });
  gate.resolve();
  assert.equal(await first, chineseFor('Wireless speaker FICT501'));
  await waitFor(() => queue.active === 0, 'active work finishing while paused');
  assert.equal(transport.mock.callCount(), 1);
  assert.equal(secondSettled, false);
  assert.equal(queue.jobs.size, 1);
  assert.equal(queue.queue.length, 1);
  queue.setPaused(false);
  assert.equal(await second, chineseFor('Wireless speaker FICT502'));
  assert.equal(transport.mock.callCount(), 2);
});
