'use strict';

// Fabricated titles and identifiers only; no files, accounts or network data.
const assert = require('node:assert/strict');
const { test, after, mock } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
require('../translation-engine.js');
const api = require('../workbench-translation-tasks.js');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
if (typeof globalThis.fetch === 'function') mock.method(globalThis, 'fetch', () => { throw new Error('Translation task checks must stay offline'); });
after(() => mock.restoreAll());

function item(index, extra = {}) {
  const source = 'Portable speaker QA' + (100000 + index) + ' 5 W';
  return { source, language: 'en', references: [{ modelId: '9' + String(index + 1).padStart(20, '0'), field: 'item name中文', source }], ...extra };
}
const translated = index => '便携音箱 QA' + (100000 + index) + ' 5 W';
const input = items => api.createTask(items, { id: A });
const roundtrip = value => JSON.parse(JSON.stringify(value));

test('UMD works independently and only exports keys and titles, keeping business mappings local', async () => {
  const sandbox = { setTimeout };
  vm.runInNewContext(fs.readFileSync(require.resolve('../workbench-translation-tasks.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.WorkbenchTranslationTasks.createTask, 'function');
  const entry = item(0); entry.references[0].price = 'PRIVATE_PRICE_FAKE'; entry.references[0].note = 'PRIVATE_NOTE_FAKE';
  const { task, table } = await input([entry]);
  assert.deepEqual(table.headers, ['任务键', '待翻译原文']);
  assert.equal(table.data.length, 1); assert.equal(table.data[0].length, 2);
  assert.equal(table.data[0][1], entry.source);
  assert.match(table.data[0][0], /^GTASK-11111111-1111-4111-8111-111111111111-00000001$/);
  const exported = JSON.stringify(table);
  assert.doesNotMatch(exported, /900000000000000000001|PRIVATE_PRICE_FAKE|PRIVATE_NOTE_FAKE|modelId|references/);
  assert.deepEqual(Object.keys(task.entries[0].references[0]).sort(), ['field', 'modelId', 'source']);
  entry.references[0].source = 'later mutation';
  assert.equal(task.entries[0].references[0].source, 'Portable speaker QA100000 5 W');
  assert.equal(task.id, A); assert.ok(Number.isFinite(Date.parse(task.createdAt)));
});

test('source deduplication normalizes whitespace and NFC and retains distinct local references', async () => {
  const one = item(0), two = item(0, { source: '  Portable\n speaker QA100000 5 W  ', language: 'auto' });
  two.references = [{ modelId: '000000000000000000001', field: 12, source: two.source }];
  const { task, table } = await input([one, two, one]);
  assert.equal(task.entries.length, 1); assert.equal(table.data.length, 1);
  assert.equal(task.entries[0].references.length, 2); assert.equal(task.entries[0].language, 'auto');
  const result = await api.decodeResult(roundtrip(task), [[task.entries[0].key.toLowerCase().split('').join(' '), translated(0)]]);
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0].references[1].source, two.source);
  assert.equal(result.entries[0].references[1].field, 12);
});

test('decoding ignores row order and translated headers; only exact normalized synthetic keys select fields', async () => {
  const { task } = await input([item(0), item(1), item(2)]);
  const matrix = [[task.entries[2].key, translated(2)], ['Translated task heading', 'Translated source heading'],
    ['\t' + task.entries[0].key.toLowerCase() + ' \n', translated(0)], [task.entries[1].key, translated(1)]];
  const result = await api.decodeResult(task, matrix);
  assert.deepEqual(result.entries.map(entry => entry.translation), [translated(0), translated(1), translated(2)]);
  assert.deepEqual(result.entries.map(entry => entry.references[0].modelId), task.entries.map(entry => entry.references[0].modelId));
  assert.equal(result.missing, 0); assert.equal(result.unknown, 0); assert.equal(result.counts.ignoredRows, 1);
});

test('conflicts, missing keys, unchanged foreign titles, empty/invalid translations and placeholder markers never backfill', async () => {
  const values = Array.from({ length: 9 }, (_, i) => item(i));
  const { task } = await input(values), keys = task.entries.map(entry => entry.key);
  const result = await api.decodeResult(task, [
    [keys[0], translated(0)], [keys[0].toLowerCase(), '  ' + translated(0) + '  '],
    [keys[1], translated(1)], [keys[1], '另一种音箱 QA100001 5 W'],
    [keys[2], ''], [keys[3], values[3].source], [keys[4], '音箱 ZXQ000012QXZ QA100004 5 W'],
    [keys[6], 'different foreign output'], [keys[7], '音箱 \uFFFD QA100007'],
    [keys[8], ''], [keys[8], translated(8)],
    ['GTASK-' + B + '-00000001', translated(0)], [' gtask-' + B + '-00000001 ', translated(0)],
    ['GTASK-BROKEN', '未知任务译文'], ['Google can translate any heading', '原文列']
  ]);
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0].key, keys[0]);
  assert.equal(result.missing, 8); assert.equal(result.conflicts, 2); assert.equal(result.unknown, 2);
  assert.deepEqual(result.conflictKeys, [keys[1], keys[8]]);
  assert.equal(result.counts.empty, 1); assert.equal(result.counts.untranslated, 1);
  assert.equal(result.counts.markers, 1); assert.equal(result.counts.invalid, 2);
  assert.equal(result.counts.duplicates, 3); assert.equal(result.counts.ignoredRows, 1);
  assert.equal(result.rejectedEntries.find(entry => entry.key === keys[5]).reason, 'missing');
});

