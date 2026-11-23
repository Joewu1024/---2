'use strict';

// Offline regression checks execute source extracted from index.html. DOM and
// IndexedDB are deliberately simulated: this is not a real-browser/Google test.
// All records below are fabricated, and fetch is forbidden.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const BuyerTranslation = require('../translation-engine.js');
const WorkbenchImport = require('../workbench-import.js');
const XLSX = require('../vendor/xlsx.full.min.js');
const documentHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const html = Array.from(documentHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)).at(-1)[1];
const lines = html.split(/\r?\n/);
const line = prefix => {
  const found = lines.find(s => s.startsWith(prefix));
  assert.ok(found, 'Missing definition: ' + prefix);
  return found;
};
const between = (start, end) => {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  assert.ok(a >= 0 && b > a, 'Missing source range: ' + start);
  return html.slice(a, b);
};
const plain = value => JSON.parse(JSON.stringify(value));

function fakeDatabase() {
  const stores = Object.fromEntries(['records', 'meta', 'versions', 'versionRecords'].map(name => [name, new Map()]));
  const keyOf = (name, value) => name === 'versionRecords' ? JSON.stringify([value.versionId, value.uid]) : value[name === 'records' ? 'uid' : name === 'meta' ? 'key' : 'id'];
  const request = value => { const req = {}; queueMicrotask(() => { req.result = plain(value); req.onsuccess?.({ target: req }); }); return req; };
  const db = {
    stores, transactions: [],
    transaction(names, mode) {
      db.transactions.push({ names, mode });
      const tx = {
        objectStore(name) {
          const store = stores[name];
          return {
            getAll: () => request([...store.values()]), get(key) { const req=request(store.get(key)??null);db.beforeGet?.(name,key);return req; },
            put(value) { store.set(keyOf(name, value), plain(value)); const req={onsuccess:null};queueMicrotask(()=>req.onsuccess?.({target:req}));return req; },
            add(value) { if(store.has(keyOf(name,value)))throw Error('ConstraintError: duplicate key');return this.put(value); },
            delete: key => store.delete(key), clear: () => store.clear(),
            index() {
              return {
                getAll: id => request([...store.values()].filter(r => r.versionId === id)),
                openCursor(id) {
                  const req = {}, entries = [...store.entries()].filter(([,r]) => r.versionId === id); let at = 0;
                  const advance = () => queueMicrotask(() => {
                    const entry = entries[at++];
                    req.result = entry ? { delete: () => store.delete(entry[0]), continue: advance } : null;
                    req.onsuccess?.({ target: req });
                  }); advance(); return req;
                }
              };
            }
          };
        }
      };
      if (mode === 'readwrite') setImmediate(() => tx.oncomplete?.());
      return tx;
    }
  };
  return db;
}

function harness(options={}) {
  const elements = new Map(), controls = { writable: true, nodesBySelector: {}, batch: [], editors: [], checks: [], versionLabels: [], versionRenames: [], versionTitles: [], calculations: [], downloads: [], renders: 0, parse: null, dbGate: null, promptValue: null, setLookups: 0 }, db = options.db||fakeDatabase();
  const selectAll = selector => {
    if (Object.hasOwn(controls.nodesBySelector, selector)) return controls.nodesBySelector[selector];
    if (selector === '[data-batch]') return controls.batch;
    if (selector === '[data-edit]') return controls.editors;
    if (selector === '[data-calc-row]') return controls.calculations;
    if (selector === '[data-version-delete]') return controls.checks;
    if (selector === '[data-version-delete]:checked') return controls.checks.filter(x => x.checked);
    if (selector === '[data-version-label]') return controls.versionLabels;
    if (selector === '[data-version-rename]') return controls.versionRenames;
    if (selector === '[data-version-title]') return controls.versionTitles;
    return [];
  };
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, attributes: {}, style: { setProperty() {} },
      setAttribute(name,value){this.attributes[name]=String(value)},getAttribute(name){return this.attributes[name]??null},removeAttribute(name){delete this.attributes[name]},setCustomValidity(message){this.validationMessage=String(message)},
      querySelector: selector => selector.startsWith('#') ? element(selector.slice(1)) : null,
      querySelectorAll: selectAll
    });
    return elements.get(id);
  }
  element('sort').value = 'desc';
  const document = { getElementById: element, querySelectorAll: selectAll, querySelector: () => null, documentElement: { clientWidth: 1400 } };
  const extracted = [
    line('const H='), line('const S='), line('const FIELD='), line('let rows='), line('let buyerCustomOptions='),
    line('const rawLookupCache='), line('const keyMap='),
    ...['key','safeHttpUrl','safeImageUrl','headerScore','isMetaRow','getRaw','invalidateRaw','normalizeModelId','round2','format2','calc','value','filterValue','aliasFor','translationWarningField'].map(n=>line('function '+n+'(')),
    between('// buyer-choice:start', 'function statusValue('),
    between('// filter-conditions:start', '// filter-conditions:end'),
    between('// batch-model-search:start', '// batch-model-search:end'),
    between('// buyer-chinese-priority:start', '// buyer-chinese-priority:end'),
    between('// group-selection:start', '// group-selection:end'),
    ...['statusValue','statusLines','groupIsOpen','visibleFields','displayColumns','colSize','updateStats','matchesState','updateSelectionUI','selectedSummary','activeFilterItems','renderFilterSummary','sorted','recordsGroups','renderPager','render'].map(n=>line('function '+n+'(')),
    between('function rowHtml(', 'function closeProductCard('),
    line('function bindTable('), between('function batch()', 'function openWorkbenchDB('),
    ...['dbRequest','localDateKey','writeRecordBatches'].map(n=>line('function '+n+'(')),
    ...['listVersions','readVersion','showVersion'].map(n=>line('async function '+n+'(')),
    between('async function refreshVersions(', 'async function saveVersion('),
    between('async function saveVersion(', 'async function readVersion('),
    line('function returnToCurrent('), line('async function restoreVersionAsCurrent('), line('function markDirty('), line('function save('), line('async function flushSave('),
    ...['textTokens','titleSimilarity','imageDistance','imageKey','sameImage','imageSimilarity','similarityPercent','similarProduct','escapeRe','extractBrand','extractStyle','extractQty','deriveRecord'].map(n=>line('function '+n+'(')),
    between('async function regroup(', 'async function prepareImageHashes('), line('function parseDelimited('), between('function selectImportHeader(', 'async function workbookHasEmbeddedImages('),
    between('function xmlEsc(', 'function mergeBuyerEdits('),
    between('function mergeBuyerEdits(', 'async function runDeferredProcessing('), between('async function importFile(', 'async function importInvitations('),
    between('async function importInvitations(', 'async function importTranslations('),
    between('async function importTranslations(', 'function download('),
    // This binding also contains other handlers, whose actions remain uncalled.
    line('$("import").onclick=')
  ].join('\n');
  const context = vm.createContext({
    document, console, controls, db, BuyerTranslation, WorkbenchImport, Blob, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, URL, URLSearchParams, AbortController,
    workspace: { isDefault:true, created:false, dbName:base=>base||'buyer-pool-workbench', storageKey:base=>base },
    innerWidth: 1400, location: { href: 'https://offline.example.test/index.html' },
    localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout(callback,delay) { return delay===0?setTimeout(callback,0):null; }, clearTimeout(timer) { if(timer!==null)clearTimeout(timer); }, confirm: () => true, prompt:()=>controls.promptValue,
    IDBKeyRange: { only: value => value }, fetch() { throw Error('Network forbidden'); }
  });
  if(options.trackSet)context.Set=class extends Set{has(value){controls.setLookups++;return super.has(value)}};
  const api = vm.runInContext(`(function(){
    let automaticChineseEnabled=true,automaticChineseRun=0,translationBackgroundRun=0;
    const translationQueue={cancelQueued(){}};function launchAutomaticChinese(){automaticChineseEnabled=true}
    ${extracted}
    function canEditWorkspace(){return controls.writable}
    async function openWorkbenchDB(){if(controls.dbGate)await controls.dbGate;return db}
    function refreshTranslationReadiness(){} function scheduleTranslationStatus(){}
    function closeProductCard(){} function closeImageZoom(){} function queueVisibleTranslation(){}
    function translationSource(r,index){return value(r,H[index])} function deriveChineseField(){}
    function editTranslationSource(){} function toggleProductCard(){} function showImageZoom(){} function scheduleImageZoomClose(){}
    function runDeferredProcessing(){} async function parseXlsx(){throw Error('XLSX parser not under test')}
    function download(blob,name){controls.downloads.push({blob,name})}
    function showShareLinkDialog(){} function filterPopup(){} function drawer(){}
    return {H,FIELD,controls,filtered,recordsGroups,matchesState,statusValue,filterValue,value,calc,normalizeModelId,idFor,parseWorkbenchSearch,renderFilterSummary,activeFilterItems,bindWorkbenchSearchPaste,
      batch,drawOptions,bindTable,deriveRecord,regroup,merge,splitSelectedFromGroups,visibleFields,displayColumns,render,updateSelectionUI,
      updateStats,exportRows,exportCsv,exportXlsx,parseCsv,parseDelimited,mapImportedMatrix,selectImportHeader,importFile,importInvitations,importTranslations,
      writeRecordBatches,saveVersion,listVersions,refreshVersions,readVersion,showVersion,returnToCurrent,restoreVersionAsCurrent,openVersionManager,renameVersion,renameSelectedVersion,flushSave,save,
      get rows(){return rows},get historyMode(){return historyMode},get visibleRows(){return visibleRows},get selected(){return selected},
      setRows(next){rows=next;headers=H.slice();sourceFileName='fabricated.csv'},setFilters(next){filters=next},
      setSelected(ids){selected=new Set(ids)},setGrouping(value){groupingEnabled=value},setOpened(ids){opened=new Set(ids)},
      setFolds(c8,attrs){showC8=c8;showAttrs=attrs},setHistory(value){historyMode=value},setThreshold(value){threshold=value},setWorkspace(value){globalThis.workspace=value}
    };
  })()`, context, { filename: 'offline-workbench-functions.js' });
  return { api, element, controls, db };
}

