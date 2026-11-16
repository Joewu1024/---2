'use strict';

// Exercises the actual marked workbench functions with a fake DOM and IndexedDB.
// No application boot code or external transport is run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, afterEach, mock } = require('node:test');
const BuyerTranslation = require('../translation-engine.js');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const lines = html.split(/\r?\n/);
const instances = new Set();

function block(label) {
  const start = html.indexOf('// ' + label + ':start');
  const end = html.indexOf('// ' + label + ':end', start);
  assert.ok(start >= 0 && end > start, 'missing source block: ' + label);
  return html.slice(start, end);
}

function lineStarting(prefix) {
  const line = lines.find(text => text.startsWith(prefix));
  assert.ok(line, 'missing source definition: ' + prefix);
  return line;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function chineseFor(text) {
  const models = text.match(/\b[A-Z]{1,8}[-]?\d+[A-Z0-9-]*\b/g) || [];
  const digits = text.match(/\d+(?:[.,]\d+)*/g) || [];
  return ['虚构商品中文译文', ...models, ...digits].join(' ');
}

async function waitFor(condition, message, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail('Timed out: ' + message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function harness(options = {}) {
  const timers = new Set(), elements = new Map();
  const controls = { editors: [], flushes: 0, persisted: [], renders: 0, cacheWrites: [], parse: null };
  const cacheGate = options.cacheGate || { promise: Promise.resolve() };
  const setTimer = (callback, delay, ...args) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(...args); }, delay);
    timers.add(timer);
    return timer;
  };
  const clearTimer = timer => { timers.delete(timer); clearTimeout(timer); };
  const document = {
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { textContent: '', value: '', disabled: false });
      return elements.get(id);
    },
    querySelectorAll(selector) {
      return selector === 'textarea.translation-editor' || selector === '[data-edit]' ? controls.editors : [];
    }
  };
  const db = {
    transaction(name, mode) {
      const transaction = {
        objectStore: () => ({
          getAll() {
            const request = {};
            cacheGate.promise.then(() => {
              request.result = options.idbCache || [];
              request.onsuccess?.();
            });
            return request;
          },
          put(record) { controls.cacheWrites.push(record); }
        })
      };
      if (mode === 'readwrite') queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    }
  };
  const transport = options.transport || mock.fn(async texts => texts.map(chineseFor));
  const context = vm.createContext({
    BuyerTranslation, controls, document, console,
    referenceTranslationCache: new Map(options.bakedCache || []),
    setTimeout: setTimer, clearTimeout: clearTimer, queueMicrotask,
    localStorage: { getItem: key => key === 'sourcing-cn-cache-v2' && options.localCache ? JSON.stringify(options.localCache) : null },
    indexedDB: { open() { const request = {}; queueMicrotask(() => { request.result = db; request.onsuccess?.(); }); return request; } },
    window: { addEventListener() {} },
    fetch() { throw new Error('Network access is forbidden in translation-integration checks'); },
    AbortController, URL, crypto: { randomUUID: () => 'fabricated-test-id' },
    transport
  });
  const extracted = [
    lineStarting('const H='),
    lineStarting('const rawLookupCache='),
    lineStarting('const keyMap='),
    ...['key', 'getRaw', 'invalidateRaw', 'value', 'aliasFor', 'deriveRecord', 'bindTable', 'markDirty', 'save', 'mergeBuyerEdits'].map(name => lineStarting('function ' + name + '(')),
    lineStarting('async function importFile('),
    block('translation-state-v3'), block('translation-integration-v3')
  ].join('\n');
  const api = vm.runInContext(`(function(){
    let rows=[], visibleRows=[], historyMode=false, dirtyRows=new Set();
    let hasUnsavedChanges=false, saveAllPending=false, saveTimer=null;
    let headers=[], sourceFileName='', groupingEnabled=false, activeHashRun=0;
    let opened=new Set(), selected=new Set(), filters={}, pageIndex=0;
    function extractBrand(){return ''} function extractStyle(){return ''} function extractQty(){return ''}
    function idFor(r){return String(getRaw(r,['Model ID'])||r.uid)}
    function normalizeModelId(value){return String(value||'')}
    function updateCalculatedCells(){} function rememberBuyerOption(){}
    async function regroup(){}
    function render(){controls.renders++;queueVisibleTranslation()}
    async function flushSave(){
      if(historyMode)return true;
      controls.flushes++;controls.persisted=rows.map(r=>({uid:r.uid,raw:{...r.raw}}));
      dirtyRows.clear();saveAllPending=false;hasUnsavedChanges=false;return true;
    }
    async function parseCsv(file){return controls.parse(file)}
    async function parseXlsx(file){return controls.parse(file)}
    function returnToCurrent(){historyMode=false}
    function runDeferredProcessing(){}
    ${extracted}
    translationQueue.options.requestBatch=transport;
    return {
      H, queue:translationQueue, cache:translationCache, ready:translationCacheReady,
      deriveRecord, translateVisible, startBackgroundTranslation, queueVisibleTranslation,
      refreshTranslationEditors, updateTranslationStatus, bindTable, importFile,
      get readyCount(){return translationReadyCount}, get rows(){return rows},
      get dirty(){return dirtyRows},
      setRows(next,{history=false,sync=true,visible=next}={}){
        rows=next;visibleRows=visible;historyMode=history;if(sync)syncTranslationDataset();
      },
      setRaw(r,index,value){r.raw[H[index]]=value;invalidateRaw(r)},
      stop(){translationUserPaused=true;translationBackgroundRun++;translationQueue.setPaused(true);translationQueue.cancelQueued()}
    };
  })()`, context, { filename: 'extracted-workbench-integration.js' });
  const instance = { ...api, api, controls, document, elements, timers, transport };
  // Preserve getters on the VM bridge rather than copying their initial values.
  instances.add(instance);
  return instance;
}