test('a different or old task file cannot backfill a new task, even when source text is identical', async () => {
  const old = await input([item(0), item(1)]);
  const current = await api.createTask([item(0), item(1)], { id: B });
  const result = await api.decodeResult(current.task, old.table.data.map((row, i) => [row[0], translated(i)]));
  assert.equal(result.entries.length, 0); assert.equal(result.missing, 2); assert.equal(result.unknown, 2);
  assert.equal(result.taskId, B);
});

test('Chinese text, unchanged model codes and connectors are valid without forcing Chinese into model identifiers', async () => {
  const sources = ['这是中文标题 QA123', 'QA123', 'USB-C', 'Black'];
  const { task } = await input(sources.map(source => ({ source, references: [] })));
  const result = await api.decodeResult(task, task.entries.map(entry => [entry.key, entry.source]));
  assert.deepEqual(result.entries.map(entry => entry.translation), sources.slice(0, 3));
  assert.equal(result.missing, 1); assert.equal(result.counts.untranslated, 1);
  const permissive = await api.decodeResult(task, task.entries.map(entry => [entry.key, entry.source]), { validate: () => true });
  assert.equal(permissive.counts.untranslated, 1, 'A custom validator cannot accept unchanged foreign text');
});

test('standalone conservative validation handles Chinese and digit-bearing model text', async () => {
  const sandbox = { setTimeout };
  vm.runInNewContext(fs.readFileSync(require.resolve('../workbench-translation-tasks.js'), 'utf8'), sandbox);
  const independent = sandbox.WorkbenchTranslationTasks;
  const { task } = await independent.createTask([{ source: 'QA123' }, { source: '中文标题' }, { source: 'Portable speaker' }], { id: A });
  const result = await independent.decodeResult(task, task.entries.map(entry => [entry.key, entry.source]));
  assert.equal(result.entries.length, 2); assert.equal(result.counts.untranslated, 1);
});