function record(h, id, raw = {}) {
  return { uid: id, excelRow: 2, raw: { 'Model ID': id, ...raw }, group: 'shared-group', preValue: '', preDate: '', preNote: '' };
}
function ids(rows) { return Array.from(rows, r => r.uid); }
function csvFile(text, name = 'fabricated.csv') { const b = new Blob([text], { type: 'text/csv' }); b.name = name; return b; }
const EXPECTED_STATUS_KEYS = ['pool_type','is_top_1k','cspu_group_type_for_testing','grass_region','asp_tag_by_l1','source_type_new','sourcing_status_daily_refresh'];
async function readExportedXlsx(blob) {
  const workbook = XLSX.read(Buffer.from(await blob.arrayBuffer()), { type: 'buffer' });
  return { workbook, matrix: XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '', raw: true }) };
}
async function reimportExportedXlsx(h, blob) {
  const { matrix } = await readExportedXlsx(blob);
  return h.api.mapImportedMatrix(matrix, h.api.selectImportHeader(matrix, 3));
}
function groupedRecords(h, group, count, baseTarget = 100) {
  return Array.from({ length: count }, (_, index) => Object.assign(record(h, group + '-' + index, {
    backcal_cogs_non_brand: String(baseTarget + index), grass_region: index === 0 ? 'TH' : 'VN'
  }), { group, excelRow: index + 2 }));
}
function bindGroupCheckboxes(h, groups) {
  const nodes = groups.map(group => ({ dataset: { selectGroup: group }, checked: false, indeterminate: false, disabled: false }));
  h.controls.nodesBySelector['[data-select-group]'] = nodes;
  h.api.bindTable();h.api.updateSelectionUI();return nodes;
}

test('1688 blank filtering keeps only matching models and never leaks hidden group siblings', () => {
  const h = harness(), a = record(h,'blank',{final_1688_link:''}), b = record(h,'filled',{final_1688_link:'https://detail.1688.com/offer/fabricated.html'});
  h.api.setRows([a,b]); h.api.setFilters({[h.api.H[14]]:{values:['']}}); h.api.setOpened(['shared-group']);
  assert.deepEqual(ids(h.api.filtered()),['blank']);
  h.api.render(); assert.deepEqual(ids(h.api.visibleRows),['blank']);
  assert.doesNotMatch(h.element('table').innerHTML, /data-share="filled"/);
});

test('each model status field is independent, cross-field AND and within-field OR', () => {
  const h=harness(), a=record(h,'a',{pool_type:'pool-A',grass_region:'TH'}),b=record(h,'b',{pool_type:'pool-B',grass_region:'VN'}),c=record(h,'c',{pool_type:'pool-C',grass_region:'TH'});
  h.api.setRows([a,b,c]);h.api.setFilters({'status:pool_type':{values:['pool-A','pool-B']},'status:grass_region':{values:['TH']}});
  assert.deepEqual(ids(h.api.filtered()),['a']);
  assert.equal(h.api.statusValue(record(h,'zero',{is_top_1k:0}),'is_top_1k'),'0');
});

test('status parsing supports JSON, labelled values and legacy seven-line values',()=>{
  const h=harness();
  assert.equal(h.api.statusValue(record(h,'a',{[h.api.H[5]]:'{"grass_region":"TH"}'}),'grass_region'),'TH');
  assert.equal(h.api.statusValue(record(h,'b',{[h.api.H[5]]:'pool_type: A\ngrass_region: VN'}),'grass_region'),'VN');
  assert.equal(h.api.statusValue(record(h,'c',{[h.api.H[5]]:'A\nY\nC\nTH\nASP\nSRC\nS'}),'grass_region'),'TH');
});

test('contains plus value selection are AND and an empty selection matches no records',()=>{
  const h=harness();assert.equal(h.api.matchesState({values:['ABC'],query:'bc'},'ABC'),true);
  assert.equal(h.api.matchesState({values:['ABC'],query:'other'},'ABC'),false);
  assert.equal(h.api.matchesState({values:[]},''),false);
});

test('batch Model ID parsing accepts space, tab, newline and full-width whitespace separators',()=>{
  const h=harness();for(const separator of [' ','\t','\n','\r\n','\u3000',' \t\n\u3000 ']){
    const parsed=h.api.parseWorkbenchSearch(' 12345'+separator+'67890'+separator+'00123 ');
    assert.equal(parsed.mode,'ids');assert.deepEqual(Array.from(parsed.ids),['12345','67890','00123']);assert.equal(parsed.count,3);assert.equal(parsed.overflow,false);
    assert.equal(parsed.idSet.has('12345'),true);assert.equal(parsed.idSet.has('00123'),true);assert.equal(parsed.idSet.has('123'),false);
  }
});

test('batch Model ID parsing normalizes textual formatting without rounding long IDs or leading zeros',()=>{
  const h=harness(),long='900719925474099312345',parsed=h.api.parseWorkbenchSearch('12,345.0 000123 '+long+' 1e3');
  assert.equal(parsed.mode,'ids');assert.deepEqual(Array.from(parsed.ids),['12345','000123',long,'1000']);assert.ok(parsed.ids.every(id=>typeof id==='string'));
  h.api.setRows([record(h,'12,345.0'),record(h,'000123'),record(h,long),record(h,'1000'),record(h,'123')]);h.element('search').value='12345 000123 '+long+' 1e3';
  assert.deepEqual(ids(h.api.filtered()),['12,345.0','000123',long,'1000']);
  assert.equal(h.api.parseWorkbenchSearch('9.00719925474099312345e20 123').mode,'text','unsafe scientific notation is not rounded into a different numeric ID');
});

test('pasting a numeric ID column preserves separators and replaces only the selected search text',()=>{
  const h=harness(),input=h.element('search');let inputs=0;input.oninput=()=>inputs++;h.api.bindWorkbenchSearchPaste();
  for(const entry of [
    {before:'',start:0,end:0,paste:'12345\r\n67890\t000123',expected:'12345 67890 000123'},
    {before:'111 000 999',start:4,end:7,paste:'12345\r\n67890\t000123',expected:'111 12345 67890 000123 999'}
  ]){
    input.value=entry.before;input.selectionStart=entry.start;input.selectionEnd=entry.end;let prevented=false;
    input.onpaste({clipboardData:{getData(type){assert.equal(type,'text/plain');return entry.paste}},preventDefault(){prevented=true}});
    assert.equal(prevented,true);assert.equal(input.value,entry.expected);assert.deepEqual(Array.from(h.api.parseWorkbenchSearch(input.value).ids),entry.expected.split(' '));
  }
  assert.equal(inputs,2);input.value='ordinary search';let prevented=false;input.onpaste({clipboardData:{getData:()=> 'Wireless\nspeaker'},preventDefault(){prevented=true}});
  assert.equal(prevented,false);assert.equal(input.value,'ordinary search');assert.equal(inputs,2,'normal text paste remains native');
});

