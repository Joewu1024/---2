'use strict';

// Executes the real workbench filter, popup, drawer and export functions with fabricated records.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].at(-1)[1];

function line(prefix) { const found = source.split(/\r?\n/).find(text => text.startsWith(prefix)); assert.ok(found, prefix); return found; }
function fn(name) { const start = source.indexOf('function ' + name + '('); assert.ok(start >= 0, name); return source.slice(start, source.indexOf('\n', start)); }
function between(start, end) { const from = source.indexOf(start), to = source.indexOf(end, from); assert.ok(from >= 0 && to > from, start); return source.slice(from, to); }
const decode = text => String(text).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

class Element {
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.style = {}; this.value = ''; this.textContent = ''; this.disabled = false; this.checked = false; this.removed = false; this.className = ''; this.classList = { contains: value => this.className.split(/\s+/).includes(value) }; }
  setAttribute(name, value) { value = String(value); this.attributes[name] = value; if (name === 'id') this.id = value; if (name === 'class') this.className = value; if (name === 'value') this.value = value; if (name === 'checked') this.checked = true; if (name === 'disabled') this.disabled = true; if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value; }
  append(child) { child.parentElement = this; this.children.push(child); }
  remove() { this.removed = true; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
  getBoundingClientRect() { return { left: 400, right: 520, top: 100, bottom: 124 }; }
  matches(selector) { if (selector.startsWith('#')) return this.id === selector.slice(1); if (selector.startsWith('.')) return this.classList.contains(selector.slice(1)); const match = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/); return !!match && Object.hasOwn(this.attributes, match[1]) && (match[2] === undefined || this.attributes[match[1]] === match[2]); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  set innerHTML(html) {
    this.html = html; this.children = []; const stack = [this];
    for (const match of html.matchAll(/<(\/?)([a-z][\w-]*)([^>]*?)>/gi)) {
      const tag = match[2].toLowerCase();
      if (match[1]) { if (stack.length > 1) stack.pop(); continue; }
      const node = new Element(tag);
      for (const attribute of match[3].matchAll(/([^\s=\/]+)(?:="([^"]*)"|'([^']*)'|=([^\s>]+))?/g)) node.setAttribute(attribute[1], decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? ''));
      stack.at(-1).append(node);
      if (!['input', 'br', 'hr', 'img'].includes(tag)) stack.push(node);
    }
    for (const select of this.querySelectorAll('select')) select.value = '';
    const visit = node => {
      if (node.tagName === 'SELECT') { const options = node.children.filter(child => child.tagName === 'OPTION'); node.value = (options.find(child => Object.hasOwn(child.attributes, 'selected')) || options[0])?.value || ''; }
      node.children.forEach(visit);
    };
    this.children.forEach(visit);
  }
  get innerHTML() { return this.html || ''; }
}

function harness() {
  const body = new Element('body'), elements = new Map(), controls = { renders: 0 };
  const element = id => { if (!elements.has(id)) { const node = new Element(); node.id = id; body.append(node); elements.set(id, node); } return elements.get(id); };
  for (const id of ['search', 'sort', 'overlay', 'result', 'filterBadge', 'filterChips']) element(id);
  element('sort').value = 'desc';
  const document = { body, documentElement: { clientWidth: 1280, clientHeight: 800 }, createElement: tag => new Element(tag), getElementById: id => body.querySelector('#' + id) || element(id), querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector) };
  const extracted = [line('const H='), line('const S='), line('const FIELD='), line('let rows='), line('const rawLookupCache='), line('const keyMap='),
    between('// batch-model-search:start', '// batch-model-search:end'),
    ...['key','getRaw','invalidateRaw','normalizeModelId','round2','format2','calc','value','filterValue','aliasFor','statusValue','statusLines','matchesState','filtered','selectedSummary','activeFilterItems','renderFilterSummary','sorted','recordsGroups'].map(fn),
    between('// filter-conditions:start', '// filter-conditions:end'), between('function filterPopupFrame(', 'function drawer('), fn('drawer'),
    between('function exportRows(', 'function exportCsv('), fn('exportCsv')].join('\n');
  const context = vm.createContext({ document, console, controls, innerWidth: 1280, innerHeight: 800, Blob, setTimeout, clearTimeout });
  const api = vm.runInContext('(function(){' + extracted + '\nfunction render(){controls.renders++}\nreturn {H,FIELD,filtered,matchesState,filterValue,filterFieldType,filterNumericValue,filterConditionDraft,filterConditionLabel,calc,number,value,filterPopup,statusFilterPopup,drawer,activeFilterItems,renderFilterSummary,recordsGroups,exportRows,exportCsv,invalidateRaw,get filters(){return filters},setFilters(next){filters=next},setRows(next){rows=next},get rows(){return rows}}})()', context);
  return { api, controls, document, element, popup: () => document.querySelector('.filterpop') };
}