afterEach(() => {
  for (const instance of instances) {
    instance.api.stop();
    for (const timer of instance.timers) clearTimeout(timer);
    instance.timers.clear();
  }
  instances.clear();
});

function record(h, id, item, chinese) {
  const r = { uid: id, raw: { [h.api.H[9]]: item, [h.api.H[11]]: '' } };
  if (chinese !== undefined) r.raw[h.api.H[10]] = chinese;
  return r;
}

function editor(h, r, field = h.api.H[10]) {
  const element = { dataset: { id: r.uid, field, edit: 'raw' }, tagName: 'TEXTAREA', type: 'textarea', isConnected: true, value: r.raw[field] || '' };
  h.controls.editors.push(element);
  h.api.refreshTranslationEditors();
  return element;
}

test('embedded engine is identical to the separately tested engine', () => {
  const embedded = html.match(/<script data-buyer-translation-engine="v3">([\s\S]*?)<\/script>/);
  assert.ok(embedded);
  assert.equal(embedded[1].trim(), fs.readFileSync(path.join(root, 'translation-engine.js'), 'utf8').trim());
});

test('cache loading filters bad baked/local entries and completes before requesting translation', { timeout: 5000 }, async () => {
  const gate = deferred();
  const source = 'Wireless speaker FICT701';
  const h = harness({
    cacheGate: gate,
    bakedCache: [['Wireless speaker FICT702', 'Wireless speaker FICT702']],
    localCache: [['Wireless speaker FICT703', '译文 ZXQ0001QXZ FICT703']],
    idbCache: [{ source, chinese: chineseFor(source) }]
  });
  const r = record(h, 'cache', source);
  h.api.setRows([r]);
  const pending = h.api.translateVisible([r]);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(h.transport.mock.callCount(), 0);
  gate.resolve();
  await pending;
  assert.equal(h.transport.mock.callCount(), 0);
  assert.equal(r.raw[h.api.H[10]], chineseFor(source));
  assert.equal(h.api.cache.has('Wireless speaker FICT702'), false);
  assert.equal(h.api.cache.has('Wireless speaker FICT703'), false);
});

test('derive leaves missing translation empty and respects manual text and intentional blanks', async () => {
  const h = harness();
  await h.api.ready;
  const missing = record(h, 'missing', 'Wireless speaker FICT711');
  const manual = record(h, 'manual', 'Wireless speaker FICT712', 'BUYER SKU ONLY');
  const blank = record(h, 'blank', 'Wireless speaker FICT713', '');
  manual.userEditedFields = ['item name 中文'];
  blank.userEditedFields = [h.api.H[10]];
  h.api.setRows([missing, manual, blank]);
  [missing, manual, blank].forEach(r => h.api.deriveRecord(r));
  assert.equal(missing.raw[h.api.H[10]], '');
  assert.equal(missing.localTranslatedItem, false);
  assert.equal(manual.raw[h.api.H[10]], 'BUYER SKU ONLY');
  assert.equal(manual.autoItemChinese, false);
  assert.equal(blank.raw[h.api.H[10]], '');
  assert.equal(blank.autoItemChinese, false);
});

test('main-file rows without manual metadata repair old foreign text, ZXQ garbage and untranslated fragments', { timeout: 5000 }, async () => {
  const h = harness();
  const records = [
    record(h, 'old-foreign', 'Wireless speaker FICT1401', 'Wireless speaker, FICT1401'),
    record(h, 'old-fragment', 'Wireless rechargeable portable speaker FICT1402', '中文 Wireless rechargeable portable speaker FICT1402'),
    record(h, 'old-marker', 'Microphone FICT1403', '异常 ZXQ0001QXZ FICT1403')
  ];
  h.api.setRows(records);
  for (const r of records) {
    h.api.deriveRecord(r);
    assert.equal(r.autoItemChinese, true);
    assert.equal(r.raw[h.api.H[10]], '');
  }
  await h.api.translateVisible(records);
  for (const r of records) assert.equal(r.raw[h.api.H[10]], chineseFor(r.raw[h.api.H[9]]));
});