test('batch search uses exact ID OR matching without leaking ID substrings, title numbers or grouped siblings',()=>{
  const h=harness(),rows=[record(h,'12345'),record(h,'67890'),record(h,'123450'),record(h,'99999',{item_name:'12345 67890'}),record(h,'0012345')];
  h.api.setRows(rows);h.element('search').value='12345 67890';const found=h.api.filtered();assert.deepEqual(ids(found),['12345','67890']);
  h.api.renderFilterSummary(found,h.api.recordsGroups(found));assert.match(h.element('result').textContent,/2 个 Model ID/);assert.match(h.element('filterChips').innerHTML,/批量/);assert.doesNotMatch(h.element('filterChips').innerHTML,/全文搜索/);
});

test('ordinary multiword text, mixed text/numbers and a single numeric ID keep the original full-text behavior',()=>{
  const h=harness();h.api.setRows([record(h,'9123456',{item_name:'Wireless speaker'}),record(h,'77777',{item_name:'Wireless separate speaker'}),record(h,'88888',{item_name:'12345 speaker'})]);
  assert.equal(h.api.parseWorkbenchSearch('Wireless speaker').mode,'text');h.element('search').value='Wireless speaker';assert.deepEqual(ids(h.api.filtered()),['9123456']);
  assert.equal(h.api.parseWorkbenchSearch('12345 speaker').mode,'text');h.element('search').value='12345 speaker';assert.deepEqual(ids(h.api.filtered()),['88888']);
  assert.equal(h.api.parseWorkbenchSearch('12345').mode,'text');h.element('search').value='12345';assert.deepEqual(ids(h.api.filtered()),['9123456','88888']);
});

test('the unique-ID limit accepts 100 and duplicate-heavy input but fails closed for 101 without partial results',()=>{
  const h=harness(),values=Array.from({length:101},(_,index)=>String(10000+index));h.api.setRows(values.map(id=>record(h,id)));
  h.element('search').value=values.slice(0,100).join(' ');let parsed=h.api.parseWorkbenchSearch(h.element('search').value);assert.equal(parsed.count,100);assert.equal(parsed.overflow,false);assert.equal(h.api.filtered().length,100);
  h.api.renderFilterSummary(h.api.filtered(),h.api.recordsGroups(h.api.filtered()));assert.match(h.element('searchHint').textContent,/100\s*\/\s*100/);assert.equal(h.element('search').getAttribute('aria-invalid'),'false');
  h.element('search').value=values.slice(0,100).flatMap(id=>[id,id,id]).join(' ');parsed=h.api.parseWorkbenchSearch(h.element('search').value);assert.equal(parsed.count,100);assert.equal(parsed.overflow,false);assert.equal(h.api.filtered().length,100);
  h.element('search').value=values.join(' ');parsed=h.api.parseWorkbenchSearch(h.element('search').value);assert.equal(parsed.mode,'ids');assert.equal(parsed.count,101);assert.equal(parsed.overflow,true);assert.notEqual(parsed.ids.length,100,'overflow must not expose a silently truncated 100-ID query');
  assert.deepEqual(ids(h.api.filtered()),[]);h.api.renderFilterSummary([],[]);assert.match(h.element('filterChips').innerHTML,/100/);assert.match(h.element('filterChips').innerHTML,/超|最多|限制/);
  assert.equal(h.element('searchHint').hidden,false);assert.match(h.element('searchHint').textContent,/最多 100/);assert.match(h.element('searchHint').textContent,/101/);assert.equal(h.element('search').getAttribute('aria-invalid'),'true');
  h.api.render();assert.match(h.element('table').innerHTML,/批量检索最多 100/);assert.doesNotMatch(h.element('table').innerHTML,/data-share=/);
  h.element('clear').onclick();assert.equal(h.element('searchHint').hidden,true);assert.equal(h.element('searchHint').textContent,'');assert.equal(h.element('search').getAttribute('aria-invalid'),'false');
  h.element('search').value=Array(101).fill(values[0]).join(' ');parsed=h.api.parseWorkbenchSearch(h.element('search').value);assert.equal(parsed.mode,'ids');assert.equal(parsed.count,1);assert.equal(parsed.overflow,false);assert.deepEqual(ids(h.api.filtered()),[values[0]]);
});

test('batch IDs are ANDed with header/status filters and removing the search chip preserves those filters',()=>{
  const h=harness(),rows=[record(h,'12345',{[h.api.H[0]]:'是',grass_region:'TH'}),record(h,'67890',{[h.api.H[0]]:'否',grass_region:'TH'}),record(h,'22222',{[h.api.H[0]]:'是',grass_region:'VN'})];h.api.setRows(rows);h.element('search').value='12345 67890 22222';
  h.api.setFilters({[h.api.H[0]]:{values:['是']},'status:grass_region':{values:['TH']}});assert.deepEqual(ids(h.api.filtered()),['12345']);
  h.api.setFilters({[h.api.H[0]]:{values:['是']},'Model ID':{values:['67890']}});assert.deepEqual(ids(h.api.filtered()),[]);
  h.api.setFilters({[h.api.H[0]]:{values:['是']}});const remove={dataset:{removeFilter:'__search'}};h.controls.nodesBySelector['[data-remove-filter]']=[remove];const found=h.api.filtered();h.api.renderFilterSummary(found,h.api.recordsGroups(found));remove.onclick();
  assert.equal(h.element('search').value,'');assert.deepEqual(ids(h.api.filtered()),['12345','22222']);
  h.element('search').value='12345 67890';h.element('clear').onclick();assert.equal(h.api.parseWorkbenchSearch(h.element('search').value).mode,'text');assert.deepEqual(ids(h.api.filtered()),ids(rows));assert.equal(h.element('filterBadge').textContent,'未添加筛选条件');
});

test('20,000-row batch search uses bounded ID reads and Set membership without full-text scanning or table DOM',()=>{
  const h=harness({trackSet:true}),base=900719925474099312345n;let idReads=0,tableWrites=0;
  const rows=Array.from({length:20000},(_,index)=>{const id=String(base+BigInt(index)),r=record(h,id);Object.defineProperty(r.raw,'Model ID',{enumerable:true,get(){idReads++;return id}});Object.defineProperty(r.raw,'item_name',{enumerable:true,get(){assert.fail('numeric batch search must not scan product title text')}});return r});
  h.api.setRows(rows);const expected=Array.from({length:100},(_,index)=>String(base+BigInt(index*199)));h.element('search').value=expected.join(' ');
  const table=h.element('table');Object.defineProperty(table,'innerHTML',{get(){return ''},set(){tableWrites++}});h.controls.setLookups=0;
  assert.deepEqual(ids(h.api.filtered()),expected);assert.ok(idReads>=20000&&idReads<=200000,'bounded per-row ID work');assert.ok(h.controls.setLookups>=20000&&h.controls.setLookups<=21000,'one Set lookup per row rather than rescanning the request list');assert.equal(tableWrites,0);assert.equal(h.db.transactions.length,0);
});

test('price calculations update min targets/check with numeric zero and missing values',()=>{
  const h=harness(),r=record(h,'p',{backcal_cogs_non_brand:20,backcal_cogs_white_label:15,final_1688_price_moq_3:18});
  assert.equal(h.api.calc(r,'target'),'18.00');assert.equal(h.api.calc(r,'c8target'),'15.00');assert.equal(h.api.calc(r,'check'),'是');
  h.api.setRows([r]);const editor={dataset:{id:'p',edit:'raw',field:h.api.H[15]},tagName:'INPUT',type:'number',value:'0'};
  h.controls.editors=[editor];h.api.bindTable();editor.oninput();assert.equal(h.api.calc(r,'target'),'0.00');
});

test('clearing an imported 1688 price removes the old value from linked calculations',()=>{
  const h=harness(),r=record(h,'p',{backcal_cogs_non_brand:20,final_1688_price_moq_3:5});
  r.raw[h.api.H[15]]='';r.userEditedFields=[h.api.H[15]];
  assert.equal(h.api.calc(r,'target'),'20.00');assert.equal(h.api.calc(r,'check'),'');
});

test('zero is a supplied 1688 price, not a missing quotation in summary statistics',()=>{
  const h=harness(),r=record(h,'p',{final_1688_price_moq_3:0});h.api.setRows([r]);h.api.updateStats([r],h.api.recordsGroups([r]));
  assert.equal(Number(h.element('priceN').textContent),0);
});

test('bulk Y/N and date edit only selected model IDs',()=>{
  const h=harness(),a=record(h,'a'),b=record(h,'b');h.api.setRows([a,b]);h.api.setSelected(['a']);
  h.element('bulkPreValue').value='N';h.element('bulkPreDate').value='2026-11-17';h.element('bulkPreApply').onclick();
  assert.equal(a.preValue,'N');assert.equal(a.preDate,'2026-11-17');assert.equal(a.preTouched,true);assert.equal(b.preValue,'');
});