function record(id, raw = {}, group = 'shared') { return { uid: id, group, excelRow: 2, raw: { 'Model ID': id, ...raw } }; }
const ids = records => Array.from(records, record => record.uid);
const condition = (operator, value, type) => ({ condition: { operator, value, ...(type ? { type } : {}) } });

test('target >=50 uses exact underlying min prices at 49.99/50/50.01 and excludes blank/NaN', () => {
  const h = harness(), f = h.api.H[16];
  h.api.setRows([49.99, 50, 50.01, '', 'bad', 49.9999].map((price, i) => record(String(i), { backcal_cogs_non_brand: price })));
  h.api.setFilters({ [f]: condition('gte', '50') });
  assert.deepEqual(ids(h.api.filtered()), ['1', '2']);
  assert.equal(h.api.filterValue(h.api.rows[5], f), '50.00', 'rounded display deliberately differs from the comparison value');
  h.api.setFilters({[f]:{values:['50.00'],condition:{operator:'gte',value:50}}});
  assert.deepEqual(ids(h.api.filtered()),['1'],'the displayed-value selection and raw numeric condition must both match');
});

test('numeric operators preserve zero, negatives, equality and both inclusive/exclusive boundaries', () => {
  const h = harness(), f = h.api.H[15];
  h.api.setRows([-2, 0, 49.99, 50, 50.01, '', 'NaN'].map((price, i) => record(String(i), { final_1688_price_moq_3: price })));
  for (const [operator, value, expected] of [['<=', 50, ['0','1','2','3']], ['<', 50, ['0','1','2']], ['>', 50, ['4']], ['>=', 0, ['1','2','3','4']], ['equals', '0.0', ['1']], ['not_equals', 0, ['0','2','3','4']]]) {
    h.api.setFilters({ [f]: condition(operator, value) });
    assert.deepEqual(ids(h.api.filtered()), expected, operator);
  }
});

test('NB/1688/target/C8/C8-target each use their genuine numeric source or calculated minimum', () => {
  const h = harness(), r = record('a', { backcal_cogs_non_brand: '100', final_1688_price_moq_3: '40', backcal_cogs_white_label: '70' });
  h.api.setRows([r]);
  for (const [index, expected] of [[13,100],[15,40],[16,40],[17,70],[18,40]]) {
    assert.equal(h.api.filterNumericValue(r,h.api.H[index]), expected);
    h.api.setFilters({ [h.api.H[index]]: condition('equals', expected) });
    assert.deepEqual(ids(h.api.filtered()), ['a']);
  }
  r.raw[h.api.H[15]] = '55'; h.api.invalidateRaw(r);
  h.api.setFilters({ [h.api.H[16]]: condition('gte', 50) });
  assert.deepEqual(ids(h.api.filtered()), ['a']);
  r.raw[h.api.H[15]] = ''; h.api.invalidateRaw(r);
  assert.equal(h.api.calc(r,'_targetNumber'), 100, 'an intentional canonical blank does not revive the imported price alias');
  assert.equal(h.api.calc(r,'_c8targetNumber'), 70);
  h.api.setFilters({[h.api.H[18]]:condition('gte',80)});
  assert.deepEqual(ids(h.api.filtered()),[],'C8 target 70 is distinct from the NB target 100');
});