test('cached and existing automatic terminology reaches the editor while manual terminology is preserved', { timeout: 5000 }, async () => {
  const source = 'Kit Controle Remoto Aurora ZX901 com Fonte 12V e 2 Cabos';
  const oldTerm = 'Aurora ZX901远程控制套件，带12V电源和2根电缆';
  const h = harness({ bakedCache: [[source, oldTerm]] });
  const fromCache = record(h, 'cached-term', source);
  const existing = record(h, 'existing-term', source, oldTerm);
  existing.autoItemChinese = true;
  existing.localTranslatedItem = true;
  existing.translationItemSource = source;
  const manual = record(h, 'manual-term', source, oldTerm);
  manual.userEditedFields = [h.api.H[10]];
  h.api.setRows([fromCache, existing, manual]);
  const cachedEditor = editor(h, fromCache), existingEditor = editor(h, existing);
  await h.api.translateVisible([fromCache, existing, manual]);
  for (const r of [fromCache, existing]) assert.match(r.raw[h.api.H[10]], /遥控器套装/);
  assert.match(cachedEditor.value, /遥控器套装/);
  assert.match(existingEditor.value, /遥控器套装/);
  assert.equal(manual.raw[h.api.H[10]], oldTerm);
  assert.equal(h.transport.mock.callCount(), 0);
});

test('successful translation updates the current editor and triggers scheduled workbench persistence', { timeout: 5000 }, async () => {
  const h = harness();
  const source = 'Wireless speaker FICT721';
  const r = record(h, 'saved', source);
  h.api.setRows([r]);
  const element = editor(h, r);
  await h.api.translateVisible([r]);
  assert.equal(r.raw[h.api.H[10]], chineseFor(source));
  assert.equal(element.value, chineseFor(source));
  assert.equal(r.translationItemSource, source);
  assert.equal(r.localTranslatedItem, true);
  assert.equal(h.api.readyCount, 1);
  await waitFor(() => h.controls.flushes > 0, 'automatic save after a translation');
  assert.equal(h.controls.persisted[0].raw[h.api.H[10]], chineseFor(source));
});

test('a late response cannot overwrite a buyer edit', { timeout: 5000 }, async () => {
  const gate = deferred();
  const transport = mock.fn(async texts => { await gate.promise; return texts.map(chineseFor); });
  const h = harness({ transport });
  const r = record(h, 'manual-late', 'Wireless speaker FICT731');
  h.api.setRows([r]);
  const element = editor(h, r);
  h.api.bindTable();
  const pending = h.api.translateVisible([r]);
  await waitFor(() => transport.mock.callCount() === 1, 'pending automatic translation');
  element.value = '买手确认的名称 FICT731';
  element.oninput();
  gate.resolve();
  await pending;
  assert.equal(r.raw[h.api.H[10]], element.value);
  assert.equal(r.autoItemChinese, false);
  assert.ok(r.userEditedFields.includes(h.api.H[10]));
});

test('editing source text invalidates an old response while the new source still translates', { timeout: 5000 }, async () => {
  const gates = new Map();
  const transport = mock.fn(async texts => {
    const gate = deferred();gates.set(texts[0], gate);
    await gate.promise;return texts.map(chineseFor);
  });
  const h = harness({ transport });
  const oldSource = 'Wireless speaker FICT741', newSource = 'Microphone FICT742';
  const r = record(h, 'source-edit', oldSource);
  h.api.setRows([r]);
  const oldPending = h.api.translateVisible([r]);
  await waitFor(() => gates.has(oldSource), 'old source pending');
  h.api.setRaw(r, 9, newSource);
  h.api.deriveRecord(r);
  const newPending = h.api.translateVisible([r]);
  await waitFor(() => gates.has(newSource), 'new source pending');
  gates.get(oldSource).resolve();
  await oldPending;
  assert.equal(r.raw[h.api.H[10]], '');
  assert.equal(r.localTranslatedItem, false);
  gates.get(newSource).resolve();
  await newPending;
  assert.equal(r.raw[h.api.H[10]], chineseFor(newSource));
  assert.equal(r.translationItemSource, newSource);
});

