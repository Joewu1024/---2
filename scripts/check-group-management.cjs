'use strict';

// Actual group/merge functions share the feature suite's fake IndexedDB.
// The DOM and layout below are simulated; scrolling checks are structural.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {test}=require('node:test');
const {harness,record,ids,plain}=require('./check-workbench-features.cjs');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const decode=text=>String(text).replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
class MiniEvent{
  constructor(type,options={}){this.type=type;this.bubbles=!!options.bubbles;Object.assign(this,options)}
  preventDefault(){this.defaultPrevented=true}stopPropagation(){this.stopped=true}
}
class EventTarget{
  constructor(){this.listeners=new Map()}
  addEventListener(type,callback){const callbacks=this.listeners.get(type)||[];callbacks.push(callback);this.listeners.set(type,callbacks)}
  removeEventListener(type,callback){this.listeners.set(type,(this.listeners.get(type)||[]).filter(value=>value!==callback))}
  dispatchEvent(event){if(!event.target)event.target=this;for(let node=this;node;node=event.bubbles?node.parent:null){event.currentTarget=node;for(const callback of node.listeners.get(event.type)||[])callback.call(node,event);node['on'+event.type]?.(event);if(event.stopped)break}return !event.defaultPrevented}
}
function matches(element,selector){
  if(!element.tagName)return false;
  if(selector.includes(','))return selector.split(',').some(part=>matches(element,part.trim()));
  for(const match of selector.matchAll(/\[([^=\]\s]+)(?:\s*=\s*["']?([^\]"']*)["']?)?\]/g))if(!element.hasAttribute(match[1])||(match[2]!==undefined&&element.getAttribute(match[1])!==match[2]))return false;
  const simple=selector.replace(/\[[^\]]+\]/g,''),id=simple.match(/#([\w-]+)/);if(id&&id[1]!==element.id)return false;
  for(const match of simple.matchAll(/\.([\w-]+)/g))if(!element.classList.contains(match[1]))return false;
  const tag=simple.match(/^[\w-]+/);return !tag||element.tagName.toLowerCase()===tag[0].toLowerCase();
}
function inlineStyle(){const style={setProperty(name,value){this[name.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=value}};let css='';Object.defineProperty(style,'cssText',{get(){return css},set(value){css=String(value);for(const entry of css.split(';')){const at=entry.indexOf(':');if(at>0)style.setProperty(entry.slice(0,at).trim(),entry.slice(at+1).trim())}}});return style}
class Element extends EventTarget{
  constructor(tag,document){super();Object.assign(this,{tagName:tag.toUpperCase(),ownerDocument:document,parent:null,children:[],attributes:{},dataset:{},style:inlineStyle(),className:'',id:'',value:'',disabled:false,hidden:false,scrollTop:0,_text:''})}
  get parentElement(){return this.parent instanceof Element?this.parent:null}
  get isConnected(){let node=this;while(node.parent)node=node.parent;return node===this.ownerDocument}
  get classList(){return {contains:name=>this.className.split(/\s+/).includes(name),add:(...names)=>{this.className=[...new Set(this.className.split(/\s+/).filter(Boolean).concat(names))].join(' ')},remove:(...names)=>{this.className=this.className.split(/\s+/).filter(name=>!names.includes(name)).join(' ')},toggle:(name,force)=>{const next=force===undefined?!this.classList.contains(name):!!force;next?this.classList.add(name):this.classList.remove(name);return next}}}
  append(...children){for(const child of children){child.remove?.();child.parent=this;this.children.push(child)}}
  appendChild(child){this.append(child);return child}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null}
  contains(target){return this===target||this.children.some(child=>child.contains(target))}
  setAttribute(name,value){const text=String(value);this.attributes[name]=text;if(name==='id')this.id=text;if(name==='class')this.className=text;if(name==='value')this.value=text;if(name==='disabled')this.disabled=true;if(name==='hidden')this.hidden=true;if(name==='style')this.style.cssText=text;if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=text}
  getAttribute(name){return this.attributes[name]??null}hasAttribute(name){return Object.hasOwn(this.attributes,name)}
  removeAttribute(name){delete this.attributes[name];if(name==='disabled')this.disabled=false;if(name==='hidden')this.hidden=false}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(matches(child,selector)?[child]:[]),...child.querySelectorAll(selector)])}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null}
  closest(selector){for(let node=this;node instanceof Element;node=node.parent)if(matches(node,selector))return node;return null}
  focus(){this.ownerDocument.activeElement=this}select(){this.selectionStart=0;this.selectionEnd=this.value.length}scrollIntoView(){}
  click(){if(!this.disabled)this.dispatchEvent(new MiniEvent('click',{bubbles:true}))}
  getBoundingClientRect(){return {left:40,right:600,top:100,bottom:548,width:560,height:448}}
  get clientHeight(){return parseFloat(this.style.height)||448}get clientWidth(){return 560}
  get scrollHeight(){return Math.max(this.clientHeight,...this.children.map(child=>parseFloat(child.style.height)||0))}
  set textContent(value){for(const child of this.children)child.parent=null;this.children=[];this._text=String(value)}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('')}
  set innerHTML(value){
    this._html=String(value);for(const child of this.children)child.parent=null;this.children=[];this._text='';const stack=[this];
    for(const token of this._html.matchAll(/<\/?([a-z][a-z0-9-]*)\b([^>]*)>|([^<]+)/gi)){
      if(token[3]){stack.at(-1)._text+=decode(token[3]);continue}if(token[0].startsWith('</')){if(stack.length>1)stack.pop();continue}
      const child=new Element(token[1],this.ownerDocument);for(const attr of token[2].matchAll(/([\w-]+)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)'|\s*=\s*([^\s>]+))?/g))child.setAttribute(attr[1],decode(attr[2]??attr[3]??attr[4]??''));stack.at(-1).append(child);
      if(!['input','img','br','hr','meta','link'].includes(token[1].toLowerCase())&&!/\/\s*>$/.test(token[0]))stack.push(child);
    }
  }
  get innerHTML(){return this._html||''}
}
class Document extends EventTarget{
  constructor(){super();this.children=[];this.body=new Element('body',this);this.body.parent=this;this.children.push(this.body);this.documentElement={clientWidth:1400,clientHeight:900};this.activeElement=null}
  createElement(tag){return new Element(tag,this)}
  getElementById(id){return this.body.querySelector('#'+id)}querySelector(selector){return this.body.querySelector(selector)}querySelectorAll(selector){return this.body.querySelectorAll(selector)}
}
function setup(options={}){
  const document=new Document(),markup=html.slice(0,html.indexOf('<script data-buyer-translation-engine'));
  for(const match of markup.matchAll(/\bid="([^"]+)"/g)){const element=document.createElement('div');element.id=match[1];document.body.append(element)}
  const h=harness({...options,document,window:new EventTarget(),Event:MiniEvent,stubRender:true});
  assert.equal(typeof h.api.openMergePreview,'function','actual merge preview is included in the shared harness');assert.equal(typeof h.api.getGroupName,'function','actual group-name helpers are included');
  return {...h,document};
}
function fixture(h){
  return [
    Object.assign(record(h,'10001',{[h.api.H[0]]:'是'}),{uid:'first',group:'group-A',groupName:'既有组A',modelImage:'https://images.example.test/sku-first.png',main:'https://images.example.test/main-first.png'}),
    Object.assign(record(h,'10002',{[h.api.H[0]]:'否'}),{uid:'second',group:'group-A',groupName:'既有组A',main:'https://images.example.test/main-second.png'}),
    Object.assign(record(h,'20001',{[h.api.H[0]]:'是'}),{uid:'third',group:'group-B',groupName:'既有组B',modelImage:'https://images.example.test/sku-third.png'}),
    Object.assign(record(h,'20002',{[h.api.H[0]]:'是'}),{uid:'fourth',group:'group-B',groupName:'既有组B'})
  ];
}
function clickConfirm(h,name='新合并产品组'){h.document.getElementById('mergeGroupName').value=name;h.document.getElementById('confirmMerge').click()}
function assertUnchanged(h,rows,before){assert.deepEqual(plain(rows),before);assert.equal(h.db.stores.records.size,0);assert.equal(h.db.transactions.length,0)}
function mountIdRow(h,row,count,gid,isChild=false){
  h.document.getElementById('groupUiFixture')?.remove();const host=h.document.createElement('div');host.id='groupUiFixture';
  host.innerHTML=h.api.rowHtml(row,[{h:'Model ID',k:'id',display:'Model ID'},{h:'勾选',k:'select',display:'勾选'}],count,gid,isChild);h.document.body.append(host);h.api.bindTable();h.api.updateSelectionUI();return host;
}