test('quantity is numeric while Model ID equality preserves leading zeros and textual ranges', () => {
  const h=harness();
  h.api.setRows([record('0002',{[h.api.H[22]]:'2'}),record('2',{[h.api.H[22]]:'10'}),record('A-2',{[h.api.H[22]]:'100'}),record('A2',{[h.api.H[22]]:'bad'})]);
  h.api.setFilters({[h.api.H[22]]:condition('gte',10)});assert.deepEqual(ids(h.api.filtered()),['2','A-2']);
  h.api.setFilters({'Model ID':condition('equals','2')});assert.deepEqual(ids(h.api.filtered()),['2']);
  h.api.setFilters({'Model ID':condition('equals','A-2')});assert.deepEqual(ids(h.api.filtered()),['A-2']);
  h.api.setFilters({'Model ID':condition('contains','A-')});assert.deepEqual(ids(h.api.filtered()),['A-2']);
});

test('text contains/not contains/equals/not equals/empty/nonempty remain literal string comparisons', () => {
  const h=harness(), f=h.api.H[24];
  h.api.setRows([record('a',{[f]:'Alpha-50'}),record('b',{[f]:'Alpha50'}),record('c',{[f]:''}),record('d',{[f]:'beta [50]'})]);
  for(const [operator,value,expected]of [['contains','Alpha-',['a']],['not_contains','Alpha',['c','d']],['equals','alpha-50',['a']],['not_equals','Alpha-50',['b','c','d']],['empty','',['c']],['not_empty','',['a','b','d']],['contains','[50]',['d']]]) {
    h.api.setFilters({[f]:condition(operator,value)});assert.deepEqual(ids(h.api.filtered()),expected,operator);
  }
});

test('image empty conditions use actual image presence while candidate selection keeps its display labels',()=>{
  const h=harness(),main=h.api.H[6],model=h.api.H[7],note=h.api.H[24];
  const empty=record('empty',{[note]:'空白'}),mainOnly=record('main',{[note]:''}),modelOnly=record('model',{model_image:'https://example.test/model.png'});mainOnly.main='https://example.test/main.png';
  h.api.setRows([empty,mainOnly,modelOnly]);
  assert.equal(h.api.filterValue(empty,main),'空白');
  h.api.setFilters({[main]:{values:['空白'],condition:{operator:'empty'}}});assert.deepEqual(ids(h.api.filtered()),['empty','model']);
  h.api.setFilters({[main]:condition('not_empty')});assert.deepEqual(ids(h.api.filtered()),['main']);
  h.api.setFilters({[model]:condition('empty')});assert.deepEqual(ids(h.api.filtered()),['empty']);
  h.api.setFilters({[model]:condition('not_empty')});assert.deepEqual(ids(h.api.filtered()),['main','model']);
  h.api.setFilters({[note]:condition('empty')});assert.deepEqual(ids(h.api.filtered()),['main','model']);
  h.api.setFilters({[note]:condition('equals','空白')});assert.deepEqual(ids(h.api.filtered()),['empty']);
});

test('within-column selected values OR together, AND with legacy query and condition, AND across fields', () => {
  const h=harness(), f=h.api.H[0], price=h.api.H[15];
  h.api.setRows([record('a',{[f]:'alpha-one',[price]:60}),record('b',{[f]:'alpha-two',[price]:49}),record('c',{[f]:'beta',[price]:100}),record('d',{[f]:'alpha-three',[price]:90})]);
  h.api.setFilters({[f]:{values:['alpha-one','alpha-two','beta'],query:'alpha',condition:{operator:'not_contains',value:'two'}},[price]:condition('gte',50)});
  assert.deepEqual(ids(h.api.filtered()),['a']);
  h.api.setFilters({[f]:{query:'alphaone'}});assert.deepEqual(ids(h.api.filtered()),['a'],'legacy query retains its previous normalized matching');
  h.api.setFilters({[f]:{values:[],condition:{operator:'not_empty'}}});assert.deepEqual(ids(h.api.filtered()),[]);
});

