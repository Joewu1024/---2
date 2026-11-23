'use strict';

// Offline application-integration checks: actual index.html task functions,
// actual task-key/CSV engines, fabricated records and simulated DOM/IndexedDB.
// Export transport is captured as a table; no Google upload/download or live
// document-translation result is claimed by these tests.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const BuyerTranslation=require('../translation-engine.js');
const WorkbenchImport=require('../workbench-import.js');
const Tasks=require('../workbench-translation-tasks.js');
const documentHtml=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const html=Array.from(documentHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)).at(-1)[1];
const lines=html.split(/\r?\n/);
const plain=value=>JSON.parse(JSON.stringify(value));
function line(prefix){const found=lines.find(text=>text.startsWith(prefix));assert.ok(found,'Missing source: '+prefix);return found}
function between(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a,'Missing source block: '+start);return html.slice(a,b)}

function database(){
  const meta=new Map(),writes=[];
  const request=value=>{const req={};queueMicrotask(()=>{req.result=plain(value);req.onsuccess?.()});return req};
  return {meta,writes,transaction(names,mode){const tx={objectStore(name){assert.equal(name,'meta');return {
    getAll:()=>request([...meta.values()]),get:key=>request(meta.get(key)??null),
    put(value){writes.push(plain(value));meta.set(value.key,plain(value));return request(value.key)}
  }}};if(mode==='readwrite')setImmediate(()=>tx.oncomplete?.());return tx}};
}

let nextUuid=0;
function harness(options={}){
  const db=options.db||database(),elements=new Map(),controls={writable:true,dirty:new Set(),saves:[],renders:0,exports:[],downloads:[],storage:new Map(),warnings:[]};
  function element(id){if(!elements.has(id))elements.set(id,{id,textContent:'',innerHTML:'',disabled:false,isConnected:true,dataset:{},querySelectorAll(){return []}});return elements.get(id)}
  const document={getElementById:element};
  const WorkbenchTranslationTasks={...Tasks,createTask:entries=>Tasks.createTask(entries,{crypto:{randomUUID:()=>String(++nextUuid).padStart(8,'0')+'-1111-4111-8111-111111111111'}})};
  const context=vm.createContext({BuyerTranslation,WorkbenchImport,WorkbenchTranslationTasks,document,db,controls,
    WorkbenchExport:{async exportInWorker(table,settings){controls.exports.push({table:plain(table),settings:plain(settings)});return {blob:new Blob([JSON.stringify(table)])}}},
    WorkbenchXlsx:{async parseInWorker(){throw Error('XLSX parsing is covered separately; this fixture uses the actual CSV parser')}},
    URL,URLSearchParams,Blob,TextEncoder,TextDecoder,setTimeout,clearTimeout,console:{...console,warn:error=>controls.warnings.push(error?.message||String(error))},
    location:{href:'https://offline.example.test/index.html'},localStorage:{setItem(key,value){controls.storage.set(key,value)}},fetch(){throw Error('Network access forbidden in document-task UI checks')}
  });
  const actual=[line('const H='),line('const rawLookupCache='),line('const keyMap='),
    ...['key','getRaw','invalidateRaw','normalizeModelId','value','aliasFor','manualChinese','translationSource','translationLanguage','translationRegionHint','translationVersionField','translationWarningField','categoryKey','dbRequest'].map(name=>line('function '+name+'(')),
    line('const TRANSLATION_VERSION='),between('function categoryValues(', 'function categoryLabel('),
    between('// buyer-chinese-priority:start','// buyer-chinese-priority:end'),
    between('// google-document-v1:start','// google-document-v1:end')].join('\n');
  const api=vm.runInContext(`(function(){let rows=[],historyMode=false,sourceFileName='fabricated-source.csv';const categoryTranslationCache=new Map();
    function canEditWorkspace(){return controls.writable}async function openWorkbenchDB(){return db}
    function closeProductCard(){}function render(){controls.renders++}function markDirty(record){controls.dirty.add(record.uid)}function save(all){controls.saves.push(all)}
    function download(blob,name){controls.downloads.push({blob,name})}function hasChinese(text){return /[\\u3400-\\u9fff]/.test(String(text||''))}
    ${actual}
    return {H,createGoogleDocumentTasks,savedGoogleDocumentTasks,getGoogleDocumentTask,downloadGoogleDocumentTask,importGoogleDocumentResult,categoryTranslationCache,
      setRows(next){rows=next},setHistory(value){historyMode=value},get rows(){return rows}};
  })()`,context,{filename:'actual-google-document-ui-functions.js'});
  return {api,db,controls,element};
}