test('every singleton hides all group controls while retaining its group metadata and individual model selector',()=>{
  for(const kind of ['image','manual','ungrouped','separate','missing','legacy']){
    const h=setup(),row=record(h,'12345');row.groupName='保留的单例名称';if(kind==='image')row.group='IMG-0001';else if(kind==='manual'){row.group='manual-one';row.manualGroup='manual-one'}else if(kind==='ungrouped')row.group='UNGROUPED-'+row.uid;else if(kind==='separate')row.group='单独-'+row.uid;else if(kind==='missing')delete row.group;else row.group=row.uid;
    h.api.setRows([row]);const before=plain(row),host=mountIdRow(h,row,1,row.manualGroup||row.group||row.uid);
    for(const selector of ['[data-product-group]','[data-rename-group]','[data-toggle]','[data-select-group]'])assert.equal(host.querySelector(selector),null,kind+' singleton '+selector);
    assert.equal(host.querySelectorAll('[data-select]').length,1);assert.equal(host.querySelectorAll('[data-share]').length,1);assert.doesNotMatch(host.textContent,/保留的单例名称|同组型号|整组选中/);assert.deepEqual(plain(row),before);
  }
});

test('one visible model from an eleven-model group retains one compact full-group control and only the filtered-hidden note',()=>{
  const h=setup(),rows=Array.from({length:11},(_,index)=>Object.assign(record(h,String(10001+index)),{group:'eleven-group',groupName:'十一款组'}));h.api.setRows(rows);h.api.setFilters({'Model ID':{values:['10001']}});
  const host=mountIdRow(h,rows[0],1,'eleven-group'),control=host.querySelector('[data-product-group]');assert.ok(control);assert.equal(host.querySelectorAll('[data-product-group]').length,1);assert.equal(control.tagName,'DIV');
  const checkbox=control.querySelector('[data-select-group]'),name=control.querySelector('[data-rename-group]');assert.equal(checkbox.getAttribute('aria-label'),'整组选中 10001，共 11 款');assert.equal(name.getAttribute('aria-label'),'修改组名称 十一款组');assert.equal(name.textContent,'十一款组 · 11 款');assert.equal(control.querySelector('[data-toggle]'),null);
  assert.match(host.querySelector('.group-selection-note').textContent,/10/);assert.doesNotMatch(control.textContent,/整组选中|同组型号|改名/);assert.equal(checkbox.parentElement,control);assert.equal(name.parentElement,control);assert.equal(name.closest('label'),null);
  checkbox.checked=true;checkbox.dispatchEvent(new MiniEvent('change'));assert.deepEqual([...h.api.selected].sort(),rows.map(row=>row.uid).sort());
  h.api.setFilters({});const full=mountIdRow(h,rows[0],11,'eleven-group');assert.equal(full.querySelector('.group-selection-note'),null);assert.ok(full.querySelector('[data-toggle]'));
});