test('all seven independent status fields accept conditions without losing cross-field AND', () => {
  const h=harness();h.api.setRows([record('a',{grass_region:'VN',pool_type:'Core'}),record('b',{grass_region:'TH',pool_type:'Core'}),record('c',{grass_region:'TH',pool_type:'Other'})]);
  h.api.setFilters({'status:grass_region':condition('not_contains','VN'),'status:pool_type':condition('equals','Core')});
  assert.deepEqual(ids(h.api.filtered()),['b']);
});

test('filtering and export cover every matching row in collapsed groups without leaking hidden siblings',async()=>{
  const h=harness(), f=h.api.H[16], rows=Array.from({length:180},(_,i)=>record('FICT'+i,{backcal_cogs_non_brand:i},'folded-group'));
  h.api.setRows(rows);h.api.setFilters({[f]:condition('gte',50)});
  const found=h.api.filtered();assert.equal(found.length,130);assert.equal(h.api.recordsGroups(found)[0][1].length,130);
  const exported=h.api.exportRows(found);assert.equal(exported.data.length,130);assert.ok(exported.data.every(row=>Number(String(row[0]).replace('FICT',''))>=50));
  const csv=await h.api.exportCsv(found).text();assert.ok(csv.includes('FICT179'));assert.equal(csv.includes('FICT49,'),false);
});

test('summary labels include operators and clearing a chip removes values/query/condition together',()=>{
  const h=harness(), f=h.api.H[16];h.api.setFilters({[f]:{values:['50.00'],query:'50',condition:{operator:'gte',value:50,type:'number'}},'status:grass_region':condition('not_contains','VN')});
  const labels=Array.from(h.api.activeFilterItems(),entry=>entry.label).join(' ');assert.match(labels,/≥50/);assert.match(labels,/不包含 VN/);assert.match(labels,/包含 50/);
  h.api.renderFilterSummary([],[]);const button=h.document.querySelectorAll('[data-remove-filter]').find(node=>node.dataset.removeFilter===f);assert.ok(button);button.onclick();assert.equal(h.api.filters[f],undefined);
});

test('header condition applies >=50 in one operation while keeping candidates logically separate',()=>{
  const h=harness(), f=h.api.H[16];h.api.setRows([record('a',{[f]:49.99}),record('b',{[f]:50}),record('c',{[f]:50.01})]);
  h.api.filterPopup(f,new Element('button'));const p=h.popup();assert.ok(p.querySelector('.filter-popup-head'));assert.ok(p.querySelector('.filter-popup-values'));assert.ok(p.querySelector('.filter-actions'));
  p.querySelector('#fvOperator').value='gte';p.querySelector('#fvOperator').onchange();p.querySelector('#fvValue').value='50';p.querySelector('#fvApply').onclick();
  assert.equal(p.removed,true);assert.equal(h.api.filters[f].condition.operator,'gte');assert.equal(h.api.filters[f].condition.value,50);assert.deepEqual(ids(h.api.filtered()),['b','c']);assert.equal(h.controls.renders,1);
});

for(const input of ['abc','NaN','Infinity','--2','1,2',''])test('invalid numeric condition stays open and does not commit: '+JSON.stringify(input),()=>{
  const h=harness(), f=h.api.H[16];h.api.setRows([record('a',{[f]:50})]);h.api.filterPopup(f,new Element());const p=h.popup();p.querySelector('#fvOperator').value='gte';p.querySelector('#fvOperator').onchange();p.querySelector('#fvValue').value=input;p.querySelector('#fvApply').onclick();
  assert.equal(p.removed,false);assert.ok(p.querySelector('#fvError').textContent);assert.equal(h.api.filters[f],undefined);assert.equal(h.controls.renders,0);
});