test('bulk custom buyer values remain available and blank inputs preserve existing values',()=>{
  const h=harness(),a=record(h,'a',{[h.api.H[1]]:'original reason'}),b=record(h,'b');h.api.setRows([a,b]);h.api.setSelected(['a']);
  h.controls.batch=[{dataset:{batch:h.api.H[0]},value:'自定义判断'},{dataset:{batch:h.api.H[1]},value:''}];
  h.api.batch();h.element('applyBatch').onclick();
  assert.equal(a.raw[h.api.H[0]],'自定义判断');assert.equal(a.raw[h.api.H[1]],'original reason');assert.equal(b.raw[h.api.H[0]],undefined);
  assert.ok(h.api.drawOptions(0).includes('自定义判断'));
});

test('bulk buyer style and quantity survive derive/reload processing',()=>{
  const h=harness(),r=record(h,'a',{item_name:'Black gadget 3pcs',[h.api.H[21]]:'黑色',[h.api.H[22]]:'3'});r.autoStyle=true;r.autoQty=true;
  h.api.setRows([r]);h.api.setSelected(['a']);h.controls.batch=[{dataset:{batch:h.api.H[21]},value:'买手自定义款式'},{dataset:{batch:h.api.H[22]},value:'7'}];
  h.api.batch();h.element('applyBatch').onclick();h.api.deriveRecord(r);
  assert.equal(r.raw[h.api.H[21]],'买手自定义款式');assert.equal(r.raw[h.api.H[22]],'7');
});

test('group merging, moving selected models out and collapsing preserve all source records',async()=>{
  const h=harness(),a=record(h,'a'),b=record(h,'b'),c=record(h,'c');h.api.setRows([a,b,c]);h.api.setSelected(['a','b']);h.api.merge(true);
  assert.equal(a.manualGroup,b.manualGroup);assert.equal(c.manualGroup,undefined);
  h.api.setSelected(['b']);h.api.splitSelectedFromGroups();assert.notEqual(a.manualGroup,b.manualGroup);
  h.api.setOpened([]);h.api.render();assert.equal(h.api.rows.length,3);assert.equal(h.api.visibleRows.length,3);
  h.api.setGrouping(false);await h.api.regroup();assert.equal(b.group,b.manualGroup);
});

test('closed product groups hide child rows and reopening reveals exactly their own models',()=>{
  const h=harness(),a=record(h,'a'),b=record(h,'b');h.api.setRows([a,b]);h.api.render();assert.equal(h.api.visibleRows.length,1);
  h.api.setOpened(['shared-group']);h.api.render();assert.deepEqual(ids(h.api.visibleRows),['a','b']);
  h.api.setOpened([]);h.api.render();assert.equal(h.api.visibleRows.length,1);
});

test('whole-group checkboxes select, partly select and clear the full group without disturbing other choices',()=>{
  const h=harness(),a=groupedRecords(h,'group-A',3),b=groupedRecords(h,'group-B',2);h.api.setRows([...a,...b]);h.api.render();
  const [group]=bindGroupCheckboxes(h,['group-A']);h.api.setSelected([b[0].uid]);h.api.updateSelectionUI();
  assert.equal(group.checked,false);assert.equal(group.indeterminate,false);
  group.checked=true;group.onchange();assert.deepEqual([...h.api.selected].sort(),[...ids(a),b[0].uid].sort());
  assert.equal(group.checked,true);assert.equal(group.indeterminate,false);
  const model={dataset:{select:a[1].uid},checked:false};h.controls.nodesBySelector['[data-select]']=[model];h.api.bindTable();model.onchange();
  assert.equal(group.checked,false);assert.equal(group.indeterminate,true);assert.equal(h.api.selected.has(a[1].uid),false);
  group.checked=true;group.onchange();assert.equal(group.checked,true);assert.equal(group.indeterminate,false);
  group.checked=false;group.onchange();assert.deepEqual([...h.api.selected],[b[0].uid]);
  assert.equal(group.checked,false);assert.equal(group.indeterminate,false);assert.equal(h.db.transactions.length,0);
});

test('whole-group selection includes collapsed, filtered and unrendered child batches with an explicit hidden count',()=>{
  const h=harness(),a=groupedRecords(h,'large-group',120),b=groupedRecords(h,'other-group',2);h.api.setRows([...a,...b]);
  h.api.setFilters({'Model ID':{values:[a[0].uid]}});h.api.render();assert.deepEqual(ids(h.api.visibleRows),[a[0].uid]);
  const markup=h.element('table').innerHTML;assert.match(markup,/整组选中/);assert.match(markup,/120/);assert.match(markup,/119/);
  const [group]=bindGroupCheckboxes(h,['large-group']);group.checked=true;group.onchange();
  assert.deepEqual([...h.api.selected].sort(),ids(a).sort());assert.equal(h.api.selected.has(b[0].uid),false);
  h.api.setFilters({});h.api.setOpened(['large-group']);h.api.render();assert.equal(h.api.visibleRows.length,52);assert.equal(group.checked,true);
  assert.equal((h.element('table').innerHTML.match(/data-select-group=/g)||[]).length,2,'group choices belong only to parent rows');
  const next={dataset:{childPage:'large-group',offset:'50'}};h.controls.nodesBySelector['[data-child-page]']=[next];h.api.bindTable();next.onclick();
  assert.equal(h.api.visibleRows.length,52);assert.deepEqual([...h.api.selected].sort(),ids(a).sort());
  h.api.setOpened([]);h.api.render();assert.equal(h.api.visibleRows.length,2);assert.equal(group.checked,true);
});

test('group choices survive group pagination and filter changes while the original page selector remains model-only',()=>{
  const h=harness(),groups=Array.from({length:55},(_,index)=>groupedRecords(h,'page-group-'+index,2,1000-index*10));h.api.setRows(groups.flat());h.api.render();
  assert.equal(h.api.visibleRows.length,50);const [first]=bindGroupCheckboxes(h,['page-group-0']);first.checked=true;first.onchange();
  assert.deepEqual([...h.api.selected].sort(),ids(groups[0]).sort());
  h.element('pageNext').onclick();assert.equal(h.api.visibleRows.length,5);
  const [last]=bindGroupCheckboxes(h,['page-group-50']);last.checked=true;last.onchange();
  const chosen=[...ids(groups[0]),...ids(groups[50])].sort();assert.deepEqual([...h.api.selected].sort(),chosen);
  h.api.setFilters({'status:grass_region':{values:['TH']}});h.api.render();assert.deepEqual([...h.api.selected].sort(),chosen);
  h.element('clear').onclick();assert.deepEqual([...h.api.selected].sort(),chosen);
  h.element('unselect').onclick();assert.equal(h.api.selected.size,0);
  const all=h.element('selectVisible');all.checked=true;all.onchange();
  assert.equal(h.api.selected.size,50);assert.deepEqual([...h.api.selected].sort(),ids(h.api.visibleRows).sort());
});

test('three whole-group choices merge every hidden member and persist the highest-target representative',async()=>{
  const h=harness(),a=groupedRecords(h,'merge-A',3,100),b=groupedRecords(h,'merge-B',75,200),c=groupedRecords(h,'merge-C',4,300),all=[...a,...b,...c];
  h.api.setRows(all.slice().reverse());h.element('sort').value='asc';h.api.render();
  assert.deepEqual(Array.from(h.api.recordsGroups(h.api.rows),entry=>entry[1][0].uid),[a[2].uid,b[74].uid,c[3].uid]);
  h.api.setFilters({'status:grass_region':{values:['TH']}});h.api.render();assert.equal(h.api.visibleRows.length,3);
  for(const group of bindGroupCheckboxes(h,['merge-A','merge-B','merge-C'])){group.checked=true;group.onchange()}
  assert.equal(h.api.selected.size,82);h.element('merge').onclick();assert.equal(h.api.selected.size,0);
  assert.equal(new Set(all.map(row=>row.manualGroup)).size,1);assert.ok(all[0].manualGroup);assert.equal(h.api.rows.length,82);
  h.api.setFilters({});h.api.setOpened([]);h.api.render();assert.deepEqual(ids(h.api.visibleRows),[c[3].uid]);
  assert.equal(await h.api.flushSave(),true);assert.equal(h.db.stores.records.size,82);
  const saved=[...h.db.stores.records.values()];assert.deepEqual(saved.map(row=>row.uid).sort(),ids(all).sort());
  assert.ok(saved.every(row=>row.manualGroup===all[0].manualGroup&&row.group===all[0].manualGroup));
  const restored=harness({db:h.db});restored.api.setRows(saved);await restored.api.regroup();restored.api.render();
  assert.deepEqual(ids(restored.api.visibleRows),[c[3].uid]);assert.equal(restored.api.recordsGroups(restored.api.rows)[0][1].length,82);
});