test('the compact name, count and accessible labels escape exact custom names and keep all actions as siblings',()=>{
  const h=setup(),name='精选 "A&B" <img> 单引号\'',gid='group-"<&>',rows=[record(h,'10001'),record(h,'10002')];for(const row of rows){row.group=gid;row.groupName=name}h.api.setRows(rows);
  const host=mountIdRow(h,rows[0],2,gid),control=host.querySelector('[data-product-group]'),label=control.querySelector('[data-rename-group]'),checkbox=control.querySelector('[data-select-group]'),toggle=control.querySelector('[data-toggle]');
  assert.equal(control.dataset.productGroup,gid);assert.equal(label.dataset.renameGroup,gid);assert.equal(checkbox.dataset.selectGroup,gid);assert.equal(toggle.dataset.toggle,gid);
  assert.equal(label.textContent,name+' · 2 款');assert.equal(label.querySelector('.product-group-text').textContent,name);assert.equal(label.querySelector('.product-group-count').textContent,' · 2 款');assert.equal(label.getAttribute('aria-label'),'修改组名称 '+name);assert.equal(toggle.getAttribute('aria-label'),'展开组 '+name);assert.equal(checkbox.getAttribute('aria-label'),'整组选中 10001，共 2 款');
  assert.equal(label.parentElement,control);assert.equal(checkbox.parentElement,control);assert.equal(toggle.parentElement,control);assert.equal(control.tagName,'DIV');assert.equal(host.querySelector('img'),null);assert.doesNotMatch(control.textContent,/整组选中|同组型号|改名/);
  const child=mountIdRow(h,rows[1],2,gid,true);assert.equal(child.querySelector('[data-product-group]'),null);assert.doesNotMatch(child.textContent,/同组展开明细|同组型号/);
});