function record(h,id,item,model='',extra={}){return {uid:'fabricated-'+id,raw:{'Model ID':id,[h.api.H[9]]:item,[h.api.H[11]]:model,...extra}}}
function csv(matrix){const quote=value=>{const text=String(value??'');return /[",\r\n]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text};const file=new Blob([matrix.map(row=>row.map(quote).join(',')).join('\r\n')],{type:'text/csv'});file.name='fabricated-google-result.csv';return file}
function translatedMatrix(task,prefix='Google 虚构中文：'){return [['Translated task key','Translated source'],...task.entries.map(entry=>[entry.key,prefix+entry.source]).reverse()]}
async function taskFor(h){await h.api.createGoogleDocumentTasks();const tasks=await h.api.savedGoogleDocumentTasks();assert.equal(tasks.length,1);return tasks[0].task}

test('document generation exports only automatic source text and random keys while persisting mappings in this workspace',async()=>{
  const h=harness(),privateId='0000000000000000456789',a=record(h,privateId,'Wireless speaker FICT-DOC-A','Black variant FICT-DOC-A',{[h.api.H[13]]:'98765.4321',[h.api.H[15]]:'42.78',[h.api.H[24]]:'PRIVATE_BUYER_NOTE',level1_global_be_category:'Audio Equipment'});
  const manual=record(h,'PRIVATE-MODEL-B','Wireless manual product','FICT900',{[h.api.H[10]]:'买手人工标题'});manual.userEditedFields=[h.api.H[10]];
  const supplied=record(h,'PRIVATE-MODEL-C','Wireless supplied product','',{[h.api.H[10]]:'买手提供中文'});supplied.autoItemChinese=false;
  h.api.setRows([a,manual,supplied]);const task=await taskFor(h);assert.equal(task.entries.length,3);
  await h.api.downloadGoogleDocumentTask(task.id);const exported=h.controls.exports[0];
  assert.deepEqual(exported.table.headers,['任务键','待翻译原文']);assert.ok(exported.table.data.every(row=>row.length===2&&row[0].startsWith('GTASK-')));assert.equal(exported.settings.format,'xlsx');
  assert.deepEqual(new Set(exported.table.data.map(row=>row[1])),new Set(['Wireless speaker FICT-DOC-A','Black variant FICT-DOC-A','Audio Equipment']));
  assert.doesNotMatch(JSON.stringify(exported.table),/0000000000000000456789|PRIVATE-MODEL|98765\.4321|42\.78|PRIVATE_BUYER_NOTE|references|modelId/);
  assert.ok(task.entries.some(entry=>entry.references.some(reference=>reference.modelId===privateId)));
  assert.equal(h.db.meta.has('google-doc:'+task.id),true);const reopened=harness({db:h.db});assert.equal((await reopened.api.savedGoogleDocumentTasks()).length,1);
  await assert.rejects(harness().api.getGoogleDocumentTask(task.id),/本工作区没有/);
});

test('shuffled results backfill exact Model IDs and persist the manual Google-document provenance',async()=>{
  const h=harness(),a=record(h,'000000000000000000001','Wireless speaker FICT-DOC-D','Black variant FICT-DOC-D'),b=record(h,'12345678901234567890','Wireless microphone FICT-DOC-E');h.api.setRows([a,b]);
  const task=await taskFor(h);h.api.setRows([b,a]);await h.api.importGoogleDocumentResult(csv(translatedMatrix(task)),task.id);
  assert.equal(a.raw[h.api.H[10]],'Google 虚构中文：Wireless speaker FICT-DOC-D');assert.equal(a.raw[h.api.H[12]],'Google 虚构中文：Black variant FICT-DOC-D');assert.equal(b.raw[h.api.H[10]],'Google 虚构中文：Wireless microphone FICT-DOC-E');
  for(const r of [a,b]){assert.ok(r.userEditedFields.includes(h.api.H[10]));assert.equal(r.autoItemChinese,false);assert.equal(r.localTranslatedItem,true);assert.equal(r.translationItemProvider,'google-document');assert.equal(r.translationItemVersion,'reference-v7-20261117')}
  assert.equal(a.raw['Model ID'],'000000000000000000001');assert.equal(b.raw['Model ID'],'12345678901234567890');assert.deepEqual([...h.controls.dirty].sort(),[a.uid,b.uid].sort());assert.deepEqual(h.controls.saves,[true]);
});

test('return imports retain later buyer edits and changed sources while filling other matching fields',async()=>{
  const h=harness(),manual=record(h,'DOC-MANUAL','Wireless source FICT-DOC-F'),changed=record(h,'DOC-CHANGED','Wireless source FICT-DOC-G'),ready=record(h,'DOC-READY','Wireless source FICT-DOC-H');h.api.setRows([manual,changed,ready]);const task=await taskFor(h);
  manual.raw[h.api.H[10]]='买手在导出后确认中文';manual.userEditedFields=[h.api.H[10]];changed.raw[h.api.H[9]]='New source FICT-DOC-G';changed.raw[h.api.H[10]]='Keep existing changed-source Chinese';
  await h.api.importGoogleDocumentResult(csv(translatedMatrix(task)),task.id);
  assert.equal(manual.raw[h.api.H[10]],'买手在导出后确认中文');assert.equal(changed.raw[h.api.H[10]],'Keep existing changed-source Chinese');assert.equal(ready.raw[h.api.H[10]],'Google 虚构中文：Wireless source FICT-DOC-H');assert.deepEqual([...h.controls.dirty],[ready.uid]);
});

test('dataset replacement, history inspection and ownership loss cancel a pending document import',async()=>{
  for(const change of ['dataset','history','ownership']){
    const h=harness(),r=record(h,'DOC-CANCEL','Wireless source FICT-DOC-I');h.api.setRows([r]);const task=await taskFor(h),replacement=record(h,'DOC-CANCEL','Wireless source FICT-DOC-I');const writes=h.db.writes.length;
    const pending=h.api.importGoogleDocumentResult(csv(translatedMatrix(task)),task.id);if(change==='dataset')h.api.setRows([replacement]);else if(change==='history')h.api.setHistory(true);else h.controls.writable=false;await pending;
    assert.equal(r.raw[h.api.H[10]],undefined);assert.equal(replacement.raw[h.api.H[10]],undefined);assert.equal(h.controls.dirty.size,0);assert.equal(h.controls.saves.length,0);assert.equal(h.db.writes.length,writes);assert.match(h.element('googleDocumentStatus').textContent,/已切换/);
  }
});

test('unknown task keys or conflicting duplicate results reject the entire return without any writes',async()=>{
  for(const problem of ['unknown','conflict']){
    const h=harness(),r=record(h,'DOC-REJECT','Wireless source FICT-DOC-J');h.api.setRows([r]);const task=await taskFor(h),matrix=translatedMatrix(task),writes=h.db.writes.length;
    matrix.push(problem==='unknown'?['GTASK-99999999-9999-4999-8999-999999999999-00000001','未知任务中文']:[task.entries[0].key,'冲突的另一种中文']);await h.api.importGoogleDocumentResult(csv(matrix),task.id);
    assert.equal(r.raw[h.api.H[10]],undefined);assert.equal(h.controls.dirty.size,0);assert.equal(h.controls.saves.length,0);assert.equal(h.db.writes.length,writes);assert.match(h.element('googleDocumentStatus').textContent,/任务键不一致|重复冲突/);
  }
});

test('one deduplicated source updates both product Chinese and the category cache',async()=>{
  const h=harness(),source='Portable Audio Equipment',r=record(h,'DOC-CATEGORY',source,'',{level1_global_be_category:source});h.api.setRows([r]);const task=await taskFor(h);assert.equal(task.entries.length,1);
  await h.api.importGoogleDocumentResult(csv(translatedMatrix(task)),task.id);
  assert.equal(r.raw[h.api.H[10]],'Google 虚构中文：'+source);assert.equal(h.api.categoryTranslationCache.get(source.toLowerCase()),'Google 虚构中文：'+source);
});

test('4000-entry files can return in reverse chunk and row order without positional matching',async()=>{
  const h=harness(),records=Array.from({length:4005},(_,i)=>record(h,'BUSINESS-'+String(i).padStart(8,'0'),'Wireless fixture speaker FICT'+(50000+i)));h.api.setRows(records);await h.api.createGoogleDocumentTasks();
  const tasks=(await h.api.savedGoogleDocumentTasks()).map(entry=>entry.task);assert.deepEqual(tasks.map(task=>task.entries.length).sort((a,b)=>a-b),[5,4000]);
  h.api.setRows(records.slice().reverse());for(const task of tasks.reverse())await h.api.importGoogleDocumentResult(csv(translatedMatrix(task)),task.id);
  assert.ok(records.every(r=>r.raw[h.api.H[10]]==='Google 虚构中文：'+r.raw[h.api.H[9]]));assert.equal(h.controls.dirty.size,4005);assert.equal(h.controls.saves.length,2);
});

test('document import rechecks the dataset after a matching-loop yield',async()=>{
  const h=harness(),records=Array.from({length:105},(_,i)=>record(h,'DOC-YIELD-'+i,'Wireless yield fixture FICT'+(60000+i)));h.api.setRows(records);const task=await taskFor(h),replacement=records.map(r=>({...r,raw:{...r.raw}}));let text='',switched=false;
  Object.defineProperty(h.element('googleDocumentStatus'),'textContent',{get(){return text},set(value){text=value;if(!switched&&value==='回填中文 100 项'){switched=true;h.api.setRows(replacement);h.api.setHistory(true)}}});
  await h.api.importGoogleDocumentResult(csv(translatedMatrix(task)),task.id);assert.equal(switched,true);assert.ok(replacement.every(r=>r.raw[h.api.H[10]]===undefined));assert.equal(records[104].raw[h.api.H[10]],undefined);assert.equal(h.controls.saves.length,0);
});