test('manual group membership controls whole-group cancellation and moving members out',()=>{
  const h=harness(),a=groupedRecords(h,'automatic-group',3),b=groupedRecords(h,'other-automatic-group',2),c=record(h,'untouched');
  a.forEach(row=>row.manualGroup='manual-A');b.forEach(row=>{row.group='automatic-group';row.manualGroup='manual-B'});c.group='automatic-group';
  h.api.setRows([...a,...b,c]);h.api.render();let [group]=bindGroupCheckboxes(h,['manual-A']);group.checked=true;group.onchange();
  assert.deepEqual([...h.api.selected].sort(),ids(a).sort());h.element('unselect').onclick();assert.equal(h.api.selected.size,0);
  assert.ok(a.every(row=>row.manualGroup==='manual-A'));assert.ok(b.every(row=>row.manualGroup==='manual-B'));assert.equal(c.manualGroup,undefined);
  [group]=bindGroupCheckboxes(h,['manual-A']);group.checked=true;group.onchange();h.element('splitGroup').onclick();
  assert.equal(h.api.selected.size,0);assert.equal(new Set(a.map(row=>row.manualGroup)).size,3);
  assert.ok(a.every(row=>row.manualGroup==='单独-'+row.uid));assert.ok(b.every(row=>row.manualGroup==='manual-B'));assert.equal(c.group,'automatic-group');
  h.api.setSelected([a[0].uid]);h.element('unmerge').onclick();assert.equal(a[0].manualGroup,'');assert.equal(a[0].group,'UNGROUPED-'+a[0].uid);
  assert.equal(a[1].manualGroup,'单独-'+a[1].uid);assert.ok(b.every(row=>row.manualGroup==='manual-B'));
});

test('history and ownership loss disable whole-group editing and reject previously attached handlers',()=>{
  for(const reason of ['history','ownership']){
    const h=harness(),a=groupedRecords(h,'readonly-group',3);h.api.setRows(a);h.api.render();const [group]=bindGroupCheckboxes(h,['readonly-group']);
    h.api.setSelected([a[0].uid]);if(reason==='history')h.api.setHistory(true);else h.controls.writable=false;
    h.api.render();const input=h.element('table').innerHTML.match(/<input\b[^>]*data-select-group="readonly-group"[^>]*>/)?.[0];assert.ok(input);assert.match(input,/\bdisabled\b/);
    group.checked=true;group.onchange();assert.deepEqual([...h.api.selected],[a[0].uid]);
    h.element('merge').onclick();h.element('splitGroup').onclick();h.element('unmerge').onclick();
    assert.ok(a.every(row=>row.group==='readonly-group'&&!row.manualGroup));assert.equal(h.db.transactions.length,0);
  }
});

test('history read-only mode still permits expanding a product group',()=>{
  const h=harness();h.api.setRows([record(h,'a'),record(h,'b')]);h.api.setHistory(true);h.api.render();
  const button=h.element('table').innerHTML.match(/<button class="group-toggle"[^>]*>/)?.[0];assert.ok(button);assert.doesNotMatch(button,/\bdisabled\b/);
});

test('history raw editors ignore both input and change events',async()=>{
  const h=harness(),r=record(h,'a',{[h.api.H[24]]:'original'});h.api.setRows([r]);h.api.setHistory(true);
  const editor={dataset:{id:'a',edit:'raw',field:h.api.H[24]},tagName:'TEXTAREA',type:'textarea',value:'attempted edit'};
  h.controls.editors=[editor];h.api.bindTable();editor.oninput();await editor.onchange();assert.equal(r.raw[h.api.H[24]],'original');
});

test('C8 and attribute column folds operate independently',()=>{
  const h=harness();h.api.setFolds(false,false);assert.equal(h.api.visibleFields().length,21);
  h.api.setFolds(true,false);assert.equal(h.api.visibleFields().length,23);
  h.api.setFolds(false,true);assert.equal(h.api.visibleFields().length,24);
  h.api.setFolds(true,true);assert.equal(h.api.visibleFields().length,26);
});

test('save/load current state and historical snapshots do not share mutable record objects',async()=>{
  const h=harness(),r=record(h,'a',{item_name:'Fabricated item'});h.api.setRows([r]);await h.api.saveVersion();
  const [version]=await h.api.listVersions();r.raw.item_name='changed current';
  const snap=await h.api.readVersion(version.id);assert.equal(snap.rows[0].raw.item_name,'Fabricated item');
  assert.equal(h.db.stores.records.get('a').raw.item_name,'Fabricated item');
});

test('deleting V2 between V1/V3 then saving uses V4 without overwriting V3',async()=>{
  const h=harness(),r=record(h,'a');h.api.setRows([r]);
  for(let i=1;i<=3;i++){r.raw.revision='revision-'+i;await h.api.saveVersion();}
  const versions=await h.api.listVersions(),v2=versions.find(v=>v.id.endsWith('-V2')),v3=versions.find(v=>v.id.endsWith('-V3'));
  await h.api.renameVersion(v3.id,'买手复核 V900 自定义名称');
  h.controls.checks=versions.map(v=>({dataset:{versionDelete:v.id},checked:v.id===v2.id}));
  await h.api.openVersionManager();await h.element('deleteSelectedVersions').onclick();
  assert.equal(h.db.stores.versions.has(v2.id),false);assert.equal([...h.db.stores.versionRecords.values()].some(r=>r.versionId===v2.id),false);
  r.raw.revision='revision-4';await h.api.saveVersion();
  assert.equal((await h.api.readVersion(v3.id)).rows[0].raw.revision,'revision-3');
  assert.equal((await h.api.readVersion(v3.id)).meta.label,'买手复核 V900 自定义名称');
  assert.ok((await h.api.listVersions()).some(v=>v.id.endsWith('-V4')));
});

test('history inspection is read-only and returning/restoring uses the intended dataset',async()=>{
  const h=harness(),r=record(h,'a',{item_name:'snapshot'});h.api.setRows([r]);await h.api.saveVersion();const [v]=await h.api.listVersions();
  r.raw.item_name='current';await h.api.showVersion(v.id);assert.equal(h.api.historyMode,true);assert.equal(h.api.rows[0].raw.item_name,'snapshot');
  h.api.returnToCurrent();assert.equal(h.api.historyMode,false);assert.equal(h.api.rows[0].raw.item_name,'current');
  await h.api.restoreVersionAsCurrent(v.id);assert.equal(h.api.rows[0].raw.item_name,'snapshot');await h.api.flushSave();assert.equal(h.db.stores.records.get('a').raw.item_name,'snapshot');
});

test('CSV export quotes commas, quotes and line breaks and reimports long Model IDs exactly',async()=>{
  const h=harness(),id='12345678901234567890',itemId='00987654321098765432109876543210',note='第一行,"引号"\n第二行',r=record(h,id,{item_id:itemId,[h.api.H[24]]:note});
  const out=h.api.exportCsv([r]);assert.equal((await out.arrayBuffer()).byteLength>0,true);
  const parsed=await h.api.parseCsv(out);assert.equal(h.api.idFor(parsed.rows[0]),id);assert.equal(parsed.rows[0].raw.item_id,itemId);assert.equal(h.api.value(parsed.rows[0],h.api.H[24]),note);
  assert.equal((await out.text()).includes(itemId),true);assert.equal((await out.text()).includes('9,876,543'),false);
});

test('export schema places exact item_id after Model ID and replaces only the aggregate status column',()=>{
  const h=harness(),longItemId='00123456789012345678901234567890';
  const a=record(h,'1001',{shop_item_id:'WRONG-SHOP-ID',item_id:longItemId}),b=record(h,'1002',{shop_item_id:'MUST-STAY-EMPTY'}),c=record(h,'1003',{'ITEM ID':'009876543210987654321'});
  const {headers,data}=h.api.exportRows([a,b,c]);
  assert.equal(headers.length,34);assert.deepEqual(Array.from(headers.slice(0,2)),['Model ID','item_id']);
  assert.deepEqual(Array.from(headers.slice(7,14)),EXPECTED_STATUS_KEYS);
  assert.equal(headers.includes('model状态'),false);assert.equal(headers.includes(h.api.H[5]),false);
  assert.deepEqual(Array.from(data,row=>row[1]),[longItemId,'','009876543210987654321']);
  assert.ok(data.every(row=>row.length===34));assert.equal(typeof data[0][1],'string');
  const board=h.api.displayColumns();assert.equal(board.filter(column=>column.h===h.api.H[5]).length,1);
  assert.equal(board.some(column=>column.h==='item_id'||EXPECTED_STATUS_KEYS.includes(column.h)),false);
});