test('generated group names use the compact default caption while custom names with the same prefix stay intact',()=>{
  const h=setup(),rows=[record(h,'10001'),record(h,'10002')];rows.forEach(row=>row.group='IMG-default');h.api.setRows(rows);const fullName=h.api.getGroupName(rows[0]),host=mountIdRow(h,rows[0],2,'IMG-default'),button=host.querySelector('[data-rename-group]');
  assert.equal(button.textContent,'产品组 · 2 款');assert.equal(button.getAttribute('aria-label'),'修改组名称 '+fullName);assert.ok(button.getAttribute('title').startsWith(fullName));
  h.api.renameProductGroup('IMG-default',fullName);assert.equal(mountIdRow(h,rows[0],2,'IMG-default').querySelector('[data-rename-group]').textContent,'产品组 · 2 款');assert.equal(rows[0].groupName,fullName,'saved generated captions remain intact while their display is compact');
  h.api.renameProductGroup('IMG-default','产品组-用户自定义');const custom=mountIdRow(h,rows[0],2,'IMG-default').querySelector('[data-rename-group]');assert.equal(custom.textContent,'产品组-用户自定义 · 2 款');
});

test('name clicks only rename, chevrons only expand and group checkboxes retain partial and complete selection',()=>{
  const h=setup(),rows=fixture(h);h.api.setRows(rows);h.api.setSelected(['first']);const host=mountIdRow(h,rows[0],2,'group-A'),control=host.querySelector('[data-product-group]'),checkbox=control.querySelector('[data-select-group]'),label=control.querySelector('[data-rename-group]'),toggle=control.querySelector('[data-toggle]');
  assert.equal(checkbox.checked,false);assert.equal(checkbox.indeterminate,true);assert.equal(checkbox.getAttribute('aria-checked'),'mixed');assert.ok(control.classList.contains('is-partial'));
  label.click();assert.ok(h.document.getElementById('renameGroupBackdrop'));assert.deepEqual([...h.api.selected],['first']);assert.equal(h.api.opened.has('group-A'),false);h.document.getElementById('cancelRenameGroup').click();
  toggle.click();assert.equal(h.api.opened.has('group-A'),true);assert.deepEqual([...h.api.selected],['first']);assert.equal(h.document.getElementById('renameGroupBackdrop'),null);
  const opened=mountIdRow(h,rows[0],2,'group-A');assert.equal(opened.querySelector('[data-toggle]').getAttribute('aria-label'),'收起组 既有组A');const all=opened.querySelector('[data-select-group]');all.checked=true;all.dispatchEvent(new MiniEvent('change'));
  assert.deepEqual([...h.api.selected].sort(),['first','second']);assert.equal(all.checked,true);assert.equal(all.indeterminate,false);assert.ok(opened.querySelector('[data-product-group]').classList.contains('is-selected'));assert.equal(h.api.opened.has('group-A'),true);assert.equal(h.document.getElementById('renameGroupBackdrop'),null);
  all.checked=false;all.dispatchEvent(new MiniEvent('change'));assert.equal(h.api.selected.size,0);assert.equal(h.api.opened.has('group-A'),true);
});

