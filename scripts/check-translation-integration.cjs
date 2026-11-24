'use strict';

// Exercises the actual marked workbench functions with a fake DOM and IndexedDB.
// Browser startup dependencies and network are simulated. The actual start()
// also runs against fabricated saved state. Provider fixtures validate routing
// and exact propagation; they do not prove live translation-service quality.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, afterEach, mock } = require('node:test');
const BuyerTranslation = require('../translation-engine.js');
const BuyerGoogleTranslation = require('../translation-google-provider.js');
const BuyerReferenceTranslation = require('../translation-reference-provider.js');
const BuyerCategoryTranslations = require('../category-translations.js');
const BuyerShareCodec = require('../product-share-codec.js');
const BuyerShareTransport = require('../product-share-transport.js');
const WorkbenchImport = require('../workbench-import.js');
const root = path.join(__dirname, '..');
const documentHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const html = Array.from(documentHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)).at(-1)[1];
const lines = html.split(/\r?\n/);
const instances = new Set();
const TRANSLATION_VERSION = 'reference-v7-20261117';

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
  const controls = { writable: true, editors: [], flushes: 0, persisted: [], renders: 0, cacheWrites: [], cacheDatabases: [], categoryCalls: 0, categoryGate: null, shareImageGate: null, shareSnapshots: [], shortenerCalls: [], parse: null, savedState: {rows:[],meta:null}, loadGate: null };
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
      if (!elements.has(id)) elements.set(id, { textContent: '', value: '', disabled: false, isConnected: true, title: '' });
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
    BuyerTranslation, BuyerGoogleTranslation, BuyerCategoryTranslations, BuyerShareCodec, BuyerShareTransport, WorkbenchImport, controls, document, console,
    // Legacy Google/Chrome fixtures deliberately request the internal fallback;
    // primaryReference fixtures below exercise the actual reference transport.
    BuyerReferenceTranslation: options.referenceProvider || (options.primaryReference ? BuyerReferenceTranslation : {create:()=>({async translateBatch(){throw Object.assign(new Error('Fabricated primary fallback'),{fallback:true})}})}),
    BuyerWorkspace: { async acquireWriter(){return {owner:true,status:'owner'}} },
    BuyerChromeTranslation: options.chromeProvider ? { create:()=>options.chromeProvider } : undefined,
    BuyerShareShortener: { create(){controls.shortenerCalls.push('create');throw new Error('The share builder must never use a third-party shortener');} },
    BuyerGithubShare: { begin(){controls.shortenerCalls.push('local publisher');throw new Error('The share builder must work independently of the local publisher');} },
    Translator: options.chromeProvider ? {} : undefined,
    workspace: { isDefault:true, created:false, dbName:base=>base||'buyer-pool-workbench', storageKey:base=>base, workspaceLabel:()=> '虚构工作区',blankShareUrl:()=> 'https://buyer.example.test/?new=1' },
    referenceTranslationCache: new Map(options.bakedCache || []),
    setTimeout: setTimer, clearTimeout: clearTimer, queueMicrotask,
    localStorage: { getItem: key => key === 'sourcing-cn-cache-v2' && options.localCache ? JSON.stringify(options.localCache) : null },
    indexedDB: { open(name) { controls.cacheDatabases.push(name); const request = {}; queueMicrotask(() => { request.result = db; request.onsuccess?.(); }); return request; } },
    window: { addEventListener() {} },
    fetch: options.fetch || (() => { throw new Error('Network access is forbidden in translation-integration checks'); }),
    AbortController, URL, TextEncoder,TextDecoder,Blob,btoa:text=>Buffer.from(text,'binary').toString('base64'),
    location: options.location || { hostname: 'buyer.example.test', protocol: 'https:', href: 'https://buyer.example.test/index.html' },
    crypto: { randomUUID: () => 'fabricated-test-id' },
    transport
  });
  if (options.storageGetter) Object.defineProperty(context, 'localStorage', { configurable: true, get: options.storageGetter });
  const extracted = [
    between('// product-group-names:start','// product-group-names:end'),
    lineStarting('const H='),
    lineStarting('const S='),lineStarting('const FIELD='),html.match(/const statusFilterKeys=\[[^\]]*\];/)[0],
    lineStarting('const rawLookupCache='),
    lineStarting('const keyMap='),
    ...['key', 'getRaw', 'invalidateRaw', 'value', 'aliasFor', 'deriveRecord', 'bindTable', 'markDirty', 'save', 'writeRecordBatches','headerScore','isMetaRow'].map(name => lineStarting('function ' + name + '(')),
    between('function mergeBuyerEdits(', 'async function runDeferredProcessing('),
    ...(options.realCsv?[between('function selectImportHeader(', 'async function workbookHasEmbeddedImages(')]:[]),
    between('async function importFile(', 'async function importInvitations('),
    between('async function importTranslations(', 'function download('),
    between('function categoryKey(', 'function deriveRecord('),
    block('translation-state-v3'), block('translation-integration-v3'),
    between('function shareChineseFieldReady(', 'async function ensureCategoryTranslations('),
    between('async function start(){','start().catch('),
    between('async function buildOnlineShareLink(', 'async function copyShareText(')
  ].join('\n');
  const api = vm.runInContext(`(function(){
    let rows=[], visibleRows=[], historyMode=false, dirtyRows=new Set();
    let hasUnsavedChanges=false, saveAllPending=false, saveTimer=null;
    let headers=[], sourceFileName='', groupingEnabled=false, activeHashRun=0,threshold=90,workspaceWriter=null,workspaceWritable=false;
    let opened=new Set(), selected=new Set(), filters={}, pageIndex=0;
    function canEditWorkspace(){return controls.writable}
    function extractBrand(){return ''} function extractStyle(){return ''} function extractQty(){return ''}
    function idFor(r){return String(getRaw(r,['Model ID'])||r.uid)}
    function normalizeModelId(value){return String(value||'')}
    function updateCalculatedCells(){} function rememberBuyerOption(){} function bindBuyerChoices(){}
    function refreshBuyerDatalists(){}async function refreshVersions(){}
    function filtered(){}filtered.searchText=()=>'';
    async function loadWorkbenchState(){if(controls.loadGate)await controls.loadGate;return controls.savedState}
    async function regroup(){}
    async function ensureCategoryTranslations(){controls.categoryCalls++;if(controls.categoryGate)await controls.categoryGate}
    function productDetail(r){
      const detail={id:r.uid,model:'',itemChinese:String(value(r,H[10])??''),modelChinese:String(value(r,H[12])??''),category:'测试类目'};
      controls.shareSnapshots.push(detail);return detail;
    }
    async function compactShareImage(value){if(controls.shareImageGate)await controls.shareImageGate;return value}
    function render(){controls.renders++;queueVisibleTranslation()}
    async function flushSave(){
      if(historyMode)return true;
      if(!canEditWorkspace())return false;
      controls.flushes++;controls.persisted=rows.map(r=>({uid:r.uid,raw:{...r.raw}}));
      dirtyRows.clear();saveAllPending=false;hasUnsavedChanges=false;return true;
    }
    ${options.realCsv?'':'async function parseCsv(file){return controls.parse(file)}'}
    async function parseXlsx(file){return controls.parse(file)}
    function returnToCurrent(){historyMode=false}
    function runDeferredProcessing(){}
    ${extracted}
    if(!${!!options.actualTransport})translationQueue.options.requestBatch=transport;
    return {
      H,value,key,mergeBuyerEdits, queue:translationQueue, cache:translationCache, ready:translationCacheReady,
      deriveRecord, translateVisible, startBackgroundTranslation, queueVisibleTranslation,
      refreshTranslationEditors, updateTranslationStatus, bindTable, importFile, importTranslations,
      ensureProductTranslations, shareChineseFieldReady, rowChineseReady, buildOnlineShareLink,shareLinkMessage,
      retranslateAutomaticChinese, enableChromeTranslation,
      start,launchAutomaticChinese,oneClickChinese,toggleTranslationPause,categoryLabel,categoryPath,categoryTranslationCache,
      get scoped(){return translationScopeDataset===rows&&translationScopeRecords!==null},
      get scopedRecords(){return Array.from(automaticTranslationRecords(rows))},
      get userPaused(){return translationUserPaused},
      setAutomaticEnabled(value){automaticChineseEnabled=value},
      get chromeMode(){return chromeTranslationMode},
      get chromeLanguages(){return Array.from(chromeTranslationLanguages)},
      get chromePending(){return Array.from(chromeTranslationPending)},
      get readyCount(){return translationReadyCount}, get rows(){return rows},
      get dirty(){return dirtyRows},
      setRows(next,{history=false,sync=true,visible=next}={}){
        rows=next;visibleRows=visible;historyMode=history;if(sync)syncTranslationDataset();
      },
      setRaw(r,index,value){r.raw[H[index]]=value;invalidateRaw(r)},
      setPaused(value){translationUserPaused=value;translationQueue.setPaused(value)},
      stop(){automaticChineseEnabled=false;automaticChineseRun++;translationUserPaused=true;translationBackgroundRun++;translationQueue.setPaused(true);translationQueue.cancelQueued()}
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

function csvFile(text,name='fabricated-standard-chinese.csv'){
  const file=new Blob([text],{type:'text/csv'});file.name=name;return file;
}

function completedShareRecord(h,id){
  const row=record(h,id,'');row.raw[h.api.H[10]]='买手人工商品中文';row.raw[h.api.H[12]]='买手人工型号中文';
  row.userEditedFields=[h.api.H[10],h.api.H[12]];return row;
}
function decodeFabricatedShareUrl(url){
  assert.doesNotMatch(url,/[\r\n]/);
  const query=new URL(url).searchParams.get('d');
  assert.match(query,/^c[A-Za-z0-9_-]+$/);
  return BuyerShareCodec.decode(query);
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
  assert.deepEqual(h.controls.cacheDatabases, ['buyer-title-translations-reference-v7']);
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

test('unprovenanced filled fields remain buyer text regardless of language or marker-like characters', { timeout: 5000 }, async () => {
  const h = harness();
  const records = [
    record(h, 'old-foreign', 'Wireless speaker FICT1401', 'Wireless speaker, FICT1401'),
    record(h, 'old-fragment', 'Wireless rechargeable portable speaker FICT1402', '中文 Wireless rechargeable portable speaker FICT1402'),
    record(h, 'old-marker', 'Microphone FICT1403', '异常 ZXQ0001QXZ FICT1403')
  ];
  h.api.setRows(records);
  const expected=records.map(r=>r.raw[h.api.H[10]]);
  for (const r of records) {h.api.deriveRecord(r);assert.equal(r.autoItemChinese,false);assert.ok(r.userEditedFields.includes(h.api.H[10]));}
  await h.api.translateVisible(records);
  await h.api.oneClickChinese();await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(records.map(r=>r.raw[h.api.H[10]]),expected);assert.equal(h.transport.mock.callCount(),0);
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

test('a Google fallback outage leaves translation pending without fabricating Chinese', { timeout: 6000 }, async () => {
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

test('sharing freezes only selected current fields without requesting or waiting for translation', { timeout: 5000 }, async () => {
  const h = harness();
  const selected = record(h, 'share-selected', 'Wireless speaker FICT1610');
  selected.raw[h.api.H[11]]='Black FICT1613';
  const unselected = record(h, 'share-unselected', 'Microphone FICT1611');
  h.api.setRows([selected, unselected]);
  const before=JSON.parse(JSON.stringify(selected.raw)),url=await h.api.buildOnlineShareLink([selected]);
  assert.equal(new URL(url).pathname, '/s.html');
  assert.equal(h.controls.categoryCalls, 0);
  assert.ok(h.controls.shareSnapshots.length>0);
  const shared=decodeFabricatedShareUrl(url).products;assert.equal(shared.length,1);
  assert.equal(shared[0].id,selected.uid);assert.equal(shared[0].itemChinese,'');assert.equal(shared[0].modelChinese,'');
  assert.deepEqual(selected.raw,before);assert.equal(h.transport.mock.callCount(),0);
});

test('the actual builder preserves all 11 selected short records in one direct link',async()=>{
  const h=harness(),selected=Array.from({length:11},(_,i)=>completedShareRecord(h,'LIMIT-'+i));
  h.api.setRows([...selected,completedShareRecord(h,'UNSELECTED-PRIVATE')]);
  const url=await h.api.buildOnlineShareLink(selected);
  assert.ok(url.length<=1800);
  assert.doesNotMatch(url,/[\r\n]/);
  assert.deepEqual(decodeFabricatedShareUrl(url).products.map(product=>product.id),selected.map(row=>row.uid));
  assert.equal(h.transport.mock.callCount(),0);
});

test('the actual builder rejects 12 models before preparing images or accessing a service',async()=>{
  const h=harness(),selected=Array.from({length:12},(_,i)=>completedShareRecord(h,'OVER-LIMIT-'+i));
  h.api.setRows(selected);
  await assert.rejects(h.api.buildOnlineShareLink(selected),/每次最多.*11.*Model/);
  assert.equal(h.controls.shareSnapshots.length,0);
  assert.equal(h.controls.shortenerCalls.length,0);
  assert.equal(h.transport.mock.callCount(),0);
});

test('a long single record is rejected without offering a file fallback',async()=>{
  const h=harness(),chosen=completedShareRecord(h,'LONG-ONE');
  chosen.raw[h.api.H[10]]=Array.from({length:500},(_,i)=>i.toString(36)+'-'+Math.imul(i+123,2654435761).toString(36)).join(' ');
  h.api.setRows([chosen]);
  await assert.rejects(h.api.buildOnlineShareLink([chosen]),error=>{
    assert.match(error.message,/内容较长.*减少/);
    assert.equal(error.shareProducts,undefined);
    return true;
  });
  assert.equal(h.controls.shortenerCalls.length,0);
  assert.equal(h.transport.mock.callCount(),0);
});

function shareLimitSelectionHarness(){
  const records=Array.from({length:50},(_,i)=>({uid:'SELECTION-'+i}));
  const selected=new Set(),nodes=new Map(),controls={writable:true,opens:0,restoredFocus:0,generations:[],toasts:[]};
  for(const id of ['selectVisible','bulk','selText','merge','shareSelected'])nodes.set(id,{});
  const classes=new Set();
  nodes.set('shareLimitHint',{textContent:'',classList:{toggle(name,on){on?classes.add(name):classes.delete(name)}}});
  const previous={isConnected:true,focus(){controls.restoredFocus++;document.activeElement=previous}};
  const document={activeElement:previous,querySelectorAll:()=>[]};
  const dialog={hidden:true,parts:new Map(),querySelector(selector){return this.parts.get(selector)||null},
    set innerHTML(value){
      this.markup=value;controls.opens++;
      const button={focus(){document.activeElement=button}},message={textContent:''},section={};
      this.parts=new Map([['[data-close-share-limit]',button],['[data-share-limit-message]',message],['section',section]]);
    }
  };
  nodes.set('shareLinkDialog',dialog);
  const context=vm.createContext({
    selected,rows:records,visibleRows:records,historyMode:false,document,
    sorted:list=>list,showShareLinkDialog:list=>controls.generations.push(list),toast:message=>controls.toasts.push(message),
    canEditWorkspace:()=>controls.writable,$:id=>nodes.get(id),
    refreshGroupSelectionCounts:()=>({counts:new Map(),members:new Map()}),groupSelectionIndex:()=>({})
  });
  vm.runInContext(block('share-limit-notice')+'\n'+between('function updateSelectionUI(){','function filtered(){'),context);
  const update=count=>{if(count!==undefined){selected.clear();for(const record of records.slice(0,count))selected.add(record.uid)}context.updateSelectionUI()};
  return {context,selected,nodes,controls,classes,dialog,document,previous,update};
}

test('the selection toolbar explains the 11-model limit without preventing a click for guidance',()=>{
  assert.match(documentHtml,/id="shareLimitHint"[^>]*>单次最多分享 11 个 Model/);
  const h=shareLimitSelectionHarness();h.update(12);
  assert.equal(h.nodes.get('shareSelected').disabled,false);
  assert.match(h.nodes.get('shareSelected').title,/每次最多.*11.*Model/);
  assert.match(h.nodes.get('shareLimitHint').textContent,/已选 12 个，请减少 1 个/);
  assert.ok(h.classes.has('is-over-limit'));
  h.update(11);
  assert.equal(h.nodes.get('shareSelected').disabled,false);
  assert.equal(h.nodes.get('shareLimitHint').textContent,'单次最多分享 11 个 Model');
  assert.equal(h.classes.has('is-over-limit'),false);
  assert.equal(h.dialog.hidden,true);
});

test('selection changes and rerenders never open a share-limit dialog',()=>{
  const h=shareLimitSelectionHarness();h.update(11);assert.equal(h.controls.opens,0);
  h.update(12);h.update();h.update(50);h.update(15);h.update(13);h.update(11);h.update(12);
  assert.equal(h.controls.opens,0);assert.equal(h.dialog.hidden,true);
  assert.equal(h.controls.generations.length,0);
});

test('clicking share with 50 models explains the 39-model excess without generating or changing the selection',()=>{
  const h=shareLimitSelectionHarness();h.update(50);
  assert.match(h.nodes.get('shareLimitHint').textContent,/已选 50 个，请减少 39 个/);
  assert.equal(h.controls.opens,0);
  h.context.shareSelectedProducts();
  assert.equal(h.controls.opens,1);assert.equal(h.dialog.hidden,false);
  assert.match(h.dialog.markup,/role="alertdialog"/);
  assert.equal(h.dialog.querySelector('[data-share-limit-message]').textContent,'当前已选 50 个，请至少取消 39 个后再生成分享链接。');
  assert.equal(h.selected.size,50);
  assert.equal(h.controls.generations.length,0);
  h.dialog.querySelector('[data-close-share-limit]').onclick();
  h.update();assert.equal(h.controls.opens,1);assert.equal(h.dialog.hidden,true);
  h.context.shareSelectedProducts();assert.equal(h.controls.opens,2);assert.equal(h.dialog.hidden,false);
  h.update(49);
  assert.equal(h.controls.opens,2);
  assert.match(h.dialog.querySelector('[data-share-limit-message]').textContent,/当前已选 49 个，请至少取消 38 个/);
  assert.equal(h.selected.size,49);
});

test('clicking share with 11 models generates the complete selected list once',()=>{
  assert.match(documentHtml,/\$\("shareSelected"\)\.onclick=shareSelectedProducts/);
  const h=shareLimitSelectionHarness();h.update(11);
  h.context.shareSelectedProducts();
  assert.equal(h.controls.opens,0);assert.equal(h.controls.generations.length,1);
  assert.deepEqual(Array.from(h.controls.generations[0],record=>record.uid),Array.from(h.selected));
  assert.equal(h.selected.size,11);
});

test('historical or read-only selections do not open a share-limit dialog and close one already open',()=>{
  for(const mode of ['history','readonly']){
    const h=shareLimitSelectionHarness();
    if(mode==='history')h.context.historyMode=true;else h.controls.writable=false;
    h.update(50);h.context.shareSelectedProducts();
    assert.equal(h.controls.opens,0,mode);assert.equal(h.dialog.hidden,true,mode);
    assert.equal(h.controls.generations.length,0,mode);assert.equal(h.nodes.get('shareSelected').disabled,true,mode);
    if(mode==='history')h.context.historyMode=false;else h.controls.writable=true;
    h.update(12);h.context.shareSelectedProducts();assert.equal(h.dialog.hidden,false,mode);
    if(mode==='history')h.context.historyMode=true;else h.controls.writable=false;
    h.update();assert.equal(h.dialog.hidden,true,mode);
  }
});

test('the share-limit dialog traps Tab and restores the prior focus when Escape closes it',()=>{
  const h=shareLimitSelectionHarness();h.update(12);h.context.shareSelectedProducts();
  const button=h.dialog.querySelector('[data-close-share-limit]'),section=h.dialog.querySelector('section');
  assert.equal(h.document.activeElement,button);
  let prevented=0,stopped=0;
  section.onkeydown({key:'Tab',preventDefault(){prevented++}});
  assert.equal(h.document.activeElement,button);assert.equal(prevented,1);
  section.onkeydown({key:'Escape',preventDefault(){prevented++},stopPropagation(){stopped++}});
  assert.equal(h.dialog.hidden,true);assert.equal(h.document.activeElement,h.previous);
  assert.equal(h.controls.restoredFocus,1);assert.equal(prevented,2);assert.equal(stopped,1);
  assert.equal(h.selected.size,12);
});

test('multi-card sharing accepts empty, foreign, mixed and obsolete automatic values while translation is paused',async()=>{
  const h=harness(),values=[['',''],['Buyer English title','5pcs'],['混合 English 标题','Blue 蓝色 / 5pcs'],['旧自动中文标题','  5pcs  ']];
  const selected=values.map(([title,model],index)=>{const r=record(h,'SHARE-CURRENT-'+index,'Source title FICT2140',title);r.raw[h.api.H[11]]='Source model FICT2141';r.raw[h.api.H[12]]=model;if(index===3)Object.assign(r,{autoItemChinese:true,autoModelChinese:true,translationItemSource:r.raw[h.api.H[9]],translationModelSource:r.raw[h.api.H[11]],translationItemVersion:'old-provider',translationModelVersion:'old-provider'});return r});
  h.api.setRows([...selected,completedShareRecord(h,'UNSELECTED-PRIVATE')]);h.api.setPaused(true);const before=selected.map(r=>({...r.raw})),url=await h.api.buildOnlineShareLink(selected),products=decodeFabricatedShareUrl(url).products;
  assert.deepEqual(products.map(product=>[product.itemChinese,product.modelChinese]),values);assert.deepEqual(products.map(product=>product.id),selected.map(r=>r.uid));
  assert.deepEqual(selected.map(r=>r.raw),before);assert.equal(h.transport.mock.callCount(),0);assert.equal(h.controls.categoryCalls,0);
});

test('every new share URL is a compact same-origin snapshot without consulting a shortener or publisher',async()=>{
  const network=mock.fn(()=>{throw new Error('Share generation must not contact the network')});
  const h=harness({fetch:network});
  const chosen=completedShareRecord(h,'selected-card'),other=completedShareRecord(h,'unselected-card');h.api.setRows([chosen,other]);
  let previous='';
  for(const text of ['  Buyer English / 5pcs  ','中文 & <mixed>\n5pcs','']){
    chosen.raw[h.api.H[10]]=text;
    const result=await h.api.buildOnlineShareLink([chosen]),url=new URL(result);
    assert.equal(url.origin,'https://buyer.example.test');assert.equal(url.pathname,'/s.html');assert.equal(url.hash,'');
    const products=decodeFabricatedShareUrl(result).products;assert.deepEqual(products.map(card=>card.id),[chosen.uid]);assert.equal(products[0].itemChinese,text);
    assert.notEqual(result,previous);previous=result;
    assert.match(h.api.shareLinkMessage(result,1),/1 个产品的直达链接/);assert.doesNotMatch(result,/is\.gd/);
  }
  assert.equal(h.controls.shortenerCalls.length,0);assert.equal(network.mock.callCount(),0);
});

test('direct share generation never reads denied localStorage or contacts the network',async()=>{
  let denyStorage=false,deniedReads=0;
  const h=harness({storageGetter(){
    if(!denyStorage)return {getItem:()=>null};
    deniedReads++;const error=new Error('Fabricated browser storage denial');error.name='SecurityError';throw error;
  }});
  await h.api.ready;
  const chosen=completedShareRecord(h,'STORAGE-DENIED-SELECTED'),other=completedShareRecord(h,'STORAGE-DENIED-PRIVATE');
  h.api.setRows([chosen,other]);h.api.setPaused(true);denyStorage=true;
  const result=await h.api.buildOnlineShareLink([chosen]);
  assert.equal(deniedReads,0,'generating a direct link has no storage dependency');
  assert.equal(h.controls.shortenerCalls.length,0);
  assert.deepEqual(decodeFabricatedShareUrl(result).products.map(card=>card.id),[chosen.uid]);
  assert.match(h.api.shareLinkMessage(result,1),/直达链接/);
  assert.equal(h.transport.mock.callCount(),0);
});

test('direct sharing removes workspace query state and carries every selected card losslessly',async()=>{
  const location={hostname:'buyer.example.test',protocol:'https:',href:'https://buyer.example.test/---2/index.html?workspace=PRIVATE-WORKSPACE&new=1#local-state'};
  const h=harness({location}),chosen=completedShareRecord(h,'direct-first'),second=completedShareRecord(h,'00000000000000000000000000002'),other=completedShareRecord(h,'never-shared');h.api.setRows([chosen,second,other]);
  second.raw[h.api.H[12]]='  5pcs / 蓝色  ';
  const result=await h.api.buildOnlineShareLink([chosen,second]);
  const full=new URL(result);assert.equal(full.origin,'https://buyer.example.test');assert.equal(full.pathname,'/---2/s.html');assert.equal(full.hash,'');
  const products=decodeFabricatedShareUrl(result).products;
  assert.doesNotMatch(result,/PRIVATE-WORKSPACE|local-state/);assert.deepEqual(products.map(card=>card.id),[chosen.uid,second.uid]);assert.equal(products[1].modelChinese,'  5pcs / 蓝色  ');
  assert.match(h.api.shareLinkMessage(result,2),/2 个产品的直达链接/);assert.equal(h.controls.shortenerCalls.length,0);
});

test('a dataset replacement during image preparation prevents a stale share result',async()=>{
  const gate=deferred(),h=harness(),chosen=completedShareRecord(h,'old-share-image');h.api.setRows([chosen]);
  h.controls.shareImageGate=gate.promise;
  const pending=h.api.buildOnlineShareLink([chosen]);
  const rejected=assert.rejects(pending,/工作.*切换|数据.*切换|分享.*变更|重新选择/);
  await waitFor(()=>h.controls.shareSnapshots.length>0,'image preparation begins');
  h.api.setRows([completedShareRecord(h,'new-share-image')]);gate.resolve();await rejected;
  assert.equal(h.controls.shortenerCalls.length,0,'old products never leave the workbench after the dataset changes');
});

test('background field changes during image preparation do not replace or reject the clicked share snapshot',async()=>{
  const gate=deferred(),h=harness(),r=record(h,'FROZEN-SHARE','Source title','Clicked buyer title');r.raw[h.api.H[11]]='Source model';r.raw[h.api.H[12]]='5pcs';h.api.setRows([r]);h.controls.shareImageGate=gate.promise;
  const pending=h.api.buildOnlineShareLink([r]);await waitFor(()=>h.controls.shareSnapshots.length>0,'clicked product snapshot');
  r.raw[h.api.H[10]]='Later background title';r.raw[h.api.H[12]]='Later background model';gate.resolve();const products=decodeFabricatedShareUrl(await pending).products;
  assert.equal(products[0].itemChinese,'Clicked buyer title');assert.equal(products[0].modelChinese,'5pcs');assert.equal(r.raw[h.api.H[10]],'Later background title');assert.equal(r.raw[h.api.H[12]],'Later background model');
  assert.equal(h.transport.mock.callCount(),0);assert.equal(h.controls.categoryCalls,0);
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

test('manual values remain settled when the buyer intentionally clears and then refills a field', async () => {
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
  assert.equal(h.api.readyCount, 1);assert.equal(h.api.rowChineseReady(r),true);
  element.value = '买手确认无线音箱 FICT771';
  element.oninput();
  assert.equal(h.api.readyCount, 1);
});

test('an unmarked empty field is pending while an explicit buyer clear is settled without translation',async()=>{
  const h=harness();await h.api.ready;const r=record(h,'MANUAL-CLEAR-SETTLED','Wireless source FICT2170');h.api.setRows([r]);assert.equal(h.api.readyCount,0);assert.equal(h.api.rowChineseReady(r),false);
  const element=editor(h,r);h.api.bindTable();element.value='';element.oninput();assert.equal(h.api.rowChineseReady(r),true);assert.equal(h.api.readyCount,1);
  await h.api.oneClickChinese();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(h.api.value(r,h.api.H[10]),'');assert.equal(h.api.readyCount,1);assert.equal(h.transport.mock.callCount(),0);
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

test('a yielding readiness scan counts manual clears before and after their scan position as settled exactly once',async()=>{
  const h=harness();await h.api.ready;
  const records=Array.from({length:1000},(_,i)=>{
    const source='Wireless speaker FICT'+(2000+i),r=record(h,'readiness-'+i,source,chineseFor(source));
    Object.assign(r,{autoItemChinese:true,localTranslatedItem:true,translationItemSource:source,translationItemVersion:TRANSLATION_VERSION});return r;
  });
  h.api.setRows(records);assert.ok(h.api.readyCount<1000,'initial scan must yield');
  const early=editor(h,records[0]),late=editor(h,records[750]);h.api.bindTable();
  early.value='';early.oninput();late.value='';late.oninput();
  await waitFor(()=>h.api.readyCount===1000,'readiness scan after two intentionally cleared buyer fields');
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
  h.api.setRows([...auto,manual,provided]);await h.api.retranslateAutomaticChinese();await waitFor(()=>transport.mock.calls.flatMap(call=>call.arguments[0]).length===2,'automatic retranslation dispatch');
  for(const [i,r]of auto.entries())assert.equal(r.raw[h.api.H[10]],'旧自动译文 FICT'+(1720+i));
  gate.resolve();await waitFor(()=>auto.every(r=>r.raw[h.api.H[10]].startsWith('整句重译结果')),'all automatic replacements');
  assert.equal(manual.raw[h.api.H[10]],'买手指定的中文 FICT1722');assert.equal(provided.raw[h.api.H[10]],'导入保留的中文 FICT1723');
  const requested=transport.mock.calls.flatMap(call=>call.arguments[0]);assert.deepEqual(new Set(requested),new Set(auto.map(r=>r.raw[h.api.H[9]])));
  assert.ok(auto.every(r=>r.translationItemVersion===TRANSLATION_VERSION));
});

for(const missing of [10,12])test('sharing preserves an empty current field '+missing+' without filling it from source text',async()=>{
  const h=harness(),r=record(h,'required-'+missing,'');const supplied=missing===10?12:10;r.raw[h.api.H[supplied]]=supplied===10?'人工中文标题':'人工中文型号';r.userEditedFields=[h.api.H[supplied]];h.api.setRows([r]);
  r.raw[h.api.H[missing===10?9:11]]='Original source must never fill the current box';
  const products=decodeFabricatedShareUrl(await h.api.buildOnlineShareLink([r])).products;
  assert.equal(products[0][missing===10?'itemChinese':'modelChinese'],'');assert.equal(h.api.value(r,h.api.H[missing]),'');
  assert.equal(h.transport.mock.callCount(),0);assert.equal(h.controls.categoryCalls,0);
});

test('buyer-completed Chinese title and model can be shared when original fields are absent',async()=>{
  const h=harness(),r=record(h,'completed-without-source','');r.raw[h.api.H[10]]='人工补全中文标题';r.raw[h.api.H[12]]='人工补全中文型号';r.userEditedFields=[h.api.H[10],h.api.H[12]];h.api.setRows([r]);
  const url=await h.api.buildOnlineShareLink([r]);assert.equal(new URL(url).pathname,'/s.html');assert.equal(h.transport.mock.callCount(),0);assert.equal(h.controls.shareSnapshots[0].modelChinese,'人工补全中文型号');
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

test('partial Chrome preparation retries pending languages before a later click switches back online',async()=>{
  let activation=0;
  const chrome={prepareLanguages:mock.fn(async(languages,settings={})=>{
    if(settings.targetLanguage!=='en'&&languages.includes('vi'))activation++;
    return Array.from(languages,sourceLanguage=>{const available=sourceLanguage==='en'||activation>=2;return {sourceLanguage,targetLanguage:settings.targetLanguage||'zh',status:available?'available':'unavailable',...(available?{}:{error:new Error('FICT_ACTIVATION_REQUIRED')})}});
  }),translate:mock.fn(async()=>{assert.fail('buyer-confirmed fields do not need translation')}),destroy(){}};
  const fetch=mock.fn(async()=>{assert.fail('model preparation must not overwrite buyer-confirmed fields')});
  const h=harness({actualTransport:true,fetch,chromeProvider:chrome}),en=record(h,'prepare-en','Wireless speaker FICT1750','人工确认音箱'),vi=record(h,'prepare-vi','Tai nghe không dây FICT1751','人工确认耳机');
  for(const r of [en,vi])r.userEditedFields=[h.api.H[10]];h.api.setRows([en,vi],{visible:[]});
  const button=h.document.getElementById('enableChromeTranslation'),status=h.document.getElementById('chromeTranslationState');
  await h.api.enableChromeTranslation();assert.equal(h.api.chromeMode,true);assert.deepEqual(new Set(h.api.chromeLanguages),new Set(['en']));assert.deepEqual(Array.from(h.api.chromePending),['vi']);
  assert.equal(button.textContent,'补齐本地模型（1）');assert.match(status.textContent,/未准备：vi/);assert.match(status.title,/FICT_ACTIVATION_REQUIRED/);
  await h.api.enableChromeTranslation();assert.equal(h.api.chromeMode,true);assert.deepEqual(new Set(h.api.chromeLanguages),new Set(['en','vi']));assert.equal(h.api.chromePending.length,0);assert.equal(button.textContent,'切回 Google 在线');
  const prepared=chrome.prepareLanguages.mock.callCount();await h.api.enableChromeTranslation();assert.equal(h.api.chromeMode,false);assert.equal(button.textContent,'启用 Chrome 本地翻译');assert.equal(chrome.prepareLanguages.mock.callCount(),prepared);
  assert.equal(chrome.translate.mock.callCount(),0);assert.equal(fetch.mock.callCount(),0);
});

test('importing starts reference translation for item, model and missing categories without sending business fields',async()=>{
  const item='Wireless speaker FICT1800 with charging case',model='Black variant FICT1801 with cable',category='Fictional Musical Room Components';
  const outputs=new Map([[item,'无线音箱 FICT1800，附充电盒'],[model,'黑色型号 FICT1801，附电缆'],[category,'虚构音乐房配件']]),payloads=[];
  const fetch=mock.fn(async(input,init)=>{assert.equal(input,'https://transmart.qq.com/api/imt');assert.equal(init.method,'POST');assert.equal(init.credentials,'omit');const payload=JSON.parse(init.body);payloads.push(payload);assert.deepEqual(Object.keys(payload.source).sort(),['lang','text_list']);assert.doesNotMatch(init.body,/PRIVATE-BUSINESS-ID|PRIVATE-BUYER-NOTE|987654\.321/);assert.ok(payload.source.text_list.length<=8);assert.ok(payload.source.text_list.every(text=>outputs.has(text)));return {status:200,json:async()=>({header:{ret_code:'succ'},auto_translation:payload.source.text_list.map(text=>outputs.get(text))})}});
  const h=harness({actualTransport:true,primaryReference:true,fetch}),automatic=record(h,'PRIVATE-BUSINESS-ID',item),manual=record(h,'private-manual','Wireless manual speaker FICT1802','买手标题保留');
  Object.assign(automatic.raw,{[h.api.H[11]]:model,[h.api.H[13]]:'987654.321',[h.api.H[24]]:'PRIVATE-BUYER-NOTE',level1_global_be_category:category});manual.raw[h.api.H[11]]='Manual model FICT1803';manual.raw[h.api.H[12]]='买手型号保留';manual.userEditedFields=[h.api.H[10],h.api.H[12]];
  h.controls.parse=async()=>({headers:Array.from(h.api.H),rows:[automatic,manual]});await h.api.importFile({name:'fabricated-auto.csv',type:'text/csv'});
  await waitFor(()=>automatic.localTranslatedItem&&automatic.localTranslatedModel&&h.api.categoryLabel(category)==='虚构音乐房配件','automatic import title/model/category translation');
  assert.equal(automatic.raw[h.api.H[10]],outputs.get(item));assert.equal(automatic.raw[h.api.H[12]],outputs.get(model));assert.equal(automatic.translationItemProvider,'tencent-transmart-reference');assert.equal(automatic.translationItemVersion,TRANSLATION_VERSION);
  assert.equal(manual.raw[h.api.H[10]],'买手标题保留');assert.equal(manual.raw[h.api.H[12]],'买手型号保留');assert.deepEqual(new Set(payloads.flatMap(payload=>payload.source.text_list)),new Set(outputs.keys()));
  assert.equal(h.api.queue.limit,2);assert.equal(h.api.queue.batchSize,8);assert.equal(h.api.queue.maxChars,1800);
});

test('restoring local data pauses requests until recovery completes then starts the same automatic pipeline',async()=>{
  const responseGate=deferred(),readGate=deferred(),source='Wireless restored speaker FICT1810';let called=0;
  const fetch=mock.fn(async(input,init)=>{assert.equal(input,'https://transmart.qq.com/api/imt');const payload=JSON.parse(init.body);called++;await responseGate.promise;return {status:200,json:async()=>({header:{ret_code:'succ'},auto_translation:payload.source.text_list.map(()=> '恢复后自动生成的无线音箱 FICT1810')})}});
  const h=harness({actualTransport:true,primaryReference:true,fetch}),r=record(h,'restored-primary',source,'保留的旧版中文 FICT1810');Object.assign(r,{autoItemChinese:true,localTranslatedItem:true,translationItemSource:source,translationItemVersion:'google-v5-20261117'});
  h.controls.savedState={rows:[r],meta:{headers:Array.from(h.api.H),sourceFileName:'fabricated-restored.csv',threshold:90,groupingEnabled:false}};h.controls.loadGate=readGate.promise;
  const startup=h.api.start();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(called,0);assert.equal(h.document.getElementById('import').disabled,true);
  readGate.resolve();await startup;await waitFor(()=>called>0,'reference request after local recovery');assert.equal(r.raw[h.api.H[10]],'保留的旧版中文 FICT1810');assert.equal(r.raw[h.api.H[9]],source);
  responseGate.resolve();await waitFor(()=>r.localTranslatedItem&&r.translationItemVersion===TRANSLATION_VERSION,'restored automatic translation');assert.equal(r.raw[h.api.H[10]],'恢复后自动生成的无线音箱 FICT1810');assert.equal(r.raw[h.api.H[9]],source);assert.equal(h.document.getElementById('import').disabled,false);
});

test('one-click translation refreshes automatic fields across the whole table while preserving manual Chinese',async()=>{
  const gate=deferred(),sent=[],fetch=mock.fn(async(input,init)=>{assert.equal(input,'https://transmart.qq.com/api/imt');const payload=JSON.parse(init.body);sent.push(...payload.source.text_list);await gate.promise;return {status:200,json:async()=>({header:{ret_code:'succ'},auto_translation:payload.source.text_list.map(text=>'整表中文 '+text.match(/FICT\d+/)[0])})}});
  const h=harness({actualTransport:true,primaryReference:true,fetch}),auto=[1820,1821].map(n=>{const source='Wireless speaker FICT'+n,r=record(h,'whole-'+n,source,'旧自动中文 FICT'+n);Object.assign(r,{autoItemChinese:true,localTranslatedItem:true,translationItemSource:source,translationItemVersion:n===1820?TRANSLATION_VERSION:'google-v5-20261117'});h.api.cache.set(source,r.raw[h.api.H[10]]);return r});
  const manual=record(h,'whole-manual','Wireless manual speaker FICT1822','买手确认中文保持');manual.userEditedFields=[h.api.H[10]];h.api.setRows([...auto,manual],{visible:[auto[0]]});
  await h.api.oneClickChinese();await waitFor(()=>sent.length===2,'whole-table reference dispatch');assert.equal(auto[1].raw[h.api.H[10]],'旧自动中文 FICT1821');gate.resolve();
  await waitFor(()=>auto.every(r=>r.raw[h.api.H[10]].startsWith('整表中文')),'off-page automatic Chinese');assert.equal(manual.raw[h.api.H[10]],'买手确认中文保持');assert.deepEqual(new Set(sent),new Set(auto.map(r=>r.raw[h.api.H[9]])));assert.equal(h.document.getElementById('translateAll').disabled,false);
});

test('one-click protects imported buyer Chinese even before deferred field derivation has marked its provenance',async()=>{
  const h=harness();await h.api.ready;const r=record(h,'not-yet-derived','Wireless speaker FICT1823','导入文件中的买手中文');h.api.setRows([r]);
  await h.api.oneClickChinese();await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(r.raw[h.api.H[10]],'导入文件中的买手中文');assert.equal(r.autoItemChinese,false);assert.equal(h.transport.mock.callCount(),0);
});

test('a scoped automatic launch prepares and translates only added records while readiness still counts all rows',async()=>{
  const available=mock.fn(async()=> 'unavailable'),chrome={available,prepareLanguages:mock.fn(async()=>[]),destroy(){}};
  const h=harness({chromeProvider:chrome}),old=record(h,'APPEND-OLD','Caixa de som FICT2201','旧自动中文 FICT2201');
  Object.assign(old,{autoItemChinese:true,localTranslatedItem:true,translationItemSource:old.raw[h.api.H[9]],translationItemVersion:'older-provider',translationItemWarning:'旧提示',translationItemProvider:'old-provider'});
  old.raw.level1_global_be_category='Synthetic Old Category FICT2202';
  const english=record(h,'APPEND-NEW-EN','Wireless appended speaker FICT2203'),vietnamese=record(h,'APPEND-NEW-VI','Bộ gọi không dây FICT2204');
  english.raw[h.api.H[11]]='Black appended variant FICT2205';english.raw.level1_global_be_category='Synthetic Added Category FICT2206';
  const dataset=[old,english,vietnamese],snapshot=JSON.stringify(old);h.api.setRows(dataset,{visible:[old]});
  h.api.launchAutomaticChinese(dataset,{records:[english,vietnamese]});
  await waitFor(()=>h.api.rowChineseReady(english)&&h.api.rowChineseReady(vietnamese)&&h.api.categoryLabel(english.raw.level1_global_be_category)&&h.api.queue.active===0,'added fields and category finish');
  assert.deepEqual(new Set(h.transport.mock.calls.flatMap(call=>call.arguments[0])),new Set([english.raw[h.api.H[9]],english.raw[h.api.H[11]],vietnamese.raw[h.api.H[9]],english.raw.level1_global_be_category]));
  assert.ok(available.mock.calls.length);assert.ok(available.mock.calls.every(call=>['en','vi'].includes(call.arguments[0])),'the old Portuguese record never enters model preparation');
  assert.equal(JSON.stringify(old),snapshot);assert.equal(h.api.readyCount,2);assert.equal(h.api.rows.length,3);assert.equal(h.api.scoped,true);
  assert.deepEqual(Array.from(h.api.scopedRecords,r=>r.uid),[english.uid,vietnamese.uid]);
  h.api.queueVisibleTranslation();await h.api.startBackgroundTranslation(true);await h.api.translateVisible(dataset);await new Promise(resolve=>setTimeout(resolve,90));
  assert.equal(JSON.stringify(old),snapshot,'later renders/visible and background passes keep the same scope');
  assert.ok(h.transport.mock.calls.flatMap(call=>call.arguments[0]).every(text=>text!==old.raw[h.api.H[9]]&&text!==old.raw.level1_global_be_category));
  h.api.updateTranslationStatus();assert.match(h.document.getElementById('translationState').textContent,/2 \/ 3/);
});

test('a scoped launch preserves a user pause and resumes only the added fields and categories',async()=>{
  const h=harness(),old=record(h,'SCOPED-PAUSE-OLD','Wireless existing source FICT2210'),added=record(h,'SCOPED-PAUSE-NEW','Wireless appended source FICT2211');
  old.raw.level1_global_be_category='Synthetic Paused Old Category FICT2212';added.raw.level1_global_be_category='Synthetic Paused Added Category FICT2213';
  const dataset=[old,added],snapshot=JSON.stringify(old);h.api.setRows(dataset);h.api.setPaused(true);
  h.api.launchAutomaticChinese(dataset,{records:[added]});await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(h.api.userPaused,true);assert.equal(h.api.queue.paused,true);assert.equal(h.transport.mock.callCount(),0);assert.equal(JSON.stringify(old),snapshot);
  h.api.toggleTranslationPause();
  await waitFor(()=>added.localTranslatedItem&&h.api.categoryLabel(added.raw.level1_global_be_category)&&h.api.queue.active===0,'resume added fields and category');
  assert.equal(h.api.userPaused,false);assert.deepEqual(new Set(h.transport.mock.calls.flatMap(call=>call.arguments[0])),new Set([added.raw[h.api.H[9]],added.raw.level1_global_be_category]));assert.equal(JSON.stringify(old),snapshot);
});

test('an explicit unscoped launch restores normal whole-table fields and categories',async()=>{
  const h=harness(),old=record(h,'SCOPE-RESET-OLD','Wireless previous source FICT2220'),added=record(h,'SCOPE-RESET-NEW','Wireless appended source FICT2221');
  old.raw.level1_global_be_category='Synthetic Reset Old Category FICT2222';const dataset=[old,added];h.api.setRows(dataset);
  h.api.launchAutomaticChinese(dataset,{records:[added]});await waitFor(()=>added.localTranslatedItem&&h.api.queue.active===0,'scoped appended translation');assert.equal(old.raw[h.api.H[10]],undefined);
  h.api.launchAutomaticChinese(dataset);await waitFor(()=>old.localTranslatedItem&&h.api.categoryLabel(old.raw.level1_global_be_category)&&h.api.queue.active===0,'normal whole-table restart');
  assert.equal(h.api.scoped,false);assert.equal(h.api.readyCount,2);assert.ok(h.transport.mock.calls.flatMap(call=>call.arguments[0]).includes(old.raw[h.api.H[9]]));assert.ok(h.transport.mock.calls.flatMap(call=>call.arguments[0]).includes(old.raw.level1_global_be_category));
});

test('one-click after a scoped append can refresh trusted automatic fields from the entire table',async()=>{
  const h=harness(),old=record(h,'SCOPE-ONECLICK-OLD','Wireless old automatic FICT2230','旧自动中文 FICT2230'),added=record(h,'SCOPE-ONECLICK-NEW','Wireless added automatic FICT2231');
  Object.assign(old,{autoItemChinese:true,localTranslatedItem:true,translationItemSource:old.raw[h.api.H[9]],translationItemVersion:TRANSLATION_VERSION});const dataset=[old,added];h.api.setRows(dataset);
  h.api.launchAutomaticChinese(dataset,{records:[added]});await waitFor(()=>added.localTranslatedItem&&h.api.queue.active===0,'scoped append before whole-table click');assert.equal(old.raw[h.api.H[10]],'旧自动中文 FICT2230');
  await h.api.oneClickChinese();await waitFor(()=>old.raw[h.api.H[10]]===chineseFor(old.raw[h.api.H[9]])&&h.api.queue.active===0,'whole-table one-click leaves scoped mode');assert.equal(h.api.scoped,false);
});

test('an empty or foreign-object scope never queues old rows even when UIDs match',async()=>{
  const h=harness(),old=record(h,'SCOPE-FOREIGN-ID','Wireless current source FICT2240'),other=record(h,'SCOPE-FOREIGN-ID','Wireless other dataset source FICT2241'),dataset=[old],snapshot=JSON.stringify(old);h.api.setRows(dataset);
  h.api.launchAutomaticChinese(dataset,{records:[]});await h.api.startBackgroundTranslation(true);await h.api.translateVisible(dataset);
  h.api.launchAutomaticChinese(dataset,{records:[other]});h.api.queueVisibleTranslation();await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(h.api.scoped,true);assert.equal(h.api.scopedRecords.length,0);assert.equal(h.transport.mock.callCount(),0);assert.equal(JSON.stringify(old),snapshot);
});

test('an old pending response cannot mutate a retained old record after append replaces the dataset array',async()=>{
  const gate=deferred(),oldSource='Wireless in-flight old source FICT2250';
  const transport=mock.fn(async texts=>{if(texts.includes(oldSource))await gate.promise;return texts.map(chineseFor)}),h=harness({transport}),old=record(h,'APPEND-RETAINED-OLD',oldSource),added=record(h,'APPEND-ACTUAL-NEW','Wireless appended source FICT2251');
  h.api.setRows([old]);const pending=h.api.translateVisible([old]);await waitFor(()=>transport.mock.callCount()===1,'old request already in flight');const snapshot=JSON.stringify(old);
  const dataset=[old,added];h.api.setRows(dataset);h.api.launchAutomaticChinese(dataset,{records:[added]});await waitFor(()=>added.localTranslatedItem,'added request finishes while the old response is pending');
  gate.resolve();await pending;await waitFor(()=>h.api.queue.active===0,'old response has settled');h.api.queueVisibleTranslation();await new Promise(resolve=>setTimeout(resolve,90));assert.equal(JSON.stringify(old),snapshot);assert.equal(added.raw[h.api.H[10]],chineseFor(added.raw[h.api.H[9]]));
});

test('a late primary response from an imported dataset cannot update a replacement with the same UID',async()=>{
  const gate=deferred(),oldSource='Wireless old speaker FICT1830',newSource='Wireless new speaker FICT1831';let oldRequested=false;
  const fetch=mock.fn(async(input,init)=>{assert.equal(input,'https://transmart.qq.com/api/imt');const payload=JSON.parse(init.body);if(payload.source.text_list.includes(oldSource)){oldRequested=true;await gate.promise}return {status:200,json:async()=>({header:{ret_code:'succ'},auto_translation:payload.source.text_list.map(text=>text===oldSource?'旧数据返回中文 FICT1830':'新数据返回中文 FICT1831')})}});
  const h=harness({actualTransport:true,primaryReference:true,fetch}),old=record(h,'same-imported-uid',oldSource),current=record(h,'same-imported-uid',newSource);h.controls.parse=async file=>({headers:Array.from(h.api.H),rows:[file.name==='old-auto.csv'?old:current]});
  await h.api.importFile({name:'old-auto.csv',type:'text/csv'});await waitFor(()=>oldRequested,'old import translation');await h.api.importFile({name:'new-auto.csv',type:'text/csv'});await waitFor(()=>current.localTranslatedItem,'replacement translation');
  gate.resolve();await waitFor(()=>h.api.queue.active===0,'late old primary result');assert.equal(old.raw[h.api.H[10]],'');assert.equal(current.raw[h.api.H[10]],'新数据返回中文 FICT1831');assert.equal(current.raw[h.api.H[9]],newSource);
});

test('category dictionaries and supplied Chinese paths take priority over generated cache text',()=>{
  const h=harness();h.api.categoryTranslationCache.set('home&living','不应覆盖字典的旧缓存');assert.equal(h.api.categoryLabel('Home & Living'),'家居生活');
  const path=record(h,'category-path','');Object.assign(path.raw,{level1_global_be_category:'Unknown Original Category',category_path_zh:'用户提供一级 > 用户提供二级'});assert.equal(h.api.categoryPath(path),'用户提供一级 > 用户提供二级');
  const levels=record(h,'category-levels','');Object.assign(levels.raw,{level1_global_be_category:'Home & Living',level2_global_be_category:'Home Decor',level1_global_be_category_zh:'自带一级',level2_global_be_category_cn:'自带二级'});assert.equal(h.api.categoryPath(levels),'自带一级 > 自带二级');
  const dictionary=record(h,'category-dictionary','');dictionary.raw.level1_global_be_category='Electronics';assert.equal(h.api.categoryPath(dictionary),'电子产品');assert.equal(h.transport.mock.callCount(),0);
});

test('the reference service can fall back internally to Google without exposing a provider choice',async()=>{
  const source='Wireless fallback speaker FICT1840',hosts=[],fetch=mock.fn(async(input,init)=>{const host=new URL(input).hostname;hosts.push(host);if(host==='transmart.qq.com')return {status:503};assert.equal(host,'translate.googleapis.com');assert.equal(new URL(input).searchParams.get('q'),source);return {status:200,json:async()=>[[['备用通道完整中文 FICT1840']]]}});
  const h=harness({actualTransport:true,primaryReference:true,fetch}),r=record(h,'reference-fallback',source);h.api.setRows([r]);await h.api.translateVisible([r]);assert.equal(r.raw[h.api.H[10]],'备用通道完整中文 FICT1840');assert.equal(r.translationItemProvider,'google-online');assert.deepEqual(hosts,['transmart.qq.com','translate.googleapis.com']);
});

test('the visible translation UI has only one-click and import actions and no per-cell translation tools',()=>{
  const markup=documentHtml.slice(0,documentHtml.indexOf('<script data-buyer-translation-engine'));
  const advanced=markup.match(/<div\b[^>]*id="advancedTranslationControls"[^>]*>[\s\S]*?<\/div>/);assert.ok(advanced);assert.match(advanced[0],/\bhidden\b/);
  const visible=markup.replace(advanced[0],''),buttons=Array.from(visible.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)).map(match=>({id:match[1].match(/\bid="([^"]+)"/)?.[1],text:match[2].replace(/<[^>]*>/g,'').trim()})).filter(button=>/翻译|译文|模型|Google/.test(button.text));
  assert.deepEqual(buttons,[{id:'translateAll',text:'一键翻译'},{id:'importTranslations',text:'导入翻译'}]);assert.doesNotMatch(between('function rowHtml(', 'function updateCalculatedCells('),/translation-cell-tools|data-retranslate-field|Google核对/);
  assert.ok(/["']translateAll["']\)\.onclick\s*=\s*(?:\(\)\s*=>\s*)?oneClickChinese/.test(html),'the visible action invokes the unified one-click pipeline');
});

test('the supplied browser CSV keeps its fourth buyer-Chinese row out of automatic transport',async()=>{
  // Same four synthetic records as qa-v7/buyer-test-auto-reference.csv;
  // the committed fixture omits image bytes so the regression is self-contained.
  const sent=[],fetch=mock.fn(async(input,init)=>{assert.equal(input,'https://transmart.qq.com/api/imt');const payload=JSON.parse(init.body);sent.push(...payload.source.text_list);assert.doesNotMatch(init.body,/AUTO-TEST-|QATEST|backcal_cogs|item_name_zh|model_name_zh/);return {status:200,json:async()=>({header:{ret_code:'succ'},auto_translation:payload.source.text_list.map(chineseFor)})}});
  const h=harness({actualTransport:true,primaryReference:true,realCsv:true,fetch}),file=csvFile(fs.readFileSync(path.join(__dirname,'fixtures','buyer-test-auto-reference.csv'),'utf8'),'buyer-test-auto-reference.csv');await h.api.importFile(file);
  const buyer=h.api.rows.find(r=>r.raw['Model ID']==='AUTO-TEST-4'),foreign=h.api.rows.filter(r=>r!==buyer);assert.ok(buyer);assert.equal(h.api.rows.length,4);
  await waitFor(()=>foreign.every(r=>r.localTranslatedItem&&r.localTranslatedModel)&&h.api.queue.active===0,'the first three fixture records translate automatically');
  const check=()=>{assert.equal(h.api.value(buyer,h.api.H[10]),'买手确认的中文音箱标题 5 W');assert.equal(h.api.value(buyer,h.api.H[12]),'买手确认的黑色型号 1 件');assert.equal(buyer.autoItemChinese,false);assert.equal(buyer.autoModelChinese,false);assert.ok(!sent.includes(buyer.raw.item_name));assert.ok(!sent.includes(buyer.raw.model_name))};check();
  const before=sent.length;await h.api.oneClickChinese();await waitFor(()=>sent.length>before&&foreign.every(r=>r.localTranslatedItem&&r.localTranslatedModel)&&h.api.queue.active===0,'the one-click rerun completes for automatic fixture fields');check();
});

for(const suffix of ['zh','cn'])test('main-file standard _'+suffix+' Chinese headers remain buyer text before automatic translation',async()=>{
  const h=harness({realCsv:true}),text='Model ID,item_name,model_name,item_name_'+suffix+',model_name_'+suffix+'\r\nSTANDARD-'+suffix+',Wireless standard speaker FICT1910,Black variant FICT1911,文件买手中文标题,文件买手中文型号';
  await h.api.importFile(csvFile(text));await waitFor(()=>h.api.rows[0]?.autoItemChinese===false&&h.api.rows[0]?.autoModelChinese===false,'standard Chinese fields classified as buyer text');const r=h.api.rows[0];
  assert.equal(h.api.key('item_name_'+suffix),'itemchinese');assert.equal(h.api.key('model_name_'+suffix),'modelchinese');assert.equal(h.api.value(r,h.api.H[10]),'文件买手中文标题');assert.equal(h.api.value(r,h.api.H[12]),'文件买手中文型号');assert.equal(h.transport.mock.callCount(),0);
});

test('new main-file Chinese takes priority over previous automatic translations for the same source',async()=>{
  const h=harness({realCsv:true}),item='Wireless merge speaker FICT1920',model='Black merge variant FICT1921',old=record(h,'MERGE-NEW-CHINESE',item,'旧自动标题');old.raw[h.api.H[11]]=model;old.raw[h.api.H[12]]='旧自动型号';
  Object.assign(old,{autoItemChinese:true,autoModelChinese:true,localTranslatedItem:true,localTranslatedModel:true,translationItemSource:item,translationModelSource:model,translationItemVersion:TRANSLATION_VERSION,translationModelVersion:TRANSLATION_VERSION});h.api.setRows([old]);
  await h.api.importFile(csvFile('Model ID,item_name,model_name,item_name_zh,model_name_cn\r\nMERGE-NEW-CHINESE,'+item+','+model+',本次文件中文标题,本次文件中文型号'));await waitFor(()=>h.api.rows[0]?.autoItemChinese===false&&h.api.rows[0]?.autoModelChinese===false,'incoming Chinese preserved over old automatic provenance');
  const current=h.api.rows[0];assert.equal(h.api.value(current,h.api.H[10]),'本次文件中文标题');assert.equal(h.api.value(current,h.api.H[12]),'本次文件中文型号');assert.equal(h.transport.mock.callCount(),0);
});

test('previous explicit buyer edits retain priority over new main-file standard Chinese columns',async()=>{
  const h=harness({realCsv:true}),item='Wireless buyer speaker FICT1930',model='Black buyer variant FICT1931',old=record(h,'MERGE-BUYER-CHINESE',item,'本机买手手改标题');old.raw[h.api.H[11]]=model;old.raw[h.api.H[12]]='本机买手手改型号';old.userEditedFields=[h.api.H[10],h.api.H[12]];old.autoItemChinese=false;old.autoModelChinese=false;h.api.setRows([old]);
  await h.api.importFile(csvFile('Model ID,item_name,model_name,item_name_cn,model_name_zh\r\nMERGE-BUYER-CHINESE,'+item+','+model+',新文件标题,新文件型号'));await new Promise(resolve=>setTimeout(resolve,20));const current=h.api.rows[0];
  assert.equal(h.api.value(current,h.api.H[10]),'本机买手手改标题');assert.equal(h.api.value(current,h.api.H[12]),'本机买手手改型号');assert.ok(current.userEditedFields.includes(h.api.H[10]));assert.ok(current.userEditedFields.includes(h.api.H[12]));assert.equal(h.transport.mock.callCount(),0);
});

test('the Chinese import action accepts two-column _zh and _cn files with the actual CSV parser',async()=>{
  const h=harness({realCsv:true}),r=record(h,'STANDARD-TRANSLATION','Wireless import speaker FICT1940');r.raw[h.api.H[11]]='Black import variant FICT1941';h.api.setRows([r]);
  await h.api.importTranslations(csvFile('Model ID,item_name_zh\r\nSTANDARD-TRANSLATION,标准列导入中文标题'));
  await h.api.importTranslations(csvFile('Model ID,model_name_cn\r\nSTANDARD-TRANSLATION,标准列导入中文型号'));
  assert.equal(h.api.value(r,h.api.H[10]),'标准列导入中文标题');assert.equal(h.api.value(r,h.api.H[12]),'标准列导入中文型号');assert.ok(r.userEditedFields.includes(h.api.H[10]));assert.ok(r.userEditedFields.includes(h.api.H[12]));await new Promise(resolve=>setTimeout(resolve,80));assert.equal(h.transport.mock.callCount(),0);
});

test('new main-file buyer text in a translation column outranks a saved automatic translation even without Chinese',()=>{
  const h=harness(),source='Wireless saved speaker FICT1950',old=record(h,'MERGE-INVALID',source,'已保存有效自动中文'),incoming=record(h,'MERGE-INVALID',source);incoming.raw.item_name_zh='Different English description';
  Object.assign(old,{autoItemChinese:true,localTranslatedItem:true,translationItemSource:source,translationItemVersion:TRANSLATION_VERSION});h.api.mergeBuyerEdits([incoming],[old]);
  assert.equal(h.api.value(incoming,h.api.H[10]),'Different English description');assert.equal(incoming.raw[h.api.H[9]],source);
});

for(const suffix of ['zh','cn'])test('main-file _'+suffix+' columns preserve English buyer titles and 5pcs models through automatic and one-click work',async()=>{
  const h=harness({realCsv:true}),text='Model ID,item_name,model_name,item_name_'+suffix+',model_name_'+suffix+'\r\nBUYER-ASCII-'+suffix+',Wireless source FICT2100,Black source FICT2101,Buyer English title,5pcs';
  await h.api.importFile(csvFile(text));await waitFor(()=>h.api.rows[0]?.autoItemChinese===false&&h.api.rows[0]?.autoModelChinese===false,'provided ASCII fields become buyer-owned');
  const r=h.api.rows[0];await h.api.oneClickChinese();await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(h.api.value(r,h.api.H[10]),'Buyer English title');assert.equal(h.api.value(r,h.api.H[12]),'5pcs');assert.equal(h.transport.mock.callCount(),0);
  assert.ok(r.userEditedFields.includes(h.api.H[10]));assert.ok(r.userEditedFields.includes(h.api.H[12]));
});

for(const value of ['5pcs','Buyer English model','蓝色 Blue / 5pcs'])test('a model imported through the translation attachment remains authoritative: '+value,async()=>{
  const h=harness({realCsv:true}),r=record(h,'MODEL-ATTACHMENT','', 'Buyer title');r.raw[h.api.H[11]]='Original black model FICT2110';r.raw[h.api.H[12]]='旧自动中文型号';
  Object.assign(r,{autoModelChinese:true,localTranslatedModel:true,translationModelSource:r.raw[h.api.H[11]],translationModelVersion:TRANSLATION_VERSION});h.api.setRows([r]);
  await h.api.importTranslations(csvFile('Model ID,model_name_cn\r\nMODEL-ATTACHMENT,'+value));await h.api.oneClickChinese();await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(h.api.value(r,h.api.H[12]),value);assert.equal(r.autoModelChinese,false);assert.ok(r.userEditedFields.includes(h.api.H[12]));assert.equal(h.transport.mock.callCount(),0);
});

for(const value of ['5pcs','English only model','蓝色 Blue / 5pcs',''])test('manual model edits survive one-click and an already pending automatic response: '+JSON.stringify(value),async()=>{
  const gate=deferred(),transport=mock.fn(async texts=>{await gate.promise;return texts.map(chineseFor)}),h=harness({transport}),r=record(h,'MODEL-MANUAL-'+JSON.stringify(value),'','Buyer title');r.raw[h.api.H[11]]='Original black model FICT2120';h.api.setRows([r]);
  const element=editor(h,r,h.api.H[12]);h.api.bindTable();const pending=h.api.translateVisible([r]);await waitFor(()=>transport.mock.callCount()===1,'automatic model request before the buyer edit');
  element.value=value;element.oninput();await h.api.oneClickChinese();gate.resolve();await pending;await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(h.api.value(r,h.api.H[12]),value);assert.equal(element.value,value);assert.equal(r.autoModelChinese,false);assert.ok(r.userEditedFields.includes(h.api.H[12]));assert.equal(transport.mock.callCount(),1);
});

test('old filled model fields without trustworthy automatic source provenance are protected before derive',async()=>{
  const h=harness(),values=['5pcs','English model text','混合 Blue','异常 ZXQ0001QXZ'];const rows=values.map((value,index)=>{const r=record(h,'OLD-PROVIDED-'+index,'','Buyer title');r.raw[h.api.H[11]]='Original model FICT213'+index;r.raw[h.api.H[12]]=value;if(index%2===1)r.autoModelChinese=true;return r});
  h.api.setRows(rows);await h.api.oneClickChinese();await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(rows.map(r=>h.api.value(r,h.api.H[12])),values);assert.ok(rows.every(r=>r.autoModelChinese===false&&r.userEditedFields.includes(h.api.H[12])));assert.equal(h.transport.mock.callCount(),0);
});

test('a target filled without provenance while a request is pending cannot receive the stale automatic result',async()=>{
  const gate=deferred(),transport=mock.fn(async texts=>{await gate.promise;return texts.map(chineseFor)}),h=harness({transport}),r=record(h,'MODEL-TARGET-SNAPSHOT','','Buyer title');r.raw[h.api.H[11]]='Original model FICT2150';h.api.setRows([r]);
  const pending=h.api.translateVisible([r]);await waitFor(()=>transport.mock.callCount()===1,'model request before another editor fills its target');
  h.api.setRaw(r,12,'5pcs');gate.resolve();await pending;await h.api.oneClickChinese();await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(h.api.value(r,h.api.H[12]),'5pcs');assert.equal(transport.mock.callCount(),1);assert.equal(r.autoModelChinese,false);
});

test('an old unprovenanced buyer model survives a later main-file merge instead of being treated as automatic',()=>{
  const h=harness(),old=record(h,'OLD-BUYER-MERGE','','Buyer title'),incoming=record(h,'OLD-BUYER-MERGE','','New file title');old.raw[h.api.H[11]]='Original model';old.raw[h.api.H[12]]='5pcs';old.autoModelChinese=true;
  incoming.raw[h.api.H[11]]='Original model';incoming.raw.model_name_cn='New file model';h.api.mergeBuyerEdits([incoming],[old]);
  assert.equal(h.api.value(incoming,h.api.H[12]),'5pcs');assert.equal(incoming.autoModelChinese,false);assert.ok(incoming.userEditedFields.includes(h.api.H[12]));
});

test('clearing an imported alias field remains empty through one-click and a later main-file import',async()=>{
  const h=harness({realCsv:true}),headers='Model ID,item_name,model_name,item_name_zh,model_name_cn\r\n';
  await h.api.importFile(csvFile(headers+'CLEAR-ALIAS,Source item FICT2160,Source model FICT2161,Buyer title,5pcs'));await waitFor(()=>h.api.rows[0]?.autoModelChinese===false,'imported model ownership');
  const r=h.api.rows[0],element=editor(h,r,h.api.H[12]);h.api.bindTable();element.value='';element.oninput();await h.api.oneClickChinese();
  assert.equal(h.api.value(r,h.api.H[12]),'');assert.equal(r.raw.model_name_cn,'5pcs','the stale source alias is not copied back over an intentional clear');
  await h.api.importFile(csvFile(headers+'CLEAR-ALIAS,Source item FICT2160,Source model FICT2161,New file title,6pcs'));await h.api.oneClickChinese();await new Promise(resolve=>setTimeout(resolve,20));
  const current=h.api.rows[0];assert.equal(h.api.value(current,h.api.H[12]),'');assert.ok(current.userEditedFields.includes(h.api.H[12]));assert.equal(current.autoModelChinese,false);assert.equal(h.transport.mock.callCount(),0);
});

test('a missing reference entry alone uses Google fallback while its successful neighbor stays untouched',async()=>{
  const good='Wireless speaker FICT1960',missing='Black variant FICT1961',referenceTexts=[],googleTexts=[];
  const fetch=mock.fn(async(input,init)=>{
    if(new URL(input).hostname==='transmart.qq.com'){const payload=JSON.parse(init.body);referenceTexts.push(...payload.source.text_list);return {status:200,json:async()=>({header:{ret_code:'succ'},auto_translation:payload.source.text_list.map(text=>text===good?'参考成功音箱 FICT1960':'')})}}
    assert.equal(new URL(input).hostname,'translate.googleapis.com');const source=new URL(input).searchParams.get('q');googleTexts.push(source);assert.equal(source,missing);return {status:200,json:async()=>[[['备用补齐黑色型号 FICT1961']]]};
  });
  const h=harness({actualTransport:true,primaryReference:true,fetch}),r=record(h,'partial-reference',good);r.raw[h.api.H[11]]=missing;h.api.setRows([r]);await h.api.translateVisible([r]);
  assert.equal(r.raw[h.api.H[10]],'参考成功音箱 FICT1960');assert.equal(r.raw[h.api.H[12]],'备用补齐黑色型号 FICT1961');assert.equal(r.translationItemProvider,'tencent-transmart-reference');assert.equal(r.translationModelProvider,'google-online');assert.deepEqual(googleTexts,[missing]);assert.equal(referenceTexts.filter(text=>text===good).length,1);
});

test('a failed fallback entry cannot discard a successful reference neighbor in the same batch',async()=>{
  const good='Wireless good speaker FICT1970',missing='Black missing variant FICT1971',calls=[];
  const provider={create:()=>({async translateBatch(texts){calls.push(...texts);return texts.map(text=>text===good?'已成功返回的音箱中文 FICT1970':'')}})};
  const fetch=mock.fn(async input=>{assert.equal(new URL(input).hostname,'translate.googleapis.com');assert.equal(new URL(input).searchParams.get('q'),missing);return {status:200,json:async()=>[[['UNTRANSLATED']]]}});
  const h=harness({actualTransport:true,referenceProvider:provider,fetch}),r=record(h,'failed-partial-fallback',good);r.raw[h.api.H[11]]=missing;h.api.setRows([r]);await h.api.translateVisible([r]);
  assert.equal(r.raw[h.api.H[10]],'已成功返回的音箱中文 FICT1970');assert.equal(r.localTranslatedItem,true);assert.equal(r.raw[h.api.H[12]],'');assert.equal(r.localTranslatedModel,false);assert.equal(calls.filter(text=>text===good).length,1);
});
