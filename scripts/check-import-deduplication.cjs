'use strict';

// Synthetic files only. Actual main-import functions and the shipped CSV/XLSX
// Worker sources run offline with a fake DOM. This is not a browser/IDB test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, afterEach } = require('node:test');
const { Worker: NodeWorker } = require('node:worker_threads');
const { resolveObjectURL } = require('node:buffer');
const { performance } = require('node:perf_hooks');
const XLSX = require('../vendor/xlsx.full.min.js');
const BuyerTranslation = require('../translation-engine.js');
const root = path.join(__dirname, '..'), html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const lines = html.split(/\r?\n/), workers = [], vendorPath = require.resolve('../vendor/xlsx.full.min.js');
const vendorUrl = 'https://offline.example.test/vendor/xlsx.full.min.js';
const line = prefix => { const found = lines.find(text => text.startsWith(prefix));assert.ok(found, 'Missing actual definition: ' + prefix);return found; };
const between = (start, end) => { const a = html.indexOf(start), b = html.indexOf(end, a);assert.ok(a >= 0 && b > a, 'Missing actual source range: ' + start);return html.slice(a, b); };
const plain = value => JSON.parse(JSON.stringify(value));

class BrowserWorkerShim {
  constructor(url) {
    this.pending = [];this.stopped = false;workers.push(this);
    resolveObjectURL(url).text().then(source => {
      if (this.stopped) return;
      const prefix = 'const {parentPort}=require("node:worker_threads");globalThis.fetch=()=>{throw Error("Network forbidden")};globalThis.self={postMessage:value=>parentPort.postMessage(value)};' +
        'globalThis.importScripts=url=>{if(url!==' + JSON.stringify(vendorUrl) + ')throw Error("Unexpected library URL");self.XLSX=require(' + JSON.stringify(vendorPath) + ')};';
      this.worker = new NodeWorker(prefix + source + ';parentPort.on("message",data=>self.onmessage({data}));', { eval: true });
      this.worker.on('message', data => { if (!this.stopped) this.onmessage?.({ data }); });
      this.worker.on('error', error => { if (!this.stopped) this.onerror?.(error); });
      this.pending.forEach(message => this.worker.postMessage(message));this.pending = [];
    }).catch(error => { if (!this.stopped) this.onerror?.(error); });
  }
  postMessage(message) { if (this.worker) this.worker.postMessage(message);else this.pending.push(message); }
  terminate() { this.stopped = true;this.termination = this.worker ? this.worker.terminate() : Promise.resolve(); }
}
afterEach(async () => { for (const worker of workers.splice(0)) { if (!worker.stopped) worker.terminate();await worker.termination; } });