test('read-only group controls disable selection and renaming while leaving the chevron available for inspection',()=>{
  for(const mode of ['history','ownership']){const h=setup(),rows=fixture(h);h.api.setRows(rows);h.api.setSelected(['first']);if(mode==='history')h.api.setHistory(true);else h.controls.writable=false;
    const host=mountIdRow(h,rows[0],2,'group-A'),checkbox=host.querySelector('[data-select-group]'),name=host.querySelector('[data-rename-group]'),toggle=host.querySelector('[data-toggle]');assert.equal(checkbox.disabled,true);assert.equal(name.disabled,true);assert.equal(toggle.disabled,false);
    name.click();checkbox.click();assert.equal(h.document.getElementById('renameGroupBackdrop'),null);assert.deepEqual([...h.api.selected],['first']);toggle.click();assert.equal(h.api.opened.has('group-A'),true);assert.deepEqual([...h.api.selected],['first']);assert.equal(h.db.transactions.length,0);
  }
});

test('opening and cancelling the visible merge preview shows selected SKU images, IDs and source names without committing',()=>{
  const h=setup(),rows=fixture(h);h.api.setRows(rows);h.api.setSelected(['first','third']);const before=plain(rows);
  h.element('merge').onclick();assertUnchanged(h,rows,before);assert.deepEqual([...h.api.selected],['first','third']);
  const dialog=h.document.querySelector('[role="dialog"]');assert.ok(dialog);assert.equal(dialog.getAttribute('aria-labelledby'),'mergePreviewTitle');
  const items=h.document.getElementById('mergePreviewItems');assert.match(items.textContent,/10001/);assert.match(items.textContent,/20001/);assert.match(items.textContent,/既有组A/);assert.match(items.textContent,/既有组B/);assert.doesNotMatch(items.textContent,/10002|20002/);
  const images=items.querySelectorAll('img').map(image=>image.getAttribute('src'));assert.ok(images.includes(rows[0].modelImage));assert.equal(images.includes(rows[0].main),false);
  h.document.getElementById('cancelMerge').click();assert.equal(h.document.getElementById('mergePreviewBackdrop'),null);assertUnchanged(h,rows,before);assert.deepEqual([...h.api.selected],['first','third']);
});

test('confirming merges only the selected models under the chosen name, saves them and consumes double clicks',async()=>{
  const h=setup(),rows=fixture(h);h.api.setRows(rows);h.api.setSelected(['first','third']);h.api.openMergePreview();const confirm=h.document.getElementById('confirmMerge');clickConfirm(h,'  中文产品组  ');confirm.click();
  assert.equal(rows[0].manualGroup,rows[2].manualGroup);assert.ok(rows[0].manualGroup);assert.equal(h.api.getGroupName(rows[0]),'中文产品组');assert.equal(h.api.getGroupName(rows[2]),'中文产品组');
  assert.equal(rows[1].group,'group-A');assert.equal(rows[1].groupName,'既有组A');assert.equal(rows[3].group,'group-B');assert.equal(rows[3].groupName,'既有组B');assert.equal(h.api.selected.size,0);assert.equal(h.controls.renders,1);
  await h.api.flushSave();assert.equal(h.db.stores.records.get('first').groupName,'中文产品组');assert.equal(h.db.stores.records.get('third').groupName,'中文产品组');assert.equal(h.db.stores.records.has('second'),false);
});

test('selected members hidden by filters or collapsed groups remain in the full preview and confirmation',()=>{
  const h=setup(),rows=fixture(h);h.api.setRows(rows);h.api.setFilters({'Model ID':{values:['10001']}});h.api.setOpened([]);h.api.setSelected(['first','second','third']);h.api.openMergePreview();
  const items=h.document.getElementById('mergePreviewItems');for(const id of ['10001','10002','20001'])assert.ok(items.textContent.includes(id));assert.match(h.document.getElementById('mergePreviewRange').textContent,/3/);
  clickConfirm(h,'含隐藏款的组');assert.equal(new Set(rows.slice(0,3).map(row=>row.manualGroup)).size,1);assert.ok(rows.slice(0,3).every(row=>row.groupName==='含隐藏款的组'));assert.equal(rows[3].manualGroup,undefined);
});