test('negative and zero UI operands are valid and Model ID UI never offers numeric order operators',()=>{
  const h=harness(), f=h.api.H[15];
  for(const value of ['0','-2.5']){h.api.filterPopup(f,new Element());const p=h.popup();p.querySelector('#fvOperator').value='lte';p.querySelector('#fvValue').value=value;p.querySelector('#fvApply').onclick();assert.equal(h.api.filters[f].condition.value,Number(value))}
  h.api.filterPopup('Model ID',new Element());assert.equal(h.popup().querySelector('#fvOperator').children.some(option=>option.value==='gte'),false);
  assert.ok(h.api.filterConditionDraft('gte','2','text').error);
});

test('existing query plus condition is visible and both survive applying the header popup',()=>{
  const h=harness(), f=h.api.H[16];h.api.setFilters({[f]:{query:'5',condition:{operator:'gte',value:50,type:'number'}}});h.api.filterPopup(f,new Element());const p=h.popup();assert.match(p.innerHTML,/已有包含条件/);assert.equal(p.querySelector('#fvContains').value,'5');p.querySelector('#fvApply').onclick();assert.equal(h.api.filters[f].query,'5');assert.equal(h.api.filters[f].condition.operator,'gte');
});

test('drawer query clearing preserves condition and selected values, including empty selections',()=>{
  const h=harness(), f=h.api.H[16];h.api.setFilters({[f]:{query:'5',values:[],condition:{operator:'gte',value:50,type:'number'}}});h.api.drawer('filter');const input=h.document.querySelectorAll('[data-dfilter]').find(node=>node.dataset.dfilter===f);input.value='';input.oninput();assert.equal(h.api.filters[f].query,undefined);assert.equal(h.api.filters[f].condition.operator,'gte');assert.equal(h.api.filters[f].values.length,0);
});

test('status popup commits each text condition atomically and retains independent AND',()=>{
  const h=harness();h.api.setRows([record('a',{pool_type:'Core',grass_region:'VN'}),record('b',{pool_type:'Core',grass_region:'TH'})]);h.api.statusFilterPopup(new Element());const p=h.popup();p.querySelector('#sf0Operator').value='equals';p.querySelector('#sf0Value').value='Core';p.querySelector('#sf3Operator').value='not_contains';p.querySelector('#sf3Value').value='VN';p.querySelector('#statusApply').onclick();assert.deepEqual(ids(h.api.filtered()),['b']);assert.equal(h.api.filters['status:pool_type'].condition.operator,'equals');
});

test('one invalid status condition prevents a partial commit of the other six fields',()=>{
  const h=harness();h.api.statusFilterPopup(new Element());const p=h.popup();p.querySelector('#sf0Operator').value='contains';p.querySelector('#sf0Value').value='Core';p.querySelector('#sf1Operator').value='contains';p.querySelector('#sf1Value').value='';p.querySelector('#statusApply').onclick();assert.equal(Object.keys(h.api.filters).length,0);assert.equal(p.removed,false);assert.ok(p.querySelector('#sf1Error').textContent);
});

test('clear-column removes the whole condition and stale popup cannot filter a replacement dataset',()=>{
  const h=harness(), f=h.api.H[16];h.api.setFilters({[f]:condition('gte',50)});h.api.filterPopup(f,new Element());h.popup().querySelector('#fvClear').onclick();assert.equal(h.api.filters[f],undefined);
  h.api.filterPopup(f,new Element());const p=h.popup();p.querySelector('#fvOperator').value='gte';p.querySelector('#fvValue').value='50';h.api.setRows([record('replacement',{[f]:100})]);p.querySelector('#fvApply').onclick();assert.equal(h.api.filters[f],undefined);assert.equal(p.removed,true);
});

test('the dedicated popup layout gives candidates the scrolling area and keeps footer outside it',()=>{
  assert.match(page,/\.filterpop\.filter-condition-popup\{[^}]*display:flex;[^}]*overflow:hidden/);
  assert.match(page,/\.filter-condition-popup \.filter-popup-values\{[^}]*overflow:auto/);
  assert.match(page,/\.filter-condition-popup \.filter-actions\{position:static;flex:0 0 auto/);
});