for(const encoding of ['independent fields','independent fields overriding aggregate','JSON aggregate','labelled aggregate','seven-line aggregate'])test('CSV and XLSX roundtrip seven separate statuses with empty positions: '+encoding,async()=>{
  const h=harness(),expected=[encoding==='labelled aggregate'?'候选池':'候选,池','','C','TH','','SRC',''],values=Object.fromEntries(EXPECTED_STATUS_KEYS.map((key,index)=>[key,expected[index]]));
  const aggregate=encoding==='JSON aggregate'?JSON.stringify(values):encoding==='labelled aggregate'?EXPECTED_STATUS_KEYS.map((key,index)=>key+': '+expected[index]).join('\n'):expected.join('\n');
  const raw=encoding==='independent fields'?values:encoding==='independent fields overriding aggregate'?{...values,[h.api.H[5]]:JSON.stringify(Object.fromEntries(EXPECTED_STATUS_KEYS.map(key=>[key,'STALE-AGGREGATE-VALUE'])))}:{[h.api.H[5]]:aggregate};
  const r=record(h,'12345678901234567890',raw);
  const exported=h.api.exportRows([r]);assert.deepEqual(Array.from(exported.data[0].slice(7,14)),expected);
  const csv=h.api.exportCsv([r]),xlsx=h.api.exportXlsx([r]),{matrix}=await readExportedXlsx(xlsx);
  assert.deepEqual(matrix[0],Array.from(exported.headers));assert.deepEqual(matrix[1].slice(7,14),expected);
  for(const parsed of [await h.api.parseCsv(csv),await reimportExportedXlsx(h,xlsx)]){
    assert.equal(parsed.rows.length,1);assert.equal(h.api.idFor(parsed.rows[0]),'12345678901234567890');
    assert.equal(Object.hasOwn(parsed.rows[0].raw,'model状态'),false);
    assert.deepEqual(EXPECTED_STATUS_KEYS.map(key=>h.api.statusValue(parsed.rows[0],key)),expected);
    assert.deepEqual(EXPECTED_STATUS_KEYS.map(key=>parsed.rows[0].raw[key]),expected);
  }
});

test('legacy fully populated seven-line statuses retain all seven positions during export',()=>{
  const h=harness(),expected=['A','Y','C','VN','ASP','SRC','S'];
  const out=h.api.exportRows([record(h,'legacy',{[h.api.H[5]]:expected.join('\n')})]);
  assert.deepEqual(Array.from(out.data[0].slice(7,14)),expected);
});

test('filtered exportRows and both file formats exclude other models in the same source group',async()=>{
  const h=harness(),visible=record(h,'1001',{item_id:'0012345678901234567890',grass_region:''}),hidden=record(h,'1002',{item_id:'HIDDEN-ITEM-ID',grass_region:'VN',[h.api.H[24]]:'HIDDEN-BUYER-NOTE'});
  h.api.setRows([visible,hidden]);h.api.setFilters({'status:grass_region':{values:['']}});h.api.setOpened(['shared-group']);
  const list=h.api.filtered();assert.deepEqual(ids(list),['1001']);
  assert.deepEqual(Array.from(h.api.exportRows(list).data,row=>row[0]),['1001']);
  const csv=h.api.exportCsv(list),xlsx=h.api.exportXlsx(list);
  assert.doesNotMatch(await csv.text(),/HIDDEN-/);
  for(const parsed of [await h.api.parseCsv(csv),await reimportExportedXlsx(h,xlsx)])assert.deepEqual(Array.from(parsed.rows,row=>h.api.idFor(row)),['1001']);
});

test('new export columns preserve buyer notes, Y/N-date, manual Chinese and invitation IDs in both formats',async()=>{
  const h=harness(),note='买手备注,"保留"\n下一行',r=Object.assign(record(h,'12345',{item_id:'98765432109876543210',[h.api.H[10]]:'买手人工商品中文',[h.api.H[12]]:'买手人工型号中文',[h.api.H[24]]:note,[h.api.H[25]]:'INV-FABRICATED'}),{preValue:'N',preDate:'2026-11-17',preNote:'核价备注 | 保留分隔符'});
  for(const parsed of [await h.api.parseCsv(h.api.exportCsv([r])),await reimportExportedXlsx(h,h.api.exportXlsx([r]))]){
    const actual=parsed.rows[0];assert.equal(actual.raw.item_id,'98765432109876543210');
    for(const field of [10,12,24,25])assert.equal(h.api.value(actual,h.api.H[field]),h.api.value(r,h.api.H[field]));
    for(const field of ['preValue','preDate','preNote'])assert.equal(actual[field],r[field]);
  }
});

for(const pre of [
  {preValue:'',preDate:'2026-11-17',preNote:'date without YN'},
  {preValue:'Y',preDate:'',preNote:'note without date'},
  {preValue:'',preDate:'',preNote:'note | containing delimiter'},
  {preValue:'N',preDate:'2026-11-17',preNote:'complete'}
])test('export/import preserves Y/N-date-note positions: '+JSON.stringify(pre),async()=>{
  const h=harness(),r=Object.assign(record(h,'a'),pre),parsed=await h.api.parseCsv(h.api.exportCsv([r]));
  for(const key of ['preValue','preDate','preNote'])assert.equal(parsed.rows[0][key],pre[key],key);
});

test('XLSX export is an actual ZIP workbook with text IDs and escaped safe XML',async()=>{
  const h=harness(),itemId='00123456789012345678901234567890',r=record(h,'12345678901234567890',{item_id:itemId,[h.api.H[24]]:'A&B <tag>\u0001'}),blob=h.api.exportXlsx([r]),buf=Buffer.from(await blob.arrayBuffer());
  assert.equal(buf.readUInt32LE(0),0x04034b50);assert.equal(buf.readUInt32LE(buf.length-22),0x06054b50);
  const files=new Map();let at=0;while(buf.readUInt32LE(at)===0x04034b50){const size=buf.readUInt32LE(at+18),nameLength=buf.readUInt16LE(at+26),extraLength=buf.readUInt16LE(at+28),start=at+30+nameLength+extraLength;files.set(buf.toString('utf8',at+30,at+30+nameLength),buf.toString('utf8',start,start+size));at=start+size;}
  const xml=files.get('xl/worksheets/sheet1.xml');assert.ok(xml);assert.match(xml,/t="inlineStr"/);assert.match(xml,/12345678901234567890/);assert.match(xml,/A&amp;B &lt;tag&gt;/);assert.doesNotMatch(xml,/\u0001/);
  const {workbook,matrix}=await readExportedXlsx(blob),sheet=workbook.Sheets[workbook.SheetNames[0]];
  assert.deepEqual(matrix[0].slice(0,2),['Model ID','item_id']);assert.deepEqual(matrix[0].slice(7,14),EXPECTED_STATUS_KEYS);
  assert.equal(sheet.A2.t,'s');assert.equal(sheet.B2.t,'s');assert.equal(sheet.B2.v,itemId);assert.equal(sheet.B2.w,itemId);
  assert.equal(matrix[0].includes('model状态'),false);assert.equal(matrix[0].length,34);
});

test('invitation CSV imports match normalized Model IDs and preserve unmatched models',async()=>{
  const h=harness(),a=record(h,'12345'),b=record(h,'67890');h.api.setRows([a,b]);
  await h.api.importInvitations(csvFile('Model ID,邀请ID\r\n"12,345.0",INV-FABRICATED\r\n99999,INV-OTHER'));
  assert.equal(h.api.value(a,h.api.H[25]),'INV-FABRICATED');assert.equal(h.api.value(b,h.api.H[25]),'');
});

test('the documented two-column Chinese translation CSV imports with the real parser',async()=>{
  const h=harness(),r=record(h,'12345',{item_name:'Fabricated item'});h.api.setRows([r]);
  await h.api.importTranslations(csvFile('Model ID,item name 中文\r\n12345,买手提供测试译文'));
  assert.equal(h.api.value(r,h.api.H[10]),'买手提供测试译文');assert.equal(r.autoItemChinese,false);
});