for(const changed of ['dataset','same-uid-object','selection','source-group','source-id','workspace','history','ownership','import'])test('an old confirm cannot commit after '+changed+' changes',()=>{
  const h=setup(),rows=fixture(h);h.api.setRows(rows);h.api.setSelected(['first','third']);h.api.openMergePreview();const before=plain(rows),confirm=h.document.getElementById('confirmMerge');
  if(changed==='dataset')h.api.setRows(rows.slice());else if(changed==='same-uid-object')h.api.rows[0]={...rows[0],raw:{...rows[0].raw}};else if(changed==='selection')h.api.setSelected(['first','fourth']);else if(changed==='source-group')rows[0].group='changed-source-group';else if(changed==='source-id')rows[0].raw['Model ID']='CHANGED-SOURCE-ID';else if(changed==='workspace')h.api.setWorkspace({dbName:()=> 'other-workspace',storageKey:key=>'other:'+key});else if(changed==='history')h.api.setHistory(true);else if(changed==='ownership')h.controls.writable=false;else h.api.importFile.running=true;
  const afterSteering=changed==='source-group'||changed==='source-id'?plain(rows):before;confirm.click();assertUnchanged(h,rows,afterSteering);assert.ok(rows.every(row=>!row.manualGroup));
});

test('a newer preview invalidates the previous dialog confirm while live translation edits remain allowed',()=>{
  const h=setup(),rows=fixture(h);h.api.setRows(rows);h.api.setSelected(['first','third']);h.api.openMergePreview();const oldConfirm=h.document.getElementById('confirmMerge');
  h.api.setSelected(['second','fourth']);h.api.openMergePreview();oldConfirm.click();assert.ok(rows.every(row=>!row.manualGroup));
  rows[1].raw[h.api.H[10]]='后台自动回填标题';rows[3].raw[h.api.H[12]]='后台自动回填型号';clickConfirm(h,'当前弹窗组');
  assert.equal(rows[1].manualGroup,rows[3].manualGroup);assert.equal(rows[0].manualGroup,undefined);assert.equal(rows[2].manualGroup,undefined);
});

test('20,000 selected models use a bounded scroll window while the final model stays reachable',()=>{
  const h=setup(),base=900719925474099312345n,rows=Array.from({length:20000},(_,index)=>Object.assign(record(h,String(base+BigInt(index))),{uid:'large-'+index,excelRow:index+2,group:'source-'+Math.floor(index/10),groupName:'源组 '+Math.floor(index/10)}));h.api.setRows(rows);h.api.setSelected(rows.map(row=>row.uid));h.api.setFilters({'Model ID':{values:[String(base)]}});h.api.openMergePreview();
  const viewport=h.document.getElementById('mergePreviewViewport'),space=h.document.getElementById('mergePreviewSpace'),items=h.document.getElementById('mergePreviewItems'),range=h.document.getElementById('mergePreviewRange');
  assert.ok(viewport);assert.equal(Number.parseFloat(space.style.height),20000*112);assert.match(range.textContent.replace(/,/g,''),/20000/);assert.ok(items.children.length>0&&items.children.length<50);assert.ok(items.textContent.includes(String(base)));
  viewport.scrollTop=20000*112-448;viewport.dispatchEvent(new MiniEvent('scroll'));assert.ok(items.children.length<50);assert.ok(items.textContent.includes(String(base+19999n)));assert.match(range.textContent.replace(/,/g,''),/20000/);
  assert.ok(h.document.getElementById('confirmMerge'));assert.ok(h.document.getElementById('cancelMerge'));h.document.getElementById('cancelMerge').click();assert.equal(h.api.selected.size,20000);assert.equal(h.db.transactions.length,0);
});

test('invalid long group names cannot consume a preview and valid Unicode names remain usable',()=>{
  const h=setup(),rows=fixture(h);h.api.setRows(rows);h.api.setSelected(['first','third']);h.api.openMergePreview();clickConfirm(h,'😀'.repeat(81));
  assert.ok(rows.every(row=>!row.manualGroup));assert.ok(h.document.getElementById('mergePreviewBackdrop'));assert.ok(h.document.getElementById('mergePreviewError').textContent);
  const name='😀'.repeat(80);clickConfirm(h,name);assert.equal(h.api.getGroupName(rows[0]),name);
});

