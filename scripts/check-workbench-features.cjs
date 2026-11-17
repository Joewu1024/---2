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
            getAll: () => request([...store.values()]), get: key => request(store.get(key) ?? null),
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

function harness() {
  const elements = new Map(), controls = { writable: true, batch: [], editors: [], checks: [], calculations: [], downloads: [], renders: 0, parse: null }, db = fakeDatabase();
  const selectAll = selector => {
    if (selector === '[data-batch]') return controls.batch;
    if (selector === '[data-edit]') return controls.editors;
    if (selector === '[data-calc-row]') return controls.calculations;
    if (selector === '[data-version-delete]') return controls.checks;
    if (selector === '[data-version-delete]:checked') return controls.checks.filter(x => x.checked);
    return [];
  };
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, style: { setProperty() {} },
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
    ...['key','safeHttpUrl','safeImageUrl','headerScore','isMetaRow','getRaw','invalidateRaw','normalizeModelId','round2','format2','calc','value','filterValue','aliasFor'].map(n=>line('function '+n+'(')),
    between('function drawOptions(i)', 'function statusValue('),
    ...['statusValue','statusLines','groupIsOpen','visibleFields','displayColumns','colSize','updateStats','matchesState','updateSelectionUI','selectedSummary','activeFilterItems','renderFilterSummary','sorted','recordsGroups','renderPager','render'].map(n=>line('function '+n+'(')),
    between('function rowHtml(', 'function closeProductCard('),
    line('function bindTable('), between('function batch()', 'function openWorkbenchDB('),
    ...['dbRequest','localDateKey','writeRecordBatches'].map(n=>line('function '+n+'(')),
    ...['listVersions','refreshVersions','openVersionManager','readVersion','showVersion'].map(n=>line('async function '+n+'(')),
    between('async function saveVersion(', 'async function readVersion('),
    line('function returnToCurrent('), line('async function restoreVersionAsCurrent('), line('function markDirty('), line('function save('), line('async function flushSave('),
    ...['textTokens','titleSimilarity','imageDistance','imageKey','sameImage','imageSimilarity','similarityPercent','similarProduct','escapeRe','extractBrand','extractStyle','extractQty','deriveRecord'].map(n=>line('function '+n+'(')),
    between('async function regroup(', 'async function prepareImageHashes('), line('function parseDelimited('), between('function selectImportHeader(', 'async function workbookHasEmbeddedImages('),
    between('function xmlEsc(', 'function mergeBuyerEdits('),
    line('function mergeBuyerEdits('), between('async function importFile(', 'async function importInvitations('),
    between('async function importInvitations(', 'async function importTranslations('),
    between('async function importTranslations(', 'function download('),
    // This binding also contains other handlers, whose actions remain uncalled.
    line('$("import").onclick=')
  ].join('\n');
  const context = vm.createContext({
    document, console, controls, db, BuyerTranslation, WorkbenchImport, Blob, TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, URL, AbortController,
    workspace: { isDefault:true, created:false, dbName:base=>base||'buyer-pool-workbench', storageKey:base=>base },
    innerWidth: 1400, location: { href: 'https://offline.example.test/index.html' },
    localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout(callback,delay) { return delay===0?setTimeout(callback,0):null; }, clearTimeout(timer) { if(timer!==null)clearTimeout(timer); }, confirm: () => true,
    IDBKeyRange: { only: value => value }, fetch() { throw Error('Network forbidden'); }
  });
  const api = vm.runInContext(`(function(){
    ${extracted}
    function canEditWorkspace(){return controls.writable}
    async function openWorkbenchDB(){return db}
    function refreshTranslationReadiness(){} function scheduleTranslationStatus(){}
    function closeProductCard(){} function closeImageZoom(){} function queueVisibleTranslation(){}
    function translationSource(r,index){return value(r,H[index])} function deriveChineseField(){}
    function editTranslationSource(){} function toggleProductCard(){} function showImageZoom(){} function scheduleImageZoomClose(){}
    function runDeferredProcessing(){} async function parseXlsx(){throw Error('XLSX parser not under test')}
    function download(blob,name){controls.downloads.push({blob,name})}
    function showShareLinkDialog(){} function filterPopup(){} function drawer(){}
    return {H,FIELD,controls,filtered,recordsGroups,matchesState,statusValue,filterValue,value,calc,normalizeModelId,idFor,
      batch,drawOptions,bindTable,deriveRecord,regroup,merge,splitSelectedFromGroups,visibleFields,displayColumns,render,
      updateStats,exportRows,exportCsv,exportXlsx,parseCsv,parseDelimited,importFile,importInvitations,importTranslations,
      writeRecordBatches,saveVersion,listVersions,readVersion,showVersion,returnToCurrent,restoreVersionAsCurrent,openVersionManager,flushSave,save,
      get rows(){return rows},get historyMode(){return historyMode},get visibleRows(){return visibleRows},get selected(){return selected},
      setRows(next){rows=next;headers=H.slice();sourceFileName='fabricated.csv'},setFilters(next){filters=next},
      setSelected(ids){selected=new Set(ids)},setGrouping(value){groupingEnabled=value},setOpened(ids){opened=new Set(ids)},
      setFolds(c8,attrs){showC8=c8;showAttrs=attrs},setHistory(value){historyMode=value},setThreshold(value){threshold=value}
    };
  })()`, context, { filename: 'offline-workbench-functions.js' });
  return { api, element, controls, db };
}