test('invalid or damaged inputs fail closed, including source/reference mismatches and numeric model IDs', async () => {
  await assert.rejects(api.createTask([item(0)], { id: 'BUSINESS-ID-FAKE' }), /编号/);
  await assert.rejects(api.createTask([item(0)], { crypto: null }), /安全创建/);
  for (const entries of [null, [{ source: '' }], [{ source: 42 }], [{ source: 'a'.repeat(32768) }],
    [{ source: 'Valid', references: {} }], [{ source: 'Valid', references: [{ modelId: 123, field: 10, source: 'Valid' }] }],
    [{ source: 'Valid', references: [{ modelId: 'FAKE', field: 10, source: 'Different' }] }]]) {
    await assert.rejects(input(entries), /翻译任务|映射/);
  }
  const { task } = await input([item(0)]), damagedKey = roundtrip(task), damagedSource = roundtrip(task);
  damagedKey.entries[0].key = 'GTASK-' + B + '-00000001';
  damagedSource.entries[0].references[0].source = 'Changed local source';
  await assert.rejects(api.decodeResult(damagedKey, []), /映射已损坏/);
  await assert.rejects(api.decodeResult(damagedSource, [[task.entries[0].key, translated(0)]]), /原文已损坏/);
  await assert.rejects(api.decodeResult(task, ['not a matrix row']), /无效数据行/);
  await assert.rejects(api.decodeResult(null, []), /任务缺失/);
  const empty = await input([]), decoded = await api.decodeResult(empty.task, []);
  assert.deepEqual(empty.table.data, []); assert.equal(decoded.missing, 0);
  const secureFallback = await api.createTask([], { crypto: { getRandomValues(bytes) { bytes.fill(170); return bytes; } } });
  assert.equal(secureFallback.task.id, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
});

test('cancellation is supported before and during asynchronous batches', async () => {
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(api.createTask([item(0)], { id: A, signal: cancelled.signal }), { name: 'AbortError' });
  const { task } = await input([item(0)]);
  await assert.rejects(api.decodeResult(task, [], { signal: cancelled.signal }), { name: 'AbortError' });
  const controller = new AbortController();
  const pending = api.createTask(Array.from({ length: 20000 }, (_, i) => item(i)), { id: A, signal: controller.signal });
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(pending, { name: 'AbortError' });
});

test('20,000 unique sources deduplicate, survive shuffled result rows and retain all 40,000 local mappings', async () => {
  const sourceCount = 20000, inputs = [];
  for (let i = 0; i < sourceCount; i++) {
    inputs.push(item(i));
    const other = item(i); other.references[0].modelId = '8' + String(i + 1).padStart(20, '0'); other.references[0].field = 12;
    inputs.push(other);
  }
  const metrics = [];
  async function measure(phase, action) {
    let ticks = 0, last = performance.now(), maxGap = 0;
    const timer = setInterval(() => { const time = performance.now(); maxGap = Math.max(maxGap, time - last); last = time; ticks++; }, 5);
    const started = performance.now();
    try {
      const result = await action();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.ok(ticks > 2, 'The parent event loop must continue during batched ' + phase);
      metrics.push({ phase, elapsedMilliseconds: +(performance.now() - started).toFixed(1), parent5msHeartbeatTicks: ticks, maxObservedTimerGapMilliseconds: +maxGap.toFixed(1) });
      return result;
    } finally { clearInterval(timer); }
  }
    const { task, table } = await measure('createTask', () => input(inputs));
    assert.equal(task.entries.length, sourceCount); assert.equal(table.data.length, sourceCount);
    assert.doesNotMatch(JSON.stringify(table), /[89]\d{20}/);
    const matrix = task.entries.map((entry, i) => [entry.key, translated(i)]);
    // Deterministic Fisher-Yates shuffle; no row-order mapping can pass this.
    let seed = 123456789;
    for (let i = matrix.length - 1; i > 0; i--) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const j = seed % (i + 1); [matrix[i], matrix[j]] = [matrix[j], matrix[i]]; }
    matrix.splice(8912, 0, ['A translated header', 'Any heading']);
    for (let i = 0; i < sourceCount; i += 1000) matrix.push([task.entries[i].key.toLowerCase(), translated(i)]);
    matrix.push(['GTASK-' + B + '-00000001', translated(0)]);
    const persistedTask = roundtrip(task);
    const result = await measure('decodeResult', () => api.decodeResult(persistedTask, matrix));
    assert.equal(result.entries.length, sourceCount); assert.equal(result.missing, 0);
    assert.equal(result.unknown, 1); assert.equal(result.counts.duplicates, 20); assert.equal(result.counts.ignoredRows, 1);
    for (let i = 0; i < sourceCount; i++) {
      const entry = result.entries[i];
      assert.equal(entry.source, item(i).source); assert.equal(entry.translation, translated(i));
      assert.equal(entry.references.length, 2);
      assert.equal(entry.references[0].modelId, '9' + String(i + 1).padStart(20, '0'));
      assert.equal(entry.references[1].modelId, '8' + String(i + 1).padStart(20, '0'));
      assert.equal(entry.references[1].field, 12);
    }
    console.log(JSON.stringify({ fabricatedOnly: true, uniqueSources: sourceCount, localReferences: 40000,
      exactKeyMappings: result.entries.length, shuffled: true, metrics, networkRequests: 0 }));
    const controller = new AbortController();
    const interrupted = api.decodeResult(persistedTask, matrix, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(interrupted, { name: 'AbortError' });
});