test('renaming affects the full underlying group, preserves its ID and participates in name-only AND filtering',async()=>{
  const h=setup(),rows=fixture(h);h.api.setRows(rows);h.api.setFilters({'Model ID':{values:['10001']}});assert.equal(h.api.renameProductGroup('group-A','  周末优选  '),2);
  assert.ok(rows.slice(0,2).every(row=>row.group==='group-A'&&row.groupName==='周末优选'));assert.ok(rows.slice(2).every(row=>row.groupName==='既有组B'));
  h.api.setFilters({__groupName:{query:'周末'},[h.api.H[0]]:{values:['是']}});assert.deepEqual(ids(h.api.filtered()),['first']);
  h.api.setFilters({__groupName:{values:['周末优选']}});assert.deepEqual(ids(h.api.filtered()),['first','second']);h.element('search').value='周末优选';assert.deepEqual(ids(h.api.filtered()),['first','second']);
  await h.api.flushSave();assert.equal(h.db.stores.records.get('first').groupName,'周末优选');assert.equal(h.db.stores.records.get('second').groupName,'周末优选');
});

test('same display names do not merge separate groups and empty renames restore a stable legacy default',()=>{
  const h=setup(),rows=fixture(h);h.api.setRows(rows);h.api.renameProductGroup('group-A','同名组');h.api.renameProductGroup('group-B','同名组');assert.equal(h.api.recordsGroups(rows).length,2);
  h.api.renameProductGroup('group-A','');const before=h.api.getGroupName(rows[0]);assert.ok(before);assert.equal(h.api.getGroupName(rows[1]),before);assert.notEqual(before,'同名组');
  h.api.setFilters({'Model ID':{values:['10002']}});h.element('sort').value='asc';assert.equal(h.api.getGroupName(rows[1]),before);assert.equal(h.api.getGroupName({...record(h,'legacy'),group:'UNGROUPED-legacy'}),'');
});

test('group names persist through historical snapshots and reject read-only, importing and invalid rename requests',async()=>{
  const h=setup(),rows=fixture(h);h.api.setRows(rows);h.api.renameProductGroup('group-A','已保存组名');await h.api.saveVersion();const [version]=await h.api.listVersions();h.api.renameProductGroup('group-A','当前新组名');
  assert.equal((await h.api.readVersion(version.id)).rows[0].groupName,'已保存组名');
  for(const changed of ['history','ownership','import','invalid']){const before=plain(rows);if(changed==='history')h.api.setHistory(true);if(changed==='ownership')h.controls.writable=false;if(changed==='import')h.api.importFile.running=true;assert.throws(()=>h.api.renameProductGroup('group-A',changed==='invalid'?'名'.repeat(81):'不应写入'));assert.deepEqual(plain(rows),before);h.api.setHistory(false);h.controls.writable=true;h.api.importFile.running=false}
});

test('the row rename button opens a full-group editor and saves hidden members through the actual dialog',async()=>{
  const h=setup(),rows=fixture(h);h.api.setRows(rows);h.api.setFilters({'Model ID':{values:['10001']}});
  const host=h.document.createElement('div');host.innerHTML=h.api.rowHtml(rows[0],[{h:'Model ID',k:'id',display:'Model ID'}],2,'group-A',false);h.document.body.append(host);h.api.bindTable();const button=host.querySelector('[data-rename-group]');assert.ok(button);button.click();
  assert.ok(h.document.getElementById('renameGroupBackdrop'));assert.match(h.document.getElementById('renameGroupBackdrop').textContent,/2/);h.document.getElementById('renameGroupName').value='对话框保存的组';h.document.getElementById('saveGroupName').click();
  assert.equal(h.document.getElementById('renameGroupBackdrop'),null);assert.ok(rows.slice(0,2).every(row=>row.groupName==='对话框保存的组'));assert.ok(rows.slice(2).every(row=>row.groupName==='既有组B'));
  await h.api.flushSave();assert.equal(h.db.stores.records.get('second').groupName,'对话框保存的组');
});

