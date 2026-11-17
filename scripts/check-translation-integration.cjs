'use strict';

// Exercises the actual marked workbench functions with a fake DOM and IndexedDB.
// No application boot code or external transport is run. Provider fixtures
// validate routing and exact propagation; they do not prove live Google/Chrome quality.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, afterEach, mock } = require('node:test');
const BuyerTranslation = require('../translation-engine.js');
const BuyerGoogleTranslation = require('../translation-google-provider.js');
const root = path.join(__dirname, '..');
const documentHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const html = Array.from(documentHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)).at(-1)[1];
const lines = html.split(/\r?\n/);
const instances = new Set();
const TRANSLATION_VERSION = 'google-v5-20261117';

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

function between(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'missing source range: ' + start);
  return html.slice(from, to);
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
  const controls = { writable: true, editors: [], flushes: 0, persisted: [], renders: 0, cacheWrites: [], cacheDatabases: [], categoryCalls: 0, shareSnapshots: [], parse: null };
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
    BuyerTranslation, BuyerGoogleTranslation, controls, document, console,
    BuyerChromeTranslation: options.chromeProvider ? { create:()=>options.chromeProvider } : undefined,
    Translator: options.chromeProvider ? {} : undefined,
    workspace: { isDefault:true, created:false, dbName:base=>base||'buyer-pool-workbench', storageKey:base=>base },
    referenceTranslationCache: new Map(options.bakedCache || []),
    setTimeout: setTimer, clearTimeout: clearTimer, queueMicrotask,
    localStorage: { getItem: key => key === 'sourcing-cn-cache-v2' && options.localCache ? JSON.stringify(options.localCache) : null },
    indexedDB: { open(name) { controls.cacheDatabases.push(name); const request = {}; queueMicrotask(() => { request.result = db; request.onsuccess?.(); }); return request; } },
    window: { addEventListener() {} },
    fetch: options.fetch || (() => { throw new Error('Network access is forbidden in translation-integration checks'); }),
    AbortController, URL, TextEncoder,
    location: { hostname: 'buyer.example.test', protocol: 'https:', href: 'https://buyer.example.test/index.html' },
    crypto: { randomUUID: () => 'fabricated-test-id' },
    transport
  });
  const extracted = [
    lineStarting('const H='),
    lineStarting('const rawLookupCache='),
    lineStarting('const keyMap='),
    ...['key', 'getRaw', 'invalidateRaw', 'value', 'aliasFor', 'deriveRecord', 'bindTable', 'markDirty', 'save', 'writeRecordBatches', 'mergeBuyerEdits'].map(name => lineStarting('function ' + name + '(')),
    between('async function importFile(', 'async function importInvitations('),
    between('async function importTranslations(', 'function download('),
    block('translation-state-v3'), block('translation-integration-v3'),
    between('function shareChineseFieldReady(', 'async function ensureCategoryTranslations('),
    between('async function buildOnlineShareLink(', 'async function copyShareText(')
  ].join('\n');
  const api = vm.runInContext(`(function(){
    let rows=[], visibleRows=[], historyMode=false, dirtyRows=new Set();
    let hasUnsavedChanges=false, saveAllPending=false, saveTimer=null;
    let headers=[], sourceFileName='', groupingEnabled=false, activeHashRun=0;
    let opened=new Set(), selected=new Set(), filters={}, pageIndex=0;
    function canEditWorkspace(){return controls.writable}
    function extractBrand(){return ''} function extractStyle(){return ''} function extractQty(){return ''}
    function idFor(r){return String(getRaw(r,['Model ID'])||r.uid)}
    function normalizeModelId(value){return String(value||'')}
    function updateCalculatedCells(){} function rememberBuyerOption(){}
    async function regroup(){}
    async function ensureCategoryTranslations(){controls.categoryCalls++}
    function productDetail(r){
      const detail={model:'',itemChinese:r.raw[H[10]],modelChinese:r.raw[H[12]],category:'测试类目'};
      controls.shareSnapshots.push(detail);return detail;
    }
    async function compactShareImage(value){return value}
    function base64Url(){return 'fabricated-share-token'}
    function render(){controls.renders++;queueVisibleTranslation()}
    async function flushSave(){
      if(historyMode)return true;
      if(!canEditWorkspace())return false;
      controls.flushes++;controls.persisted=rows.map(r=>({uid:r.uid,raw:{...r.raw}}));
      dirtyRows.clear();saveAllPending=false;hasUnsavedChanges=false;return true;
    }
    async function parseCsv(file){return controls.parse(file)}
    async function parseXlsx(file){return controls.parse(file)}
    function returnToCurrent(){historyMode=false}
    function runDeferredProcessing(){}
    ${extracted}
    if(!${!!options.actualTransport})translationQueue.options.requestBatch=transport;
    return {
      H, queue:translationQueue, cache:translationCache, ready:translationCacheReady,
      deriveRecord, translateVisible, startBackgroundTranslation, queueVisibleTranslation,
      refreshTranslationEditors, updateTranslationStatus, bindTable, importFile, importTranslations,
      ensureProductTranslations, shareChineseFieldReady, rowChineseReady, buildOnlineShareLink,
      retranslateAutomaticChinese, enableChromeTranslation,
      get chromeMode(){return chromeTranslationMode},
      get readyCount(){return translationReadyCount}, get rows(){return rows},
      get dirty(){return dirtyRows},
      setRows(next,{history=false,sync=true,visible=next}={}){
        rows=next;visibleRows=visible;historyMode=history;if(sync)syncTranslationDataset();
      },
      setRaw(r,index,value){r.raw[H[index]]=value;invalidateRaw(r)},
      setPaused(value){translationUserPaused=value;translationQueue.setPaused(value)},
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
test('a main-file buyer-supplied Chinese field without automatic provenance is retained',async()=>{
  const h=harness();await h.api.ready;
  const source='Wireless speaker FICT1900',chinese='买手提供的无线音箱 FICT1900';
  const r=record(h,'provided-chinese',source,chinese);h.api.setRows([r]);
  await h.api.translateVisible([r]);
  assert.equal(r.raw[h.api.H[10]],chinese);assert.equal(r.autoItemChinese,false);
  assert.equal(h.transport.mock.callCount(),0);assert.equal(h.api.readyCount,1);
});

test('embedded engine is identical to the separately tested engine', () => {
  const embedded = documentHtml.match(/<script data-buyer-translation-engine="v[34]">([\s\S]*?)<\/script>/);
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
    idbCache: [{ source, chinese: chineseFor(source), engineVersion: TRANSLATION_VERSION }]
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
  assert.deepEqual(h.controls.cacheDatabases, ['buyer-title-translations-google-v5']);
});

test('provider migration ignores valid-looking baked, local and unversioned database translations', { timeout: 5000 }, async () => {
  const sources = ['Wireless speaker FICT704', 'Wireless speaker FICT705', 'Wireless speaker FICT706', 'Wireless speaker FICT707'];
  const oldChinese = source => chineseFor(source).replace('虚构商品中文译文', '旧服务中文译文');
  const h = harness({
    bakedCache: [[sources[0], oldChinese(sources[0])]],
    localCache: [[sources[1], oldChinese(sources[1])]],
    idbCache: [
      { source: sources[2], chinese: oldChinese(sources[2]) },
      { source: sources[3], chinese: oldChinese(sources[3]), engineVersion: 'tencent-v3' }
    ]
  });
  await h.api.ready;
  for (const source of sources) assert.equal(h.api.cache.has(source), false, source);
  const records = sources.map((source, index) => record(h, 'migration-' + index, source));
  h.api.setRows(records);
  await h.api.translateVisible(records);
  for (const r of records) assert.equal(r.raw[h.api.H[10]], chineseFor(r.raw[h.api.H[9]]));
  assert.equal(h.api.queue.stats.completed, sources.length);
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

test('main-file rows repair unusable foreign text and corrupt markers while retaining supplied mixed Chinese', { timeout: 5000 }, async () => {
  const h = harness();
  const records = [
    record(h, 'old-foreign', 'Wireless speaker FICT1401', 'Wireless speaker, FICT1401'),
    record(h, 'old-fragment', 'Wireless rechargeable portable speaker FICT1402', '中文 Wireless rechargeable portable speaker FICT1402'),
    record(h, 'old-marker', 'Microphone FICT1403', '异常 ZXQ0001QXZ FICT1403')
  ];
  h.api.setRows(records);
  for (const r of [records[0],records[2]]) {
    h.api.deriveRecord(r);
    assert.equal(r.autoItemChinese, true);
    assert.equal(r.raw[h.api.H[10]], '');
  }
  const mixed=records[1].raw[h.api.H[10]];h.api.deriveRecord(records[1]);assert.equal(records[1].autoItemChinese,false);assert.equal(records[1].raw[h.api.H[10]],mixed);
  await h.api.translateVisible(records);
  for (const r of [records[0],records[2]]) assert.equal(r.raw[h.api.H[10]], chineseFor(r.raw[h.api.H[9]]));
  assert.equal(records[1].raw[h.api.H[10]],mixed);
});

test('obsolete automatic item and model translations are not ready and receive the current provider version', { timeout: 5000 }, async () => {
  const h = harness();
  await h.api.ready;
  const source = 'Tai nghe không dây kèm hộp sạc màu đen 16 chiếc';
  const r = record(h, 'obsolete-auto', source, '错误的旧服务中文振动棒，16件');
  r.raw[h.api.H[11]] = 'Wireless calling receiver FICT1601';
  r.raw[h.api.H[12]] = '旧服务接收器 FICT1601';
  Object.assign(r, {
    autoItemChinese: true, localTranslatedItem: true, translationItemSource: source,
    autoModelChinese: true, localTranslatedModel: true, translationModelSource: r.raw[h.api.H[11]],
    translationModelVersion: 'tencent-v3'
  });
  assert.equal(BuyerTranslation.usable(source, r.raw[h.api.H[10]]), true, 'structural validation cannot detect the fabricated semantic error');
  h.api.setRows([r]);
  assert.equal(h.api.readyCount, 0, 'obsolete provider output must not count as ready');
  h.api.deriveRecord(r);
  assert.equal(r.raw[h.api.H[10]],'错误的旧服务中文振动棒，16件','migration keeps the saved display until replacement succeeds');
  assert.equal(r.raw[h.api.H[12]],'旧服务接收器 FICT1601');
  assert.equal(r.localTranslatedItem, false);
  assert.equal(r.localTranslatedModel, false);
  await h.api.translateVisible([r]);
  assert.equal(r.raw[h.api.H[10]], chineseFor(source));
  assert.equal(r.translationItemVersion, TRANSLATION_VERSION);
  assert.equal(r.translationModelVersion, TRANSLATION_VERSION);
  assert.equal(h.api.readyCount, 1);
});

test('current-version automatic fields remain reusable and explicit buyer text survives provider migration', { timeout: 5000 }, async () => {
  const h = harness();
  await h.api.ready;
  const source = 'Wireless speaker FICT1602';
  const current = record(h, 'current-provider', source, chineseFor(source));
  Object.assign(current, { autoItemChinese: true, localTranslatedItem: true, translationItemSource: source, translationItemVersion: TRANSLATION_VERSION });
  const manual = record(h, 'manual-provider', 'FICTBRAND', '买手指定的中文品牌');
  Object.assign(manual, { autoItemChinese: true, localTranslatedItem: true, translationItemVersion: 'tencent-v3', userEditedFields: [h.api.H[10]] });
  h.api.setRows([current, manual]);
  await h.api.translateVisible([current, manual]);
  assert.equal(current.raw[h.api.H[10]], chineseFor(source));
  assert.equal(current.translationItemVersion, TRANSLATION_VERSION);
  assert.equal(manual.raw[h.api.H[10]], '买手指定的中文品牌');
  assert.equal(manual.autoItemChinese, false);
  assert.equal(h.transport.mock.callCount(), 0);
});

test('cached, existing automatic and manual wording reach editors without dictionary rewriting', { timeout: 5000 }, async () => {
  const source = 'Kit Controle Remoto Aurora ZX901 com Fonte 12V e 2 Cabos';
  const oldTerm = 'Aurora ZX901远程控制套件，带12V电源和2根电缆';
  const h = harness({ idbCache: [{ source, chinese: oldTerm, engineVersion: TRANSLATION_VERSION }] });
  const fromCache = record(h, 'cached-term', source);
  const existing = record(h, 'existing-term', source, oldTerm);
  existing.autoItemChinese = true;
  existing.localTranslatedItem = true;
  existing.translationItemSource = source;
  existing.translationItemVersion = TRANSLATION_VERSION;
  const manual = record(h, 'manual-term', source, oldTerm);
  manual.userEditedFields = [h.api.H[10]];
  h.api.setRows([fromCache, existing, manual]);
  const cachedEditor = editor(h, fromCache), existingEditor = editor(h, existing);
  await h.api.translateVisible([fromCache, existing, manual]);
  for (const r of [fromCache, existing]) assert.equal(r.raw[h.api.H[10]],oldTerm);
  assert.equal(cachedEditor.value,oldTerm);
  assert.equal(existingEditor.value,oldTerm);
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
  assert.equal(r.translationItemVersion, TRANSLATION_VERSION);
  assert.equal(h.api.readyCount, 1);
  await waitFor(() => h.controls.flushes > 0, 'automatic save after a translation');
  assert.equal(h.controls.persisted[0].raw[h.api.H[10]], chineseFor(source));
  await waitFor(() => h.controls.cacheWrites.length > 0, 'versioned translation cache persistence');
  assert.equal(h.controls.cacheWrites[0].engineVersion, TRANSLATION_VERSION);
});

test('Google receives each intact title separately and mock semantics reach the product field unchanged', { timeout: 5000 }, async () => {
  // This fixture verifies routing and propagation, not the quality of a live Google response.
  const source = 'Tai nghe không dây kèm hộp sạc màu đen 16 chiếc';
  const second = 'Wireless calling receiver FICT1603';
  const expected = '无线耳机及充电盒，黑色，16件';
  const outputs = new Map([[source, expected], [second, '无线呼叫接收器 FICT1603']]);
  const fetch = mock.fn(async input => {
    const url = new URL(input);
    assert.equal(url.hostname, 'translate.googleapis.com');
    assert.equal(url.searchParams.get('sl'), 'auto');
    assert.equal(url.searchParams.get('tl'), 'zh-CN');
    const text = url.searchParams.get('q');
    assert.ok(outputs.has(text), 'q is one complete source string, without batching markers');
    return { ok: true, json: async () => [[[outputs.get(text)]]] };
  });
  const h = harness({ actualTransport: true, fetch });
  const r = record(h, 'vietnamese-route', source);
  r.raw.grass_region = 'VN';
  const other = record(h, 'separate-title', second);
  h.api.setRows([r, other]);
  await h.api.translateVisible([r, other]);
  assert.equal(r.raw[h.api.H[10]], expected);
  assert.doesNotMatch(r.raw[h.api.H[10]], /振动棒/);
  assert.equal(other.raw[h.api.H[10]], outputs.get(second));
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(r.translationItemVersion, TRANSLATION_VERSION);
});

test('a Google outage leaves translation pending without a silent Tencent fallback', { timeout: 6000 }, async () => {
  const fetch = mock.fn(async input => {
    assert.equal(new URL(input).hostname, 'translate.googleapis.com');
    return { ok: false, status: 503, headers: { get: () => null } };
  });
  const h = harness({ actualTransport: true, fetch });
  const r = record(h, 'google-outage', 'Wireless speaker FICT1604');
  h.api.setRows([r]);
  await h.api.translateVisible([r]);
  assert.equal(r.raw[h.api.H[10]], '');
  assert.equal(r.localTranslatedItem, false);
  assert.equal(h.api.readyCount, 0);
  assert.ok(fetch.mock.callCount() > 0);
  assert.ok(fetch.mock.callCount() <= 6, 'failed service attempts remain bounded');
});

test('main-file merging retains automatic provenance and invalidates an older provider result', { timeout: 5000 }, async () => {
  const h = harness();
  await h.api.ready;
  const old = record(h, 'merge-provider', 'Wireless speaker FICT1605', '旧服务中文音箱 FICT1605');
  Object.assign(old, { autoItemChinese: true, localTranslatedItem: true, translationItemSource: old.raw[h.api.H[9]], translationItemVersion: 'tencent-v3' });
  h.api.setRows([old]);
  const incoming = record(h, 'merge-provider', old.raw[h.api.H[9]]);
  h.controls.parse = async () => ({ headers: Array.from(h.api.H), rows: [incoming] });
  await h.api.importFile({ name: 'current.csv', type: 'text/csv' });
  await h.api.translateVisible([incoming]);
  assert.equal(incoming.raw[h.api.H[10]], chineseFor(old.raw[h.api.H[9]]));
  assert.equal(incoming.translationItemVersion, TRANSLATION_VERSION);
});

test('importing the same nonempty Chinese text marks an automatic field as a buyer override', { timeout: 5000 }, async () => {
  const h = harness();
  await h.api.ready;
  const source = 'Wireless speaker FICT1606';
  const chinese = '买手确认的中文音箱 FICT1606';
  const r = record(h, 'same-chinese-import', source, chinese);
  Object.assign(r, { autoItemChinese: true, localTranslatedItem: true, translationItemSource: source, translationItemVersion: 'tencent-v3' });
  h.api.setRows([r]);
  h.controls.parse = async () => ({ headers: ['Model ID', 'item name 中文'], rows: [{ raw: { 'Model ID': r.uid, 'item name 中文': chinese } }] });
  await h.api.importTranslations({ name: 'confirmed.csv', type: 'text/csv' });
  h.api.deriveRecord(r);
  assert.ok(r.userEditedFields.includes(h.api.H[10]));
  assert.equal(r.autoItemChinese, false);
  assert.equal(r.raw[h.api.H[10]], chinese);
  await h.api.translateVisible([r]);
  assert.equal(h.transport.mock.callCount(), 0);
});

test('sharing waits for the selected titles before reading categories and freezing the share payload', { timeout: 5000 }, async () => {
  const gate = deferred();
  const transport = mock.fn(async texts => { await gate.promise; return texts.map(chineseFor); });
  const h = harness({ transport });
  const selected = record(h, 'share-selected', 'Wireless speaker FICT1610');
  selected.raw[h.api.H[11]]='Black FICT1613';
  const unselected = record(h, 'share-unselected', 'Microphone FICT1611');
  h.api.setRows([selected, unselected]);
  const pending = h.api.buildOnlineShareLink([selected]);
  await waitFor(() => transport.mock.callCount() > 0, 'selected title translation before sharing');
  assert.equal(h.controls.categoryCalls, 0);
  assert.equal(h.controls.shareSnapshots.length, 0);
  gate.resolve();
  const url = await pending;
  assert.equal(new URL(url).pathname, '/share.html');
  assert.equal(h.controls.categoryCalls, 1);
  assert.equal(h.controls.shareSnapshots.length, 1);
  assert.equal(h.controls.shareSnapshots[0].itemChinese, chineseFor(selected.raw[h.api.H[9]]));
  assert.equal(h.controls.shareSnapshots[0].modelChinese,chineseFor(selected.raw[h.api.H[11]]));
  const expectedSources=new Set([selected.raw[h.api.H[9]],selected.raw[h.api.H[11]]]);
  assert.ok(transport.mock.calls.every(call => call.arguments[0].every(text => expectedSources.has(text))), 'unselected records do not delay sharing');
});

test('sharing rejects unresolved titles and paused translation without freezing incomplete product data', { timeout: 5000 }, async () => {
  const transport = mock.fn(async texts => texts.map(() => ''));
  const h = harness({ transport });
  const r = record(h, 'share-missing', 'Wireless speaker FICT1612');
  h.api.setRows([r]);
  h.api.setPaused(true);
  await assert.rejects(h.api.buildOnlineShareLink([r]), /暂停/);
  assert.equal(transport.mock.callCount(), 0);
  h.api.setPaused(false);
  await assert.rejects(h.api.buildOnlineShareLink([r]), /中文未完成|译文|中文/);
  assert.equal(h.controls.categoryCalls, 0);
  assert.equal(h.controls.shareSnapshots.length, 0);
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
  Object.assign(r, { autoItemChinese: true, localTranslatedItem: true, translationItemSource: source, translationItemVersion: TRANSLATION_VERSION });
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

test('a yielding readiness scan counts edits before and after their scan position exactly once',async()=>{
  const h=harness();await h.api.ready;
  const records=Array.from({length:1000},(_,i)=>{
    const source='Wireless speaker FICT'+(2000+i),r=record(h,'readiness-'+i,source,chineseFor(source));
    Object.assign(r,{autoItemChinese:true,localTranslatedItem:true,translationItemSource:source,translationItemVersion:TRANSLATION_VERSION});return r;
  });
  h.api.setRows(records);assert.ok(h.api.readyCount<1000,'initial scan must yield');
  const early=editor(h,records[0]),late=editor(h,records[750]);h.api.bindTable();
  early.value='';early.oninput();late.value='';late.oninput();
  await waitFor(()=>h.api.readyCount===998,'readiness scan after two manual blanks');
  early.value=chineseFor(records[0].raw[h.api.H[9]]);early.oninput();late.value=chineseFor(records[750].raw[h.api.H[9]]);late.oninput();
  assert.equal(h.api.readyCount,1000);h.api.updateTranslationStatus();assert.doesNotMatch(h.document.getElementById('translationState').textContent,/后台统计中/);
});

test('replacing a dataset cancels its old readiness scan without leaking counts into the new dataset',async()=>{
  const h=harness();await h.api.ready;
  h.api.setRows(Array.from({length:1000},(_,i)=>record(h,'old-readiness-'+i,'')));
  h.api.setRows(Array.from({length:600},(_,i)=>record(h,'new-readiness-'+i,'')));
  await waitFor(()=>h.api.readyCount===600,'new dataset readiness');await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(h.api.readyCount,600);assert.equal(h.api.rows.length,600);
});

test('intact item and model queries preserve provider wording while model differences become review warnings',async()=>{
  const item='FICTBRAND Kit Controle Remoto FICT1701 com 16 Cabos',model='FICTBRAND Black FICT1702 16pcs';
  const outputs=new Map([[item,'远程控制套件，附十六根电缆'],[model,'黑色款，Google 整句返回']]);
  const fetch=mock.fn(async input=>{const url=new URL(input);assert.equal(url.hostname,'translate.googleapis.com');assert.equal(url.searchParams.get('sl'),'auto');const source=url.searchParams.get('q');assert.ok(outputs.has(source),'the query remains one complete item or model sentence');return {status:200,json:async()=>[[[outputs.get(source)]]]}});
  const h=harness({actualTransport:true,fetch}),r=record(h,'full-sentence-both',item);r.raw[h.api.H[11]]=model;r.raw.mall_brand_name='FICTBRAND';h.api.setRows([r]);
  await h.api.translateVisible([r]);
  assert.equal(r.raw[h.api.H[10]],outputs.get(item));assert.equal(r.raw[h.api.H[12]],outputs.get(model));assert.equal(fetch.mock.callCount(),2);
  assert.match(r.translationItemWarning,/型号/);assert.match(r.translationModelWarning,/型号/);assert.match(r.translationModelWarning,/数字/);assert.equal(h.api.readyCount,1);
});

test('a failed refresh preserves an obsolete automatic translation and its editor',async()=>{
  const transport=mock.fn(async()=>{throw Object.assign(new Error('Fabricated provider unavailable'),{permanent:true})});
  const h=harness({transport}),source='Wireless speaker FICT1710',oldChinese='已保存的旧版无线音箱 FICT1710',r=record(h,'retain-on-failure',source,oldChinese);
  Object.assign(r,{autoItemChinese:true,localTranslatedItem:true,translationItemSource:source,translationItemVersion:'google-v4-20261116'});h.api.setRows([r]);const input=editor(h,r);
  await h.api.translateVisible([r]);
  assert.equal(r.raw[h.api.H[10]],oldChinese);assert.equal(input.value,oldChinese);assert.equal(r.raw[h.api.H[9]],source);
  assert.equal(r.localTranslatedItem,false);assert.equal(r.translationItemVersion,'google-v4-20261116');assert.equal(h.api.readyCount,0);assert.equal(transport.mock.callCount(),1);
});

test('retranslating all automatic fields invalidates their caches without clearing displays or changing buyer fields',async()=>{
  const gate=deferred(),transport=mock.fn(async texts=>{await gate.promise;return texts.map(text=>'整句重译结果 '+text.match(/FICT\d+/)[0])}),h=harness({transport});await h.api.ready;
  const auto=[1720,1721].map(n=>{const source='Wireless speaker FICT'+n,r=record(h,'force-'+n,source,'旧自动译文 FICT'+n);Object.assign(r,{autoItemChinese:true,localTranslatedItem:true,translationItemSource:source,translationItemVersion:TRANSLATION_VERSION});h.api.cache.set(source,r.raw[h.api.H[10]]);return r});
  const manual=record(h,'force-manual','Wireless speaker FICT1722','买手指定的中文 FICT1722');Object.assign(manual,{autoItemChinese:true,userEditedFields:[h.api.H[10]],translationItemVersion:'google-v4-20261116'});
  const provided=record(h,'force-provided','Wireless speaker FICT1723','导入保留的中文 FICT1723');provided.autoItemChinese=false;
  h.api.setRows([...auto,manual,provided]);await h.api.retranslateAutomaticChinese();await waitFor(()=>transport.mock.callCount()===2,'automatic retranslation dispatch');
  for(const [i,r]of auto.entries())assert.equal(r.raw[h.api.H[10]],'旧自动译文 FICT'+(1720+i));
  gate.resolve();await waitFor(()=>auto.every(r=>r.raw[h.api.H[10]].startsWith('整句重译结果')),'all automatic replacements');
  assert.equal(manual.raw[h.api.H[10]],'买手指定的中文 FICT1722');assert.equal(provided.raw[h.api.H[10]],'导入保留的中文 FICT1723');
  const requested=transport.mock.calls.flatMap(call=>call.arguments[0]);assert.deepEqual(new Set(requested),new Set(auto.map(r=>r.raw[h.api.H[9]])));
  assert.ok(auto.every(r=>r.translationItemVersion===TRANSLATION_VERSION));
});

for(const missing of [10,12])test('sharing requires field '+missing+' even when both its source and Chinese are blank',async()=>{
  const h=harness(),r=record(h,'required-'+missing,'');const supplied=missing===10?12:10;r.raw[h.api.H[supplied]]=supplied===10?'人工中文标题':'人工中文型号';r.userEditedFields=[h.api.H[supplied]];h.api.setRows([r]);
  assert.equal(h.api.rowChineseReady(r),true,'general workbench readiness does not replace the stricter share preflight');
  assert.equal(h.api.shareChineseFieldReady(r,missing===10?9:11,missing),false);
  await assert.rejects(h.api.buildOnlineShareLink([r]),/缺少完整中文标题或型号/);
  assert.equal(h.transport.mock.callCount(),0);assert.equal(h.controls.categoryCalls,0);assert.equal(h.controls.shareSnapshots.length,0);
});

test('buyer-completed Chinese title and model can be shared when original fields are absent',async()=>{
  const h=harness(),r=record(h,'completed-without-source','');r.raw[h.api.H[10]]='人工补全中文标题';r.raw[h.api.H[12]]='人工补全中文型号';r.userEditedFields=[h.api.H[10],h.api.H[12]];h.api.setRows([r]);
  const url=await h.api.buildOnlineShareLink([r]);assert.equal(new URL(url).pathname,'/share.html');assert.equal(h.transport.mock.callCount(),0);assert.equal(h.controls.shareSnapshots[0].modelChinese,'人工补全中文型号');
});

test('Chrome mode routes only prepared languages locally and keeps other full sentences on Google',async()=>{
  const english='Wireless speaker FICT1730',portuguese='Controle Remoto FICT1731 com Fonte',chrome={
    prepareLanguages:mock.fn(async languages=>Array.from(languages,sourceLanguage=>({sourceLanguage,status:sourceLanguage==='en'?'available':'unavailable'}))),
    translate:mock.fn(async(text,language)=>{assert.equal(text,english);assert.equal(language,'en');return 'Chrome 虚构整句音箱译文'}),destroy(){}
  };
  const fetch=mock.fn(async input=>{const url=new URL(input);assert.equal(url.hostname,'translate.googleapis.com');assert.equal(url.searchParams.get('q'),portuguese);return {status:200,json:async()=>[[['Google 虚构整句遥控套件译文']]]}});
  const h=harness({actualTransport:true,fetch,chromeProvider:chrome}),local=record(h,'chrome-en',english),online=record(h,'google-pt',portuguese);h.api.setRows([local,online],{visible:[]});
  await h.api.enableChromeTranslation();await waitFor(()=>local.localTranslatedItem&&online.localTranslatedItem,'mixed provider completion');
  assert.equal(h.api.chromeMode,true);assert.equal(local.translationItemProvider,'chrome-local');assert.equal(online.translationItemProvider,'google-online');
  assert.equal(local.raw[h.api.H[10]],'Chrome 虚构整句音箱译文');assert.equal(online.raw[h.api.H[10]],'Google 虚构整句遥控套件译文');assert.equal(chrome.translate.mock.callCount(),1);assert.equal(fetch.mock.callCount(),1);
  assert.deepEqual(new Set(chrome.prepareLanguages.mock.calls[0].arguments[0]),new Set(['en','pt']));
});

test('unavailable Chrome models do not enable local mode or pretend to translate',async()=>{
  const chrome={prepareLanguages:mock.fn(async languages=>Array.from(languages,sourceLanguage=>({sourceLanguage,status:'unavailable'}))),translate:mock.fn(),destroy(){}};
  const fetch=mock.fn(async()=>{assert.fail('an unsuccessful local-model activation must not launch translation')});
  const h=harness({actualTransport:true,fetch,chromeProvider:chrome});h.api.setRows([record(h,'unsupported-chrome','Wireless speaker FICT1732')],{visible:[]});
  await h.api.enableChromeTranslation();assert.equal(h.api.chromeMode,false);assert.equal(chrome.translate.mock.callCount(),0);assert.equal(fetch.mock.callCount(),0);
  assert.equal(h.document.getElementById('enableChromeTranslation').disabled,false);assert.match(h.document.getElementById('chromeTranslationState').textContent,/未能准备/);
});

test('Chrome bridges complete Vietnamese and Portuguese sentences through prepared English models',async()=>{
  const vietnamese='Tai nghe không dây FICT1740',portuguese='Controle Remoto FICT1741 com Fonte';
  const pivot=new Map([[vietnamese,'Fictional wireless earphones FICT1740'],[portuguese,'Fictional remote control with power supply FICT1741']]);
  const chinese=new Map([[pivot.get(vietnamese),'经英语转换的虚构无线耳机'],[pivot.get(portuguese),'经英语转换的虚构遥控器和电源']]);
  const chrome={
    prepareLanguages:mock.fn(async(languages,settings={})=>Array.from(languages,sourceLanguage=>({sourceLanguage,targetLanguage:settings.targetLanguage||'zh',status:settings.targetLanguage==='en'||sourceLanguage==='en'?'available':'unavailable'}))),
    translate:mock.fn(async(text,sourceLanguage,settings={})=>{
      if(settings.targetLanguage==='en'){assert.ok(['vi','pt'].includes(sourceLanguage));assert.ok(pivot.has(text),'the pivot receives the complete original sentence');return pivot.get(text)}
      assert.equal(sourceLanguage,'en');assert.ok(chinese.has(text),'the Chinese model receives the complete pivot result');return chinese.get(text);
    }),destroy(){}
  };
  const fetch=mock.fn(async()=>{assert.fail('prepared Chrome bridges must not call the online provider')});
  const h=harness({actualTransport:true,fetch,chromeProvider:chrome}),vn=record(h,'bridge-vi',vietnamese),pt=record(h,'bridge-pt',portuguese);h.api.setRows([vn,pt],{visible:[]});
  const activation=h.api.enableChromeTranslation();assert.equal(chrome.prepareLanguages.mock.callCount(),3,'direct, pivot and English model preparation starts in one click stack');await activation;
  await waitFor(()=>vn.localTranslatedItem&&pt.localTranslatedItem,'Chrome pivot translations');
  assert.equal(vn.raw[h.api.H[10]],chinese.get(pivot.get(vietnamese)));assert.equal(pt.raw[h.api.H[10]],chinese.get(pivot.get(portuguese)));
  assert.equal(vn.translationItemProvider,'chrome-local-via-en');assert.equal(pt.translationItemProvider,'chrome-local-via-en');assert.equal(chrome.translate.mock.callCount(),4);assert.equal(fetch.mock.callCount(),0);
  assert.match(h.document.getElementById('chromeTranslationState').textContent,/经英语转换/);
});