function record(h, id, raw = {}) {
  return { uid: id, excelRow: 2, raw: { 'Model ID': id, ...raw }, group: 'shared-group', preValue: '', preDate: '', preNote: '' };
}
function ids(rows) { return Array.from(rows, r => r.uid); }
function csvFile(text, name = 'fabricated.csv') { const b = new Blob([text], { type: 'text/csv' }); b.name = name; return b; }

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
  h.controls.checks=versions.map(v=>({dataset:{versionDelete:v.id},checked:v.id===v2.id}));
  await h.api.openVersionManager();await h.element('deleteSelectedVersions').onclick();
  assert.equal(h.db.stores.versions.has(v2.id),false);assert.equal([...h.db.stores.versionRecords.values()].some(r=>r.versionId===v2.id),false);
  r.raw.revision='revision-4';await h.api.saveVersion();
  assert.equal((await h.api.readVersion(v3.id)).rows[0].raw.revision,'revision-3');
  assert.ok((await h.api.listVersions()).some(v=>v.id.endsWith('-V4')));
});

test('history inspection is read-only and returning/restoring uses the intended dataset',async()=>{
  const h=harness(),r=record(h,'a',{item_name:'snapshot'});h.api.setRows([r]);await h.api.saveVersion();const [v]=await h.api.listVersions();
  r.raw.item_name='current';await h.api.showVersion(v.id);assert.equal(h.api.historyMode,true);assert.equal(h.api.rows[0].raw.item_name,'snapshot');
  h.api.returnToCurrent();assert.equal(h.api.historyMode,false);assert.equal(h.api.rows[0].raw.item_name,'current');
  await h.api.restoreVersionAsCurrent(v.id);assert.equal(h.api.rows[0].raw.item_name,'snapshot');await h.api.flushSave();assert.equal(h.db.stores.records.get('a').raw.item_name,'snapshot');
});

test('CSV export quotes commas, quotes and line breaks and reimports long Model IDs exactly',async()=>{
  const h=harness(),id='12345678901234567890',note='第一行,"引号"\n第二行',r=record(h,id,{[h.api.H[24]]:note});
  const out=h.api.exportCsv([r]);assert.equal((await out.arrayBuffer()).byteLength>0,true);
  const parsed=await h.api.parseCsv(out);assert.equal(h.api.idFor(parsed.rows[0]),id);assert.equal(h.api.value(parsed.rows[0],h.api.H[24]),note);
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
  const h=harness(),r=record(h,'12345678901234567890',{[h.api.H[24]]:'A&B <tag>\u0001'}),buf=Buffer.from(await h.api.exportXlsx([r]).arrayBuffer());
  assert.equal(buf.readUInt32LE(0),0x04034b50);assert.equal(buf.readUInt32LE(buf.length-22),0x06054b50);
  const files=new Map();let at=0;while(buf.readUInt32LE(at)===0x04034b50){const size=buf.readUInt32LE(at+18),nameLength=buf.readUInt16LE(at+26),extraLength=buf.readUInt16LE(at+28),start=at+30+nameLength+extraLength;files.set(buf.toString('utf8',at+30,at+30+nameLength),buf.toString('utf8',start,start+size));at=start+size;}
  const xml=files.get('xl/worksheets/sheet1.xml');assert.ok(xml);assert.match(xml,/t="inlineStr"/);assert.match(xml,/12345678901234567890/);assert.match(xml,/A&amp;B &lt;tag&gt;/);assert.doesNotMatch(xml,/\u0001/);
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