test('a rename dialog refuses a stale group whose hidden membership changed',()=>{
  const h=setup(),rows=fixture(h);h.api.setRows(rows);h.api.setFilters({'Model ID':{values:['10001']}});h.api.openRenameGroupDialog('group-A');
  rows[1].group='moved-away';const before=plain(rows);h.document.getElementById('renameGroupName').value='不得应用旧组';h.document.getElementById('saveGroupName').click();
  assertUnchanged(h,rows,before);assert.ok(h.document.getElementById('renameGroupError').textContent);h.document.getElementById('cancelRenameGroup').click();assert.equal(h.document.getElementById('renameGroupBackdrop'),null);
});

test('the group-name filter offers only group candidates and applies selected, contains and exact-name conditions',()=>{
  const h=setup({realFilters:true}),rows=fixture(h),ungrouped=Object.assign(record(h,'30000',{item_name:'蓝色 套装'}),{uid:'ungrouped',group:'UNGROUPED-ungrouped'});h.api.setRows([...rows,ungrouped]);h.api.renameProductGroup('group-A','蓝色 套装');h.api.renameProductGroup('group-B','红色 套装');
  h.api.filterPopup('__groupName',h.element('merge'));let popup=h.document.querySelector('.filterpop');assert.match(popup.textContent,/组名称/);assert.deepEqual(popup.querySelectorAll('[data-fv]').map(input=>input.dataset.fv).sort(),['','红色 套装','蓝色 套装'].sort());
  popup.querySelector('#fvNone').click();const selected=popup.querySelectorAll('[data-fv]').find(input=>input.dataset.fv==='蓝色 套装');selected.checked=true;selected.dispatchEvent(new MiniEvent('change'));popup.querySelector('#fvApply').click();assert.deepEqual(ids(h.api.filtered()),['first','second']);
  h.api.setFilters({});h.api.filterPopup('__groupName',h.element('merge'));popup=h.document.querySelector('.filterpop');popup.querySelector('#fvOperator').value='contains';popup.querySelector('#fvOperator').dispatchEvent(new MiniEvent('change'));popup.querySelector('#fvValue').value='套装';popup.querySelector('#fvApply').click();assert.deepEqual(ids(h.api.filtered()),['first','second','third','fourth']);
  h.api.filterPopup('__groupName',h.element('merge'));popup=h.document.querySelector('.filterpop');popup.querySelector('#fvOperator').value='equals';popup.querySelector('#fvOperator').dispatchEvent(new MiniEvent('change'));popup.querySelector('#fvValue').value='蓝色 套装';popup.querySelector('#fvApply').click();assert.deepEqual(ids(h.api.filtered()),['first','second']);
  const found=h.api.filtered();h.api.renderFilterSummary(found,h.api.recordsGroups(found));assert.match(h.element('filterChips').innerHTML,/组名称/);assert.match(h.element('filterChips').innerHTML,/蓝色 套装/);
  h.api.setFilters({});h.api.drawer('filter');const groupInput=h.document.querySelectorAll('[data-dfilter]').find(input=>input.dataset.dfilter==='__groupName');assert.ok(groupInput);groupInput.value='蓝色';groupInput.dispatchEvent(new MiniEvent('input'));assert.deepEqual(ids(h.api.filtered()),['first','second']);
});

test('the merge preview reserves scrollable content between fixed dialog header and footer',()=>{
  const styles=Array.from(html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi),match=>match[1]).join('\n');const rules=selector=>Array.from(styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)).filter(match=>match[1].split(',').some(value=>value.trim()===selector)).map(match=>match[2]).join(';');
  assert.match(rules('.merge-preview-modal'),/display\s*:\s*flex/);assert.match(rules('.merge-preview-modal'),/max-height\s*:/);assert.match(rules('.merge-preview-viewport'),/overflow\s*:\s*auto/);assert.match(rules('.merge-preview-head'),/flex\s*:\s*none/);assert.match(rules('.merge-preview-foot'),/flex\s*:\s*none/);
});