test('CSV export button includes every filtered model across pages without leaking grouped siblings',async()=>{
  const h=harness(),rows=Array.from({length:201},(_,i)=>record(h,String(i),{[h.api.H[0]]:i===200?'否':'是'}));
  rows.forEach((r,i)=>r.group='group-'+Math.floor(i/2));h.api.setRows(rows);h.api.setFilters({[h.api.H[0]]:{values:['是']}});h.api.render();
  assert.equal(h.api.visibleRows.length,50);h.element('exportCsv').onclick();assert.equal(h.controls.downloads.length,1);
  const parsed=await h.api.parseCsv(h.controls.downloads[0].blob);assert.equal(parsed.rows.length,200);assert.ok(parsed.rows.every(r=>h.api.value(r,h.api.H[0])==='是'));
});

test('1000-record writer advances only after the last success of each 200-record batch',()=>{
  const h=harness(),records=Array.from({length:1000},(_,i)=>({uid:'fabricated-'+i,position:i})),requests=[],written=[],progress=[];
  const tx={abort(){assert.fail('the valid batch transaction must not abort')}},store={put(value){written.push(value);const req={onsuccess:null};requests.push(req);return req}};
  h.api.writeRecordBatches(tx,store,records,r=>({uid:r.uid,projected:r.position+1}),(done,total)=>progress.push([done,total]));
  assert.equal(written.length,200);assert.equal(requests[0].onsuccess,null);
  for(let boundary=200;boundary<1000;boundary+=200){assert.equal(typeof requests[boundary-1].onsuccess,'function');requests[boundary-1].onsuccess();assert.equal(written.length,boundary+200)}
  assert.deepEqual(written,records.map(r=>({uid:r.uid,projected:r.position+1})));
  assert.deepEqual(progress,[[200,1000],[400,1000],[600,1000],[800,1000],[1000,1000]]);
});

test('1000 fabricated records finish in both the current and historical stores',async()=>{
  const h=harness(),records=Array.from({length:1000},(_,i)=>record(h,'fabricated-'+i,{item_name:'Fabricated '+i}));h.api.setRows(records);
  await h.api.saveVersion();const [version]=await h.api.listVersions();
  assert.equal(h.db.stores.records.size,1000);assert.equal(h.db.stores.versionRecords.size,1000);
  assert.deepEqual(ids((await h.api.readVersion(version.id)).rows),ids(records));
  assert.equal(h.db.stores.records.get('fabricated-999').raw.item_name,'Fabricated 999');
});

test('controls opened before losing write ownership cannot edit raw or bulk data',async()=>{
  const h=harness(),r=record(h,'a',{[h.api.H[0]]:'original',[h.api.H[24]]:'original note'});h.api.setRows([r]);h.api.setSelected(['a']);
  h.controls.batch=[{dataset:{batch:h.api.H[0]},value:'attempted bulk'}];h.api.batch();const apply=h.element('applyBatch').onclick;
  const editor={dataset:{id:'a',edit:'raw',field:h.api.H[24]},tagName:'TEXTAREA',type:'textarea',value:'attempted input'};
  h.controls.editors=[editor];h.api.bindTable();const before=plain(h.api.rows);h.controls.writable=false;
  editor.oninput();await editor.onchange();apply();h.element('bulkPreValue').value='Y';h.element('bulkPreDate').value='2026-11-17';h.element('bulkPreApply').onclick();
  assert.deepEqual(plain(h.api.rows),before);assert.equal(h.db.transactions.filter(t=>t.mode==='readwrite').length,0);
});

test('a read-only workspace rejects all three imports and saves without starting a write transaction',async()=>{
  const h=harness(),r=record(h,'12345',{item_name:'Original fabricated item'});h.api.setRows([r]);const before=plain(h.api.rows);h.controls.writable=false;
  await h.api.importFile(csvFile('Model ID,item_name,final_1688_link\r\nother,Attempted replacement,https://example.test/fake'));
  await h.api.importInvitations(csvFile('Model ID,邀请ID\r\n12345,ATTEMPTED-INVITATION'));
  await h.api.importTranslations(csvFile('Model ID,item name 中文\r\n12345,试图写入的译文'));
  h.api.save(true);assert.equal(await h.api.flushSave(),false);await h.api.saveVersion();
  assert.deepEqual(plain(h.api.rows),before);assert.equal(h.db.transactions.filter(t=>t.mode==='readwrite').length,0);
  assert.equal(h.db.stores.records.size,0);assert.equal(h.db.stores.versions.size,0);
});

test('the actual workspace guard refuses writes before initialization and after ownership release',()=>{
  const api=vm.runInNewContext(`(function(){${line('let workspaceWriter=')};${line('function canEditWorkspace(')};return {allowed:canEditWorkspace,set(ready,writer){workspaceWritable=ready;workspaceWriter=writer}}})()`);
  assert.equal(api.allowed(),false);api.set(true,{owner:false});assert.equal(api.allowed(),false);
  api.set(false,{owner:true});assert.equal(api.allowed(),false);api.set(true,{owner:true});assert.equal(api.allowed(),true);
  api.set(true,{owner:false});assert.equal(api.allowed(),false);
});

test('previously opened history delete and restore controls reject a later loss of write ownership',async()=>{
  const h=harness(),r=record(h,'a',{item_name:'Snapshot fabricated item'});h.api.setRows([r]);await h.api.saveVersion();const [version]=await h.api.listVersions();
  h.controls.checks=[{dataset:{versionDelete:version.id},checked:true}];await h.api.openVersionManager();const remove=h.element('deleteSelectedVersions').onclick;
  r.raw.item_name='Unsaved current fabricated item';const before=plain(h.api.rows),writes=h.db.transactions.filter(t=>t.mode==='readwrite').length;h.controls.writable=false;
  await remove();await h.api.restoreVersionAsCurrent(version.id);
  assert.equal(h.db.stores.versions.has(version.id),true);assert.deepEqual(plain(h.api.rows),before);
  assert.equal(h.db.transactions.filter(t=>t.mode==='readwrite').length,writes);
});

test('concurrent history-save clicks produce one version and release the save control',async()=>{
  const h=harness();h.api.setRows([record(h,'a')]);const first=h.api.saveVersion();assert.equal(h.element('saveVersion').disabled,true);
  await Promise.all([first,h.api.saveVersion()]);assert.equal((await h.api.listVersions()).length,1);assert.equal(h.element('saveVersion').disabled,false);
  await h.api.saveVersion();assert.equal((await h.api.listVersions()).length,2);
});

test('history snapshots freeze raw fields, buyer metadata and notes before awaiting persistence',async()=>{
  const h=harness(),r=record(h,'a',{[h.api.H[24]]:'At click'});r.userEditedFields=[h.api.H[24]];r.preNote='At click';h.api.setRows([r]);
  const saving=h.api.saveVersion();r.raw[h.api.H[24]]='Edited while saving';r.userEditedFields.push(h.api.H[21]);r.preNote='Edited while saving';await saving;
  const [v]=await h.api.listVersions(),snap=(await h.api.readVersion(v.id)).rows[0];
  assert.equal(snap.raw[h.api.H[24]],'At click');assert.deepEqual(plain(snap.userEditedFields),[h.api.H[24]]);assert.equal(snap.preNote,'At click');
});

test('replacing the current dataset during a history save cannot replace its captured snapshot',async()=>{
  const h=harness(),original=record(h,'original',{item_name:'Original fabricated item'});h.api.setRows([original]);
  const saving=h.api.saveVersion();await h.api.importFile(csvFile('Model ID,item_name,final_1688_link\r\nreplacement,Replacement fabricated item,','replacement-fabricated.csv'));await saving;
  const [v]=await h.api.listVersions(),snap=await h.api.readVersion(v.id);
  assert.deepEqual(ids(h.api.rows),['csv2']);assert.equal(h.api.idFor(h.api.rows[0]),'replacement');
  assert.deepEqual(ids(snap.rows),['original']);assert.equal(snap.meta.sourceFileName,'fabricated.csv');assert.equal(snap.meta.rowCount,1);
});

test('an import with valid headers but no products preserves existing current records',async()=>{
  const h=harness();h.api.setRows([record(h,'keep-existing')]);h.api.save(true);await h.api.flushSave();
  await h.api.importFile(csvFile('Model ID,item_name,final_1688_link\r\n'));await h.api.flushSave();
  assert.deepEqual(ids(h.api.rows),['keep-existing']);assert.equal(h.db.stores.records.has('keep-existing'),true);
});

test('editing prequotation Y/N invalidates the cached full-text search',()=>{
  const h=harness(),r=record(h,'777');r.preValue='N';h.api.setRows([r]);h.element('search').value='N';assert.deepEqual(ids(h.api.filtered()),['777']);
  h.api.setSelected(['777']);h.element('bulkPreValue').value='Y';h.element('bulkPreApply').onclick();assert.deepEqual(ids(h.api.filtered()),[]);
});