test('dataset replacement with the same UID cannot receive an older dataset response', { timeout: 5000 }, async () => {
  const gate = deferred();
  const transport = mock.fn(async texts => { await gate.promise;return texts.map(chineseFor); });
  const h = harness({ transport });
  const old = record(h, 'reused-id', 'Wireless speaker FICT751');
  h.api.setRows([old]);
  const pending = h.api.translateVisible([old]);
  await waitFor(() => transport.mock.callCount() === 1, 'old dataset request');
  const next = record(h, 'reused-id', 'Microphone FICT752', '新数据界面保留文字');
  h.api.setRows([next]);
  const element = editor(h, next);
  gate.resolve();await pending;
  assert.equal(old.raw[h.api.H[10]], '');
  assert.equal(next.raw[h.api.H[10]], '新数据界面保留文字');
  assert.equal(element.value, '新数据界面保留文字');
});

test('history mode rejects responses without altering historical data or its editor', { timeout: 5000 }, async () => {
  const gate = deferred();
  const transport = mock.fn(async texts => { await gate.promise;return texts.map(chineseFor); });
  const h = harness({ transport });
  const live = record(h, 'same-id', 'Wireless speaker FICT761');
  h.api.setRows([live]);
  const pending = h.api.translateVisible([live]);
  await waitFor(() => transport.mock.callCount() === 1, 'live request');
  const historical = record(h, 'same-id', 'Wireless speaker FICT761', '历史中已保存的标题');
  h.api.setRows([historical], { history: true });
  const element = editor(h, historical);
  h.api.queueVisibleTranslation();
  gate.resolve();await pending;
  assert.equal(live.raw[h.api.H[10]], '');
  assert.equal(historical.raw[h.api.H[10]], '历史中已保存的标题');
  assert.equal(element.value, '历史中已保存的标题');
});

test('manual edits immediately update readiness counts in both directions', async () => {
  const h = harness();
  await h.api.ready;
  const source = 'Wireless speaker FICT771';
  const r = record(h, 'count', source, chineseFor(source));
  h.api.setRows([r]);
  const element = editor(h, r);
  h.api.bindTable();
  assert.equal(h.api.readyCount, 1);
  element.value = '';
  element.oninput();
  assert.equal(h.api.readyCount, 0);
  element.value = '买手确认无线音箱 FICT771';
  element.oninput();
  assert.equal(h.api.readyCount, 1);
});

test('every visible row is promoted, including rows beyond the former 150-row cap', { timeout: 5000 }, async () => {
  const h = harness();
  await h.api.ready;
  const records = Array.from({ length: 180 }, (_, i) => record(h, 'visible-' + i, 'Wireless speaker FICT' + (800 + i)));
  h.api.setRows(records);
  h.api.queue.setPaused(true);
  h.api.queueVisibleTranslation();
  await waitFor(() => h.api.queue.jobs.size === 180, 'all visible rows queued');
  assert.equal(h.transport.mock.callCount(), 0);
  assert.ok(h.api.queue.queue.every(job => job.priority === 0));
  assert.equal(h.api.queue.queue.find(job => job.text === 'Wireless speaker FICT979').priority, 0);
});

test('background processing covers multiple 120-row chunks and saves the final rows', { timeout: 7000 }, async () => {
  const h = harness();
  const records = Array.from({ length: 245 }, (_, i) => record(h, 'background-' + i, 'Wireless speaker FICT' + (1001 + i)));
  h.api.setRows(records, { visible: records.slice(0, 3) });
  await h.api.startBackgroundTranslation();
  assert.ok(records.every(r => r.localTranslatedItem && r.translationItemSource === r.raw[h.api.H[9]]));
  assert.equal(h.api.readyCount, 245);
  assert.equal(h.api.queue.stats.completed, 245);
  await waitFor(() => h.controls.persisted.length === 245, 'background save');
  assert.equal(h.controls.persisted[244].raw[h.api.H[10]], chineseFor('Wireless speaker FICT1245'));
});

for (const outcome of ['success', 'failure']) {
  test('a superseded main-file import cannot roll back a later import after ' + outcome, { timeout: 5000 }, async () => {
    const h = harness();
    await h.api.ready;
    h.api.queue.setPaused(true);
    const oldParse = deferred(), newParse = deferred();
    h.controls.parse = file => file.name === 'old.csv' ? oldParse.promise : newParse.promise;
    const oldImport = h.api.importFile({ name: 'old.csv', type: 'text/csv' });
    const newImport = h.api.importFile({ name: 'new.csv', type: 'text/csv' });
    const wanted = record(h, 'new-file', 'Wireless speaker FICT1301');
    newParse.resolve({ headers: Array.from(h.api.H), rows: [wanted] });
    await newImport;
    assert.strictEqual(h.api.rows[0], wanted);
    if (outcome === 'success') oldParse.resolve({ headers: Array.from(h.api.H), rows: [record(h, 'old-file', 'Wireless speaker FICT1302')] });
    else oldParse.reject(new Error('Fabricated old parse failure'));
    await oldImport;
    assert.strictEqual(h.api.rows[0], wanted);
  });
}