function harness() {
  const elements = new Map(), controls = { writable: true, saves: [], renders: 0, yields: 0, beforeYield: null, beforeDedup: null, reports: [], errors: [], delayed: [], derived: [], automaticCalls: [], queueCancels: 0 };
  const element = id => { if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false, value: '', disabled: false });return elements.get(id); };
  const context = vm.createContext({
    BuyerTranslation, controls, Blob, TextEncoder, TextDecoder, Uint8Array, DataView, AbortController,
    Worker: BrowserWorkerShim, URL, location: { protocol: 'https:', href: 'https://offline.example.test/index.html', origin: 'https://offline.example.test' },
    document: { getElementById: element, baseURI: 'https://offline.example.test/index.html' },
    console: { ...console, error: error => controls.errors.push(error), warn: error => controls.errors.push(error) },
    fetch() { throw Error('Network forbidden'); },
    setTimeout(callback, delay) { if (delay !== 0) { controls.delayed.push({callback,delay});return null; }controls.yields++;return setTimeout(() => { controls.beforeYield?.();callback(); }, 0); },clearTimeout
  });
  for (const file of ['workbench-import.js','workbench-xlsx.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  const source = [
    line('const H='),line('const S='),line('const FIELD='),line('let rows='),line('const rawLookupCache='),line('const keyMap='),
    ...['key','getRaw','invalidateRaw','normalizeModelId','round2','format2','calc','value','aliasFor','headerScore','isMetaRow','statusValue','statusLines'].map(name => line('function ' + name + '(')),
    between('function selectImportHeader(', 'function xmlEsc('),
    between('// import-deduplication:start', '// import-deduplication:end'),
    between('// buyer-chinese-priority:start','// buyer-chinese-priority:end'),
    between('// product-group-names:start','// product-group-names:end'),
    between('function mergeBuyerEdits(', '// import-deduplication:start'),
    between('async function runDeferredProcessing(', 'async function importFile('),
    between('async function importFile(', 'function download(')
  ].join('\n');
  const api = vm.runInContext(`(function(){
    let automaticChineseEnabled=true,automaticChineseRun=0,translationBackgroundRun=0;
    const translationQueue={cancelQueued(){controls.queueCancels++}};
    function canEditWorkspace(){return controls.writable}function returnToCurrent(){historyMode=false}
    function save(){controls.saves.push(rows.slice())}function render(){controls.renders++}
    function launchAutomaticChinese(...args){controls.automaticCalls.push(args)}function deriveRecord(record){controls.derived.push(record)}
    function filtered(){}filtered.searchText=()=>'';
    function translationSource(r,index){return value(r,H[index])}function markDirty(){}
    function refreshTranslationReadiness(){}function scheduleTranslationStatus(){}
    function reportQa(type,detail){controls.reports.push({type,...detail})}
    async function parseXlsxLegacy(){throw Error('Unexpected legacy XLSX path in a non-image fixture')}
    ${source}
    const actualDeduplicate=deduplicateImportedRows;
    deduplicateImportedRows=async function(records,options){controls.beforeDedup?.(records,options);return actualDeduplicate(records,options)};
    return {H,idFor,normalizeModelId,value,parseCsv,parseXlsx,importFile,importTranslations,importInvitations,deduplicateImportedRows,mergeBuyerEdits,
      get rows(){return rows},setRows(next){rows=next},cancelImport(){importFile.activeController?.abort()},
      get state(){return {headers,sourceFileName,groupingEnabled,filters,selected,opened,pageIndex,search:$('search').value}},
      setState(next){if('headers'in next)headers=next.headers;if('sourceFileName'in next)sourceFileName=next.sourceFileName;if('groupingEnabled'in next)groupingEnabled=next.groupingEnabled;if('filters'in next)filters=next.filters;if('selected'in next)selected=new Set(next.selected);if('opened'in next)opened=new Set(next.opened);if('pageIndex'in next)pageIndex=next.pageIndex;if('search'in next)$('search').value=next.search}};
  })()`, context, { filename: 'actual-import-deduplication-functions.js' });
  return { api, controls, element, async flushDelayed(delay=30){const pending=controls.delayed.filter(timer=>timer.delay===delay);controls.delayed=controls.delayed.filter(timer=>timer.delay!==delay);for(const timer of pending)await timer.callback()} };
}
function record(h,id,nb,extra={}) { return { uid: extra.uid || 'row-' + id, excelRow: extra.excelRow || 2, raw: { 'Model ID': id, backcal_cogs_non_brand: nb, ...extra.raw }, ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'raw')) }; }
function fileFor(format,matrix,configureSheet) {
  if(format==='csv') { const cell=value=>/[",\r\n]/.test(String(value??''))?'"'+String(value).replace(/"/g,'""')+'"':String(value??'');const file=new Blob([matrix.map(row=>row.map(cell).join(',')).join('\r\n')],{type:'text/csv'});file.name='fabricated-duplicates.csv';return file; }
  const book=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet(matrix);configureSheet?.(sheet);XLSX.utils.book_append_sheet(book,sheet,'Synthetic products');
  const file=new Blob([XLSX.write(book,{type:'buffer',bookType:'xlsx',compression:true})]);file.name='fabricated-duplicates.xlsx';return file;
}

test('Excel numeric Model IDs with the same scientific display retain their complete distinct source values',async()=>{
  const h=harness(),file=fileFor('xlsx',[
    ['model_id','item_id','item_name','model_name','backcal_cogs_non_brand'],
    [219627179576,58268933437,'First full ID','First model','10'],
    [219627179577,58268933438,'Second full ID','Second model','20']
  ],sheet=>{for(const address of ['A2','A3']){sheet[address].z='0.00000E+00';sheet[address].w='2.19627E+11'}});
  await h.api.importFile(file);
  assert.equal(h.api.rows.length,2,'the visible rounded values must not merge two genuine IDs');
  assert.deepEqual(Array.from(h.api.rows,row=>h.api.idFor(row)),['219627179576','219627179577']);
  assert.deepEqual(Array.from(h.api.rows,row=>row.raw.model_id),['219627179576','219627179577']);
  assert.deepEqual(Array.from(h.api.rows,row=>row.raw._modelId),['219627179576','219627179577']);
  assert.deepEqual(Array.from(h.api.rows,row=>row.raw.item_id),['58268933437','58268933438']);
  assert.equal(h.controls.errors.length,0);
});

for(const format of ['csv','xlsx'])test(format+' scientific-text Model and item IDs import as exact complete decimal strings',async()=>{
  const h=harness();
  await h.api.importFile(fileFor(format,[
    ['model_id','item_id','item_name','model_name','backcal_cogs_non_brand'],
    ['2.19627179576E+11','5.8268933437E+10','Scientific first','First model','10'],
    ['2.19627179577E+11','5.8268933438E+10','Scientific second','Second model','20']
  ]));
  assert.equal(h.api.rows.length,2);
  assert.deepEqual(Array.from(h.api.rows,row=>h.api.idFor(row)),['219627179576','219627179577']);
  assert.deepEqual(Array.from(h.api.rows,row=>row.raw.model_id),['219627179576','219627179577']);
  assert.deepEqual(Array.from(h.api.rows,row=>row.raw._modelId),['219627179576','219627179577']);
  assert.deepEqual(Array.from(h.api.rows,row=>row.raw.item_id),['58268933437','58268933438']);
  assert.equal(h.controls.errors.length,0);
});

for(const format of ['csv','xlsx'])test(format+' scientific text above the safe integer range deduplicates exactly and retains the highest-price row',async()=>{
  const h=harness(),long='900719925474099312345';
  await h.api.importFile(fileFor(format,[
    ['model_id','item_id','item_name','model_name','backcal_cogs_non_brand'],
    ['9.00719925474099312345E+20','5.8268933437E+10','Lower scientific source','Lower model','10'],
    [long,'5.8268933438E+10','Winning exact source','Winner model','20'],
    ['000219627179576','00058268933437','Leading-zero source','Zero model','30'],
    ['MODEL-A1','ITEM-B2','Alphanumeric source','Text model','40']
  ]));
  assert.equal(h.api.rows.length,3);
  assert.deepEqual(Array.from(h.api.rows,row=>h.api.idFor(row)),[long,'000219627179576','MODEL-A1']);
  const winner=h.api.rows[0];assert.equal(winner.raw.model_id,long);assert.equal(winner.raw._modelId,long);
  assert.equal(winner.raw.item_name,'Winning exact source');assert.equal(winner.raw.backcal_cogs_non_brand,'20');
  assert.equal(winner.raw.item_id,'58268933438');assert.equal(h.api.rows[1].raw.item_id,'00058268933437');
  assert.equal(h.api.rows[2].raw.item_id,'ITEM-B2');assert.equal(h.controls.errors.length,0);
});

test('normalization expands exact scientific integers without rounding long text or removing ordinary leading zeros',()=>{
  const h=harness();
  for(const [input,expected]of [
    ['2.19627179576E+11','219627179576'],['2.19627179577e+11','219627179577'],
    ['9.00719925474099312345E+20','900719925474099312345'],
    ['900719925474099312345','900719925474099312345'],['000219627179576','000219627179576'],
    ['MODEL-A1','MODEL-A1'],['000123.0','000123']
  ])assert.equal(h.api.normalizeModelId(input),expected,input);
});
function existingAppendFixture(h,format='csv') {
  const rows=[
    record(h,' 12,345.0 ','1',{uid:format+'2',raw:{item_name:'Existing first',[h.api.H[10]]:'Buyer title',[h.api.H[12]]:'5pcs',[h.api.H[24]]:'First buyer note'},userEditedFields:[h.api.H[10],h.api.H[12],h.api.H[24]],manualGroup:'manual-kept',group:'manual-kept',preTouched:true,preValue:'N',preDate:'2026-11-23',preNote:'Keep tuple',buyerAudit:{revision:7}}),
    record(h,'12345','99',{uid:format+'3',raw:{item_name:'Existing historical duplicate',[h.api.H[24]]:'Second historical note'},group:'automatic-kept',hash:'old-image-hash'}),
    record(h,'77777','2',{uid:format+'4',raw:{item_name:'Existing unrelated'},group:'automatic-kept'})
  ];
  h.api.setRows(rows);h.api.setState({headers:['Model ID','old-only-column'],sourceFileName:'existing-workbook.xlsx',groupingEnabled:true,filters:{'Model ID':{values:['12345']}},selected:[rows[0].uid,rows[2].uid],opened:['manual-kept','automatic-kept'],pageIndex:0,search:'existing query'});
  const state=h.api.state;return {rows:rows.slice(),dataset:rows,before:plain(rows),state,stateValues:{filters:plain(state.filters),selected:Array.from(state.selected),opened:Array.from(state.opened)}};
}
function assertExistingAppendState(h,fixture) {
  const {rows,before,state}=fixture,current=h.api.state;
  rows.forEach((row,index)=>assert.equal(h.api.rows[index],row,'old record identity '+index));assert.deepEqual(plain(rows),before,'all original raw data and metadata remain unchanged');
  for(const field of ['filters','selected','opened'])assert.equal(current[field],state[field],field+' reference is retained');
  assert.deepEqual(plain(current.filters),fixture.stateValues.filters);assert.deepEqual(Array.from(current.selected),fixture.stateValues.selected);assert.deepEqual(Array.from(current.opened),fixture.stateValues.opened);
  for(const field of ['sourceFileName','groupingEnabled','pageIndex','search'])assert.equal(current[field],state[field],field+' is retained');
}

test('deduplication compares full-precision Non Brand rather than target price and retains the whole winning row',async()=>{
  const h=harness(),first=record(h,'1001','12.001',{uid:'low',raw:{final_1688_price_moq_3:'100',item_name:'LOW ROW',item_id:'111',model_image:'https://example.test/low.png'}}),winner=record(h,'1001','12.004',{uid:'winner',excelRow:3,raw:{final_1688_price_moq_3:'1',item_name:'WINNING ROW',item_id:'222',model_image:'https://example.test/winner.png'}});
  const before=plain([first,winner]),result=await h.api.deduplicateImportedRows([first,winner]);
  assert.equal(result.rows.length,1);assert.equal(result.rows[0],winner);assert.deepEqual(plain([first,winner]),before);
  assert.equal(result.sourceCount,2);assert.equal(result.removedCount,1);assert.equal(result.duplicateIdCount,1);
  assert.equal(result.rows[0].raw.item_id,'222');assert.equal(result.rows[0].raw.item_name,'WINNING ROW');assert.equal(result.rows[0].raw.model_image,'https://example.test/winner.png');
});

test('ties retain the earliest source row and invalid prices rank below zero and negative valid numbers',async()=>{
  const h=harness(),rows=[record(h,'tie','10',{uid:'earliest'}),record(h,'tie','10.000',{uid:'later',excelRow:3}),record(h,'zero','',{uid:'blank'}),record(h,'zero','0',{uid:'zero'}),record(h,'negative','garbage',{uid:'invalid'}),record(h,'negative','-2',{uid:'negative'}),record(h,'all-invalid','NaN',{uid:'first-invalid'}),record(h,'all-invalid','Infinity',{uid:'last-invalid'})];
  const result=await h.api.deduplicateImportedRows(rows);assert.deepEqual(Array.from(result.rows,row=>row.uid),['earliest','zero','negative','first-invalid']);
});

test('normalized IDs merge formatting variants while long IDs, distinct leading zeros and missing IDs remain separate',async()=>{
  const h=harness(),a=record(h,' 12,345.0 ','1',{uid:'formatted'}),b=record(h,'12345','2',{uid:'normalized'}),long='900719925474099312345',rows=[a,b,record(h,long,'3',{uid:'long'}),record(h,'00012345','4',{uid:'leading-zero'}),record(h,'','9',{uid:'missing-1',raw:{_modelId:'AUTO-00002',shop_model_id:'12345'}}),record(h,'','8',{uid:'missing-2',raw:{_modelId:'AUTO-00002',shop_model_id:'12345'}})];
  delete rows.at(-1).raw['Model ID']; // No source-ID column at all, rather than merely an empty value.
  const result=await h.api.deduplicateImportedRows(rows);assert.deepEqual(Array.from(result.rows,row=>row.uid),['normalized','long','leading-zero','missing-1','missing-2']);
  assert.equal(result.rows[1].raw['Model ID'],long);
});

for(const format of ['csv','xlsx'])test(format+' main import deduplicates before merging buyer edits and preserves winner data',async()=>{
  const h=harness(),old=record(h,'12,345.0','1',{raw:{[h.api.H[10]]:'买手人工商品中文',[h.api.H[24]]:'买手保留备注',[h.api.H[25]]:'INV-BUYER'},userEditedFields:[h.api.H[10],h.api.H[24],h.api.H[25]],preTouched:true,preValue:'N',preDate:'2026-11-17',preNote:'人工核价备注'});h.api.setRows([old]);
  await h.api.importFile(fileFor(format,[['Model ID','item_name','model_name','backcal_cogs_non_brand','final_1688_price_moq_3','item_id'],['12345','Losing source','Losing model','10','100','111'],['12345','Winning source','Winning model','20','1','222'],['12345','Later tied source','Later tied model','20.000','99','444'],['67890','Other source','Other model','5','4','333']]));
  assert.equal(h.api.rows.length,2);const winner=h.api.rows.find(row=>h.api.idFor(row)==='12345');assert.ok(winner);
  assert.equal(winner.raw.item_name,'Winning source');assert.equal(winner.raw.item_id,'222');assert.equal(winner.raw.backcal_cogs_non_brand,'20');
  assert.equal(h.api.value(winner,h.api.H[10]),'买手人工商品中文');assert.equal(h.api.value(winner,h.api.H[24]),'买手保留备注');assert.equal(h.api.value(winner,h.api.H[25]),'INV-BUYER');
  for(const key of ['preTouched','preValue','preDate','preNote'])assert.equal(winner[key],old[key]);
  assert.equal(h.controls.saves.length,1);assert.equal(h.controls.saves[0].length,2);assert.ok(h.controls.reports.some(report=>report.type==='import'&&report.sourceRows===4&&report.duplicateRows===2&&report.duplicateIds===1));
});

for(const format of ['csv','xlsx'])test(format+' translation and invitation side imports keep their existing last-row behavior',async()=>{
  const h=harness(),row=record(h,'12345','5');h.api.setRows([row]);
  await h.api.importTranslations(fileFor(format,[['Model ID','item_name_zh','backcal_cogs_non_brand'],['12345','第一条高价译文','99'],['12345','第二条最终译文','1']]));
  assert.equal(h.api.value(row,h.api.H[10]),'第二条最终译文');
  await h.api.importInvitations(fileFor(format,[['Model ID','邀请ID','backcal_cogs_non_brand'],['12345','INV-FIRST-HIGH','99'],['12345','INV-LAST-LOW','1']]));
  assert.equal(h.api.value(row,h.api.H[25]),'INV-LAST-LOW');assert.equal(h.api.rows.length,1);
});

test('historical duplicate rows contribute all nonconflicting buyer edits without mutating previous records',()=>{
  const h=harness(),first=record(h,'12,345.0','1',{uid:'old-first',raw:{[h.api.H[10]]:'第一行人工商品中文'},userEditedFields:[h.api.H[10]],preTouched:false,preValue:'Y',preDate:'IGNORED',preNote:'not touched'}),second=record(h,'12345','2',{uid:'old-second',raw:{[h.api.H[24]]:'第二行买手备注',[h.api.H[25]]:'INV-SECOND'},userEditedFields:[h.api.H[24],h.api.H[25]],preTouched:true,preValue:'N',preDate:'2026-11-17',preNote:'第二行人工核价备注'}),previous=[first,second],before=plain(previous);
  const incoming=record(h,'12345','20',{uid:'new-winner',raw:{item_name:'Winning source'}}),merged=h.api.mergeBuyerEdits([incoming],previous)[0];
  assert.equal(merged.raw.item_name,'Winning source');assert.equal(merged.raw.backcal_cogs_non_brand,'20');
  assert.equal(h.api.value(merged,h.api.H[10]),'第一行人工商品中文');assert.equal(h.api.value(merged,h.api.H[24]),'第二行买手备注');assert.equal(h.api.value(merged,h.api.H[25]),'INV-SECOND');
  assert.deepEqual(Array.from(merged.userEditedFields),[h.api.H[10],h.api.H[24],h.api.H[25]]);
  for(const field of ['preTouched','preValue','preDate','preNote'])assert.equal(merged[field],second[field]);
  assert.deepEqual(plain(previous),before);assert.notEqual(merged.raw,first.raw);assert.notEqual(merged.raw,second.raw);
  merged.raw[h.api.H[24]]='new current edit';merged.userEditedFields.push('new field');assert.deepEqual(plain(previous),before);
});

test('the earliest duplicate manual field and preTouched tuple win conflicts including intentional blanks',()=>{
  const h=harness(),fields=[h.api.H[12],h.api.H[24],h.api.H[0]],first=record(h,'12345','1',{uid:'earliest-manual',raw:{[fields[0]]:'',[fields[1]]:'',[fields[2]]:'首行人工判断'},userEditedFields:fields.slice(),preTouched:true,preValue:'',preDate:'',preNote:''}),later=record(h,'12345','99',{uid:'later-manual',raw:{[fields[0]]:'后行中文型号',[fields[1]]:'后行备注',[fields[2]]:'后行判断',[h.api.H[25]]:'INV-LATER'},userEditedFields:[...fields,h.api.H[25]],preTouched:true,preValue:'Y',preDate:'2026-12-01',preNote:'后行核价备注'}),previous=[first,later],before=plain(previous);
  const incoming=record(h,'12345','20',{raw:{[fields[0]]:'文件提供中文型号',[fields[1]]:'文件提供备注'}}),merged=h.api.mergeBuyerEdits([incoming],previous)[0];
  for(const field of fields)assert.equal(merged.raw[field],first.raw[field]);assert.equal(merged.raw[h.api.H[25]],'INV-LATER');
  assert.equal(merged.autoModelChinese,false);assert.ok(merged.userEditedFields.includes(fields[0]));
  assert.equal(merged.preTouched,true);for(const field of ['preValue','preDate','preNote'])assert.equal(merged[field],'');
  assert.deepEqual(plain(previous),before);
});

test('20,000 source rows deduplicate with bounded reads and yields without mutating input',async()=>{
  const h=harness();let reads=0;const source=Array.from({length:20000},(_,index)=>record(h,String(Math.floor(index/2)),String(index%2?20.004:20.001),{uid:'fabricated-'+index}));
  const tracked=new Proxy(source,{get(target,key,receiver){if(/^\d+$/.test(String(key)))reads++;return Reflect.get(target,key,receiver)}}),result=await h.api.deduplicateImportedRows(tracked);
  assert.equal(result.rows.length,10000);assert.equal(result.removedCount,10000);assert.equal(result.duplicateIdCount,10000);
  assert.ok(result.rows.every(row=>Number(row.uid.slice('fabricated-'.length))%2===1));assert.equal(source.length,20000);
  assert.ok(reads<source.length*10,'bounded source-row reads rather than repeated per-ID rescans');assert.ok(h.controls.yields>0,'the event loop is yielded without a machine-speed threshold');
});

for(const format of ['csv','xlsx'])test('20,000 real '+format+' rows pass the complete main import and retain 10,000 winning records',async()=>{
  const h=harness(),started=performance.now(),headers=['Model ID','item_name','model_name','backcal_cogs_non_brand','final_1688_price_moq_3','item_id','model备注'];
  const rows=Array.from({length:20000},(_,index)=>{const id=String(900719925474099312345n+BigInt(Math.floor(index/2))),winning=index%2===1;return [id,(winning?'Winning':'Losing')+' source '+id,(winning?'Winning':'Losing')+' model '+id,winning?'20.004':'20.001',winning?'1':'100',(winning?'WIN-ITEM-':'LOSE-ITEM-')+id,(winning?'Winning':'Losing')+' note '+id]});
  const file=fileFor(format,[headers,...rows]),prepared=performance.now();await h.api.importFile(file);const imported=performance.now();
  assert.equal(h.api.rows.length,10000);assert.equal(h.controls.saves.length,1);assert.equal(h.controls.saves[0].length,10000);
  assert.equal(new Set(Array.from(h.api.rows,row=>h.api.idFor(row))).size,10000);
  for(const row of h.api.rows){const id=h.api.idFor(row);assert.equal(row.raw.item_name,'Winning source '+id);assert.equal(row.raw.model_name,'Winning model '+id);assert.equal(row.raw.backcal_cogs_non_brand,'20.004');assert.equal(row.raw.final_1688_price_moq_3,'1');assert.equal(row.raw.item_id,'WIN-ITEM-'+id);assert.equal(row.raw['model备注'],'Winning note '+id)}
  const report=h.controls.reports.find(value=>value.type==='import');assert.ok(report);
  assert.equal(report.rows,10000);assert.equal(report.sourceRows,20000);assert.equal(report.duplicateRows,10000);assert.equal(report.duplicateIds,10000);
  assert.equal(report.reader,format==='csv'?'CSV Worker':'Excel Worker');assert.equal(h.controls.errors.length,0);
  console.log('Node '+format.toUpperCase()+' 20,000 → 10,000: fixture '+(prepared-started).toFixed(1)+' ms; parse/map/deduplicate/import '+(imported-prepared).toFixed(1)+' ms (offline Worker + fake DOM/save).');
});

test('cancelling a yielding deduplication leaves every original row untouched',async()=>{
  const h=harness(),controller=new AbortController(),source=Array.from({length:2000},(_,index)=>record(h,String(index%100),'10',{uid:'cancel-'+index})),before=plain(source);
  h.controls.beforeYield=()=>controller.abort();await assert.rejects(h.api.deduplicateImportedRows(source,{signal:controller.signal}),error=>error.name==='AbortError');
  assert.deepEqual(plain(source),before);
});

test('cancelling during main-import deduplication preserves the existing workbench and makes no save',async()=>{
  const h=harness(),old=record(h,'old','1',{raw:{item_name:'Existing workbench'}});h.api.setRows([old]);
  h.controls.beforeDedup=()=>{h.controls.beforeYield=()=>h.api.cancelImport()};
  const matrix=[['Model ID','item_name','backcal_cogs_non_brand'],...Array.from({length:1200},(_,index)=>[String(index%100),'Fabricated '+index,'10'])];
  await h.api.importFile(fileFor('csv',matrix));assert.equal(h.api.rows.length,1);assert.equal(h.api.rows[0],old);assert.equal(h.controls.saves.length,0);
  assert.match(h.element('toast').textContent,/已取消/);
});

for(const format of ['csv','xlsx'])test(format+' append skips overlapping IDs entirely, deduplicates the new file and retains existing UI and buyer state',async()=>{
  const h=harness(),fixture=existingAppendFixture(h,format),matrix=[
    ['Model ID','item_name','model_name','backcal_cogs_non_brand','final_1688_price_moq_3','item_id','new-only-column'],
    ['12345','MUST NOT OVERWRITE','Changed model','9999','1','OVERLAP','new'],
    ['88888','Losing appended source','Losing model','20.001','100','LOW','new'],
    ['88888','Winning appended source','Winning model','20.004','1','WIN','new'],
    ['','Missing source ID','Missing model','999','1','MISSING','new']
  ];
  const file=fileFor(format,matrix);await h.api.importFile(file,{mode:'append'});assert.equal(h.api.rows.length,4);assertExistingAppendState(h,fixture);
  const added=h.api.rows[3];assert.equal(h.api.idFor(added),'88888');assert.equal(added.raw.item_name,'Winning appended source');assert.equal(added.raw.item_id,'WIN');assert.equal(added.raw.backcal_cogs_non_brand,'20.004');
  assert.equal(new Set(Array.from(h.api.rows,row=>row.uid)).size,4,'new parsed row UID cannot collide with an old csv/xlsx row UID');
  assert.equal(added.group,'UNGROUPED-'+added.uid);assert.equal(added.manualGroup||'','');
  assert.deepEqual(Array.from(h.api.state.headers).slice(0,2),['Model ID','old-only-column']);assert.ok(h.api.state.headers.includes('new-only-column'));
  assert.equal(h.controls.saves.length,1);assert.equal(h.controls.saves[0].length,4);assert.equal(h.controls.queueCancels,0);
  const report=h.controls.reports.find(item=>item.type==='import'&&item.mode==='append');assert.ok(report);
  for(const [key,value]of Object.entries({rows:4,sourceRows:4,addedRows:1,existingRows:1,missingIdRows:1,duplicateRows:1}))assert.equal(report[key],value,key);
  await new Promise(resolve=>setTimeout(resolve,0));assert.equal(h.controls.automaticCalls.length,1);assert.equal(h.controls.automaticCalls[0][0],h.api.rows);assert.deepEqual(Array.from(h.controls.automaticCalls[0][1].records),[added]);
  await h.flushDelayed();assert.deepEqual(h.controls.derived,[added]);assertExistingAppendState(h,fixture);
  const beforeRepeat=h.api.rows,saves=h.controls.saves.length,launches=h.controls.automaticCalls.length;await h.api.importFile(file,{mode:'append'});
  assert.equal(h.api.rows,beforeRepeat);assert.equal(h.api.rows.length,4);assert.equal(h.controls.saves.length,saves);assert.equal(h.controls.automaticCalls.length,launches);assertExistingAppendState(h,fixture);
});

for(const format of ['csv','xlsx'])test(format+' append of only existing IDs is a complete no-op even when the incoming prices are higher',async()=>{
  const h=harness(),fixture=existingAppendFixture(h,format);
  await h.api.importFile(fileFor(format,[['Model ID','item_name','backcal_cogs_non_brand'],['12345','Must not replace existing duplicate rows','99999'],['77777','Must not replace existing unrelated row','99999']]),{mode:'append'});
  assert.equal(h.api.rows,fixture.dataset);assertExistingAppendState(h,fixture);assert.equal(h.controls.saves.length,0);assert.equal(h.controls.automaticCalls.length,0);assert.equal(h.controls.queueCancels,0);
  const report=h.controls.reports.find(item=>item.type==='import'&&item.mode==='append');assert.ok(report);assert.equal(report.addedRows,0);assert.equal(report.existingRows,2);
});

test('append refuses a file with only shop_model_id and generated AUTO IDs instead of a real source Model ID',async()=>{
  const h=harness(),fixture=existingAppendFixture(h);
  await h.api.importFile(fileFor('csv',[['shop_model_id','item_name','model_name','backcal_cogs_non_brand'],['12345','Missing real source ID','A model','50']]),{mode:'append'});
  assert.equal(h.api.rows,fixture.dataset);assertExistingAppendState(h,fixture);assert.equal(h.controls.saves.length,0);assert.equal(h.controls.automaticCalls.length,0);
  const report=h.controls.reports.find(item=>item.type==='import'&&item.mode==='append');assert.ok(report);assert.equal(report.missingIdRows,1);assert.equal(report.addedRows,0);assert.match(h.element('toast').textContent,/Model ID/);
});

test('existing generated IDs and shop_model_id values do not block new genuine source IDs',async()=>{
  const h=harness(),old=record(h,'','10',{uid:'csv2',raw:{_modelId:'AUTO-00002',shop_model_id:'999',item_name:'Existing without a source ID'}}),before=plain(old);h.api.setRows([old]);
  await h.api.importFile(fileFor('csv',[['Model ID','item_name','backcal_cogs_non_brand'],['AUTO-00002','Genuine source AUTO ID','20'],['999','Genuine source numeric ID','30']]),{mode:'append'});
  assert.equal(h.api.rows.length,3);assert.equal(h.api.rows[0],old);assert.deepEqual(plain(old),before);assert.deepEqual(Array.from(h.api.rows.slice(1),row=>h.api.idFor(row)),['AUTO-00002','999']);assert.equal(new Set(Array.from(h.api.rows,row=>row.uid)).size,3);
});

for(const format of ['csv','xlsx'])test(format+' append failure keeps the dataset, selections and metadata intact without saving',async()=>{
  const h=harness(),fixture=existingAppendFixture(h,format);
  await h.api.importFile(fileFor(format,[['unrecognized','not a product header'],['fabricated','invalid']]),{mode:'append'});
  assert.equal(h.api.rows,fixture.dataset);assertExistingAppendState(h,fixture);assert.equal(h.api.state.headers,fixture.state.headers);assert.equal(h.controls.saves.length,0);assert.equal(h.controls.automaticCalls.length,0);assert.equal(h.controls.queueCancels,0);assert.match(h.element('toast').textContent,/失败/);
});

for(const format of ['csv','xlsx'])test(format+' append cancellation during a yielding batch commits no records or state changes',async()=>{
  const h=harness(),fixture=existingAppendFixture(h,format);h.controls.beforeDedup=()=>{h.controls.beforeYield=()=>h.api.cancelImport()};
  await h.api.importFile(fileFor(format,[['Model ID','item_name','backcal_cogs_non_brand'],...Array.from({length:1200},(_,index)=>['NEW-'+index,'Fabricated new product '+index,'10'])]),{mode:'append'});
  assert.equal(h.api.rows,fixture.dataset);assertExistingAppendState(h,fixture);assert.equal(h.api.state.headers,fixture.state.headers);assert.equal(h.controls.saves.length,0);assert.equal(h.controls.automaticCalls.length,0);assert.equal(h.controls.queueCancels,0);assert.match(h.element('toast').textContent,/已取消/);
});

test('the original import call still replaces the table rather than appending',async()=>{
  const h=harness(),old=record(h,'OLD-ONLY','1');h.api.setRows([old]);
  await h.api.importFile(fileFor('csv',[['Model ID','item_name','backcal_cogs_non_brand'],['NEW-ONLY','Replacement product','10']]));
  assert.equal(h.api.rows.length,1);assert.equal(h.api.idFor(h.api.rows[0]),'NEW-ONLY');assert.equal(h.api.rows.includes(old),false);
});

for(const format of ['csv','xlsx'])test('20,000 real '+format+' append rows retain 10,000 originals and add only 5,000 new winners',async()=>{
  const h=harness(),started=performance.now(),base=900719925474099312345n,old=Array.from({length:10000},(_,index)=>record(h,String(base+BigInt(index)),'1',{uid:format+(index+2),raw:{item_name:'Existing '+index},group:'old-group-'+Math.floor(index/3),manualGroup:index%3===0?'old-manual-'+index:'',preTouched:true,preValue:index%2?'N':'Y',preNote:'Keep '+index})),before=plain(old);h.api.setRows(old);
  const matrix=[['Model ID','item_name','model_name','backcal_cogs_non_brand','final_1688_price_moq_3','item_id'],...Array.from({length:20000},(_,index)=>{const id=String(base+BigInt(5000+Math.floor(index/2))),winner=index%2===1;return [id,(winner?'Winning ':'Losing ')+id,(winner?'Winner model ':'Loser model ')+id,winner?'20.004':'20.001',winner?'1':'100',(winner?'WIN-':'LOSE-')+id]})];
  const file=fileFor(format,matrix),prepared=performance.now();await h.api.importFile(file,{mode:'append'});const imported=performance.now();
  assert.equal(h.api.rows.length,15000);for(let index=0;index<10000;index++)assert.equal(h.api.rows[index],old[index]);assert.deepEqual(plain(old),before);
  assert.equal(new Set(Array.from(h.api.rows,row=>row.uid)).size,15000);assert.equal(new Set(Array.from(h.api.rows,row=>h.api.idFor(row))).size,15000);
  for(const row of h.api.rows.slice(10000)){const id=h.api.idFor(row);assert.equal(row.raw.item_name,'Winning '+id);assert.equal(row.raw.model_name,'Winner model '+id);assert.equal(row.raw.item_id,'WIN-'+id);assert.equal(row.raw.backcal_cogs_non_brand,'20.004');assert.equal(row.raw.final_1688_price_moq_3,'1')}
  assert.equal(h.controls.saves.length,1);assert.equal(h.controls.saves[0].length,15000);const report=h.controls.reports.find(item=>item.type==='import'&&item.mode==='append');assert.ok(report);
  for(const [key,value]of Object.entries({rows:15000,sourceRows:20000,addedRows:5000,existingRows:5000,missingIdRows:0,duplicateRows:10000}))assert.equal(report[key],value,key);
  assert.equal(report.reader,format==='csv'?'CSV Worker':'Excel Worker');assert.equal(h.controls.errors.length,0);assert.equal(h.controls.queueCancels,0);
  console.log('Node '+format.toUpperCase()+' append 20,000 → +5,000 / 15,000 total: fixture '+(prepared-started).toFixed(1)+' ms; parse/map/deduplicate/append '+(imported-prepared).toFixed(1)+' ms (offline Worker + fake DOM/save).');
});