for(const kind of ['translation','invitation'])for(const change of ['history','replacement','ownership'])test('an in-flight '+kind+' import stops after '+change+' changes during parsing',async()=>{
  const h=harness(),live=record(h,'same'),historical=record(h,'same',{[h.api.H[10]]:'Historical Chinese',[h.api.H[25]]:'Historical invitation'});h.api.setRows([live]);
  const before=plain(historical),pending=kind==='translation'
    ?h.api.importTranslations(csvFile('Model ID,item name 中文\r\nsame,试图异步改写历史'))
    :h.api.importInvitations(csvFile('Model ID,邀请ID\r\nsame,ATTEMPTED-HISTORY-CHANGE'));
  if(change==='ownership')h.controls.writable=false;else h.api.setRows([historical]);if(change==='history')h.api.setHistory(true);await pending;
  assert.deepEqual(plain(historical),before);assert.equal(h.db.transactions.filter(t=>t.mode==='readwrite').length,0);
  assert.deepEqual(plain(live),plain(record(h,'same')));
});

for(const kind of ['translation','invitation'])test('a '+kind+' import rechecks its dataset after yielding during matching',async()=>{
  const h=harness(),original=Array.from({length:1505},(_,i)=>record(h,String(i))),historical=Array.from({length:1505},(_,i)=>record(h,String(i),{[h.api.H[10]]:'Historical Chinese',[h.api.H[25]]:'Historical invitation'}));h.api.setRows(original);
  let status='',switched=false;Object.defineProperty(h.element('translationState'),'textContent',{get(){return status},set(value){status=value;if(!switched&&String(value).includes(' 1000 / ')){switched=true;h.api.setRows(historical);h.api.setHistory(true)}}});
  const header=kind==='translation'?'Model ID,item name 中文':'Model ID,邀请ID',csv=[header,...original.map(r=>r.uid+','+(kind==='translation'?'导入虚构译文':'FABRICATED-INVITATION'))].join('\r\n');
  if(kind==='translation')await h.api.importTranslations(csvFile(csv));else await h.api.importInvitations(csvFile(csv));
  assert.equal(switched,true);assert.ok(historical.every(r=>r.raw[h.api.H[10]]==='Historical Chinese'&&r.raw[h.api.H[25]]==='Historical invitation'));
  assert.equal(original[1504].raw[h.api.H[kind==='translation'?10:25]],undefined);assert.equal(h.db.transactions.filter(t=>t.mode==='readwrite').length,0);
});

test('renaming a history version changes only its label and survives refresh and historical inspection',async()=>{
  const h=harness(),r=record(h,'rename-snapshot',{item_name:'Immutable snapshot item'});h.api.setRows([r]);await h.api.saveVersion();
  const [before]=await h.api.listVersions(),snapshots=plain([...h.db.stores.versionRecords.entries()]);
  const renamed=await h.api.renameVersion(before.id,'  买手复核通过 · 十一月  ');
  assert.equal(renamed.label,'买手复核通过 · 十一月');assert.deepEqual({...plain(renamed),label:before.label},plain(before));
  assert.deepEqual(plain([...h.db.stores.versionRecords.entries()]),snapshots);assert.equal(h.db.stores.versions.size,1);assert.equal(h.element('versionSelect').value,before.id);
  assert.match(h.element('versionSelect').innerHTML,/买手复核通过 · 十一月/);
  const reopened=harness({db:h.db});await reopened.api.refreshVersions(before.id);assert.match(reopened.element('versionSelect').innerHTML,/买手复核通过 · 十一月/);
  await reopened.api.showVersion(before.id);assert.equal(reopened.api.rows[0].raw.item_name,'Immutable snapshot item');assert.equal(reopened.element('groupState').textContent,'历史只读 · 买手复核通过 · 十一月');
});

test('history names trim whitespace, support Chinese and Unicode, enforce the limit and escape dropdown markup',async()=>{
  const h=harness();h.api.setRows([record(h,'rename-validation')]);await h.api.saveVersion();const [version]=await h.api.listVersions(),original=plain(version);
  for(const invalid of ['', ' \t\n ', '中'.repeat(101)])await assert.rejects(h.api.renameVersion(version.id,invalid),/不能为空|最多 100/);
  await assert.rejects(h.api.renameVersion('missing-version','合法名称'),/不存在|已删除/);assert.deepEqual(plain(h.db.stores.versions.get(version.id)),original);
  await h.api.renameVersion(version.id,'中'.repeat(100));assert.equal((await h.api.listVersions())[0].label.length,100);
  await h.api.renameVersion(version.id,'😀'.repeat(100));assert.equal(Array.from((await h.api.listVersions())[0].label).length,100);
  await h.api.renameVersion(version.id,'  复核 <买手> & 中文名称  ');assert.equal((await h.api.listVersions())[0].label,'复核 <买手> & 中文名称');
  assert.match(h.element('versionSelect').innerHTML,/复核 &lt;买手&gt; &amp; 中文名称/);assert.doesNotMatch(h.element('versionSelect').innerHTML,/<买手>/);
});

test('a history rename cancels while awaiting storage when data, history, ownership or workspace changes',async()=>{
  for(const change of ['dataset','history','ownership','workspace']){
    const h=harness();h.api.setRows([record(h,'rename-context')]);await h.api.saveVersion();const [version]=await h.api.listVersions();
    let resume;h.controls.dbGate=new Promise(resolve=>{resume=resolve});const pending=h.api.renameVersion(version.id,'不能写入的新名称');
    if(change==='dataset')h.api.setRows([record(h,'replacement')]);else if(change==='history')h.api.setHistory(true);else if(change==='ownership')h.controls.writable=false;else h.api.setWorkspace({id:'replacement-workspace'});
    resume();await assert.rejects(pending,/已切换/);assert.equal(h.db.stores.versions.get(version.id).label,version.label);
  }
});

test('a history rename rechecks ownership when its metadata read completes',async()=>{
  const h=harness();h.api.setRows([record(h,'rename-read-race')]);await h.api.saveVersion();const [version]=await h.api.listVersions();
  h.db.beforeGet=(store,key)=>{if(store==='versions'&&key===version.id){h.db.beforeGet=null;h.controls.writable=false}};
  await assert.rejects(h.api.renameVersion(version.id,'不能写入的名称'),/已切换/);assert.equal(h.db.stores.versions.get(version.id).label,version.label);
});

test('the version manager saves a row name immediately and rejects a stale rename control in history mode',async()=>{
  const h=harness();h.api.setRows([record(h,'rename-manager')]);await h.api.saveVersion();const [version]=await h.api.listVersions();
  const input={dataset:{versionLabel:version.id},value:'  管理窗口保存的名称  '},button={dataset:{versionRename:version.id},isConnected:true,disabled:false},title={dataset:{versionTitle:version.id},textContent:version.label};
  h.controls.versionLabels=[input];h.controls.versionRenames=[button];h.controls.versionTitles=[title];await h.api.openVersionManager();
  assert.match(h.element('versionManager').innerHTML,/data-version-label/);await button.onclick();
  assert.equal(input.value,'管理窗口保存的名称');assert.equal(title.textContent,'管理窗口保存的名称');assert.equal(button.disabled,false);assert.match(h.element('versionSelect').innerHTML,/管理窗口保存的名称/);
  h.api.setHistory(true);input.value='历史只读时不能保存';await button.onclick();assert.equal(h.db.stores.versions.get(version.id).label,'管理窗口保存的名称');
});

test('the selected-version rename action opens and focuses its editor without requiring a native prompt',async()=>{
  const h=harness();h.api.setRows([record(h,'rename-selected')]);await h.api.saveVersion();const [version]=await h.api.listVersions();h.element('versionSelect').value=version.id;
  let focused=0,selected=0,scrolled=0;const input={dataset:{versionLabel:version.id},value:version.label,focus(){focused++},select(){selected++},scrollIntoView(){scrolled++}},button={dataset:{versionRename:version.id},isConnected:true,disabled:false};
  h.controls.versionLabels=[input];h.controls.versionRenames=[button];await h.api.renameSelectedVersion();assert.equal(focused,1);assert.equal(selected,1);assert.equal(scrolled,1);assert.match(h.element('versionManager').innerHTML,/保存名称/);
  h.element('closeVersionManager').onclick();assert.equal(h.db.stores.versions.get(version.id).label,version.label);
  await h.api.renameSelectedVersion();input.value='  下拉选中版本的新名称  ';await button.onclick();assert.equal(h.db.stores.versions.get(version.id).label,'下拉选中版本的新名称');assert.equal(h.element('versionSelect').value,version.id);
});
