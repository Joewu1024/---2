'use strict';

// Offline logic checks execute the actual buyer-choice block, row bindings and
// batch editor. This small DOM is simulated; visual stacking needs browser QA.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {test}=require('node:test');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8'),lines=html.split(/\r?\n/);
const line=prefix=>{const found=lines.find(text=>text.startsWith(prefix));assert.ok(found,'Missing actual definition: '+prefix);return found};
const between=(start,end)=>{const a=html.indexOf(start),b=html.indexOf(end,a);assert.ok(a>=0&&b>a,'Missing actual source range: '+start);return html.slice(a,b)};
const plain=value=>JSON.parse(JSON.stringify(value));
const decode=text=>String(text).replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');

class MiniEvent{
  constructor(type,options={}){this.type=type;this.bubbles=!!options.bubbles;this.cancelable=options.cancelable!==false;this.defaultPrevented=false;Object.assign(this,options)}
  preventDefault(){if(this.cancelable)this.defaultPrevented=true}
  stopPropagation(){this.stopped=true}
  stopImmediatePropagation(){this.stopped=true;this.immediate=true}
}
class EventTarget{
  constructor(){this.listeners=new Map()}
  addEventListener(type,callback,options={}){const list=this.listeners.get(type)||[];list.push({callback,once:!!options.once,capture:options===true||!!options.capture});this.listeners.set(type,list)}
  removeEventListener(type,callback){this.listeners.set(type,(this.listeners.get(type)||[]).filter(item=>item.callback!==callback))}
  dispatchEvent(event){
    if(!event.target)event.target=this;
    const chain=[];for(let node=this;node;node=node.parent)chain.push(node);
    const invoke=(node,capture)=>{event.currentTarget=node;for(const item of [...(node.listeners.get(event.type)||[])]){if(item.capture!==capture)continue;item.callback.call(node,event);if(item.once)node.removeEventListener(event.type,item.callback);if(event.immediate)return}if(!capture&&typeof node['on'+event.type]==='function')node['on'+event.type].call(node,event)};
    for(const node of chain.slice().reverse()){invoke(node,true);if(event.stopped)return !event.defaultPrevented}
    for(const node of chain){invoke(node,false);if(event.stopped||!event.bubbles)break}
    return !event.defaultPrevented;
  }
}
function matches(element,selector){
  if(!element.tagName)return false;
  if(selector.includes(','))return selector.split(',').some(part=>matches(element,part.trim()));
  const not=selector.match(/:not\(([^)]+)\)/);if(not){if(matches(element,not[1]))return false;selector=selector.replace(not[0],'')}
  for(const attr of selector.matchAll(/\[([^=\]\s]+)(?:\s*=\s*["']?([^\]"']*)["']?)?\]/g))if(!Object.hasOwn(element.attributes,attr[1])||(attr[2]!==undefined&&element.attributes[attr[1]]!==attr[2]))return false;
  selector=selector.replace(/\[[^\]]+\]/g,'');
  const id=selector.match(/#([\w-]+)/);if(id&&element.id!==id[1])return false;
  for(const cls of selector.matchAll(/\.([\w-]+)/g))if(!element.classList.contains(cls[1]))return false;
  const tag=selector.match(/^[\w-]+/);return !tag||element.tagName.toLowerCase()===tag[0].toLowerCase();
}
class Element extends EventTarget{
  constructor(tag='div',document){super();this.tagName=tag.toUpperCase();this.ownerDocument=document;this.children=[];this.parent=null;this.attributes={};this.dataset={};this.className='';this.id='';this.value='';this.disabled=false;this.hidden=false;this._text='';this.style={setProperty(name,value){this[name]=value}}}
  get parentElement(){return this.parent instanceof Element?this.parent:null}
  get isConnected(){let node=this;while(node?.parent)node=node.parent;return node===this.ownerDocument}
  get classList(){return {contains:name=>this.className.split(/\s+/).includes(name),add:(...names)=>{this.className=[...new Set(this.className.split(/\s+/).filter(Boolean).concat(names))].join(' ')},remove:(...names)=>{this.className=this.className.split(/\s+/).filter(name=>!names.includes(name)).join(' ')},toggle:(name,force)=>{const next=force===undefined?!this.classList.contains(name):!!force;next?this.classList.add(name):this.classList.remove(name);return next}}}
  append(...children){for(const child of children){child.remove?.();child.parent=this;this.children.push(child)}}
  appendChild(child){this.append(child);return child}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null}
  contains(target){return this===target||this.children.some(child=>child.contains(target))}
  setAttribute(name,value){const text=String(value);this.attributes[name]=text;if(name==='id')this.id=text;if(name==='class')this.className=text;if(name==='value')this.value=text;if(name==='disabled')this.disabled=true;if(name==='hidden')this.hidden=true;if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=text}
  getAttribute(name){return this.attributes[name]??null}
  hasAttribute(name){return Object.hasOwn(this.attributes,name)}
  removeAttribute(name){delete this.attributes[name];if(name==='disabled')this.disabled=false;if(name==='hidden')this.hidden=false}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(matches(child,selector)?[child]:[]),...child.querySelectorAll(selector)])}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null}
  closest(selector){for(let node=this;node instanceof Element;node=node.parent)if(matches(node,selector))return node;return null}
  focus(){if(this.ownerDocument.activeElement===this)return;this.ownerDocument.activeElement=this;this.dispatchEvent(new MiniEvent('focus'));this.dispatchEvent(new MiniEvent('focusin',{bubbles:true}))}
  select(){this.selectionStart=0;this.selectionEnd=this.value.length}
  click(){if(!this.disabled)this.dispatchEvent(new MiniEvent('click',{bubbles:true}))}
  getBoundingClientRect(){return {left:40,right:300,top:150,bottom:184,width:260,height:34}}
  get offsetHeight(){return 260}get offsetWidth(){return 320}
  set textContent(value){this._text=String(value);this.children=[]}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('')}
  set innerHTML(value){
    this._html=String(value);for(const child of this.children)child.parent=null;this.children=[];this._text='';const stack=[this];
    for(const token of this._html.matchAll(/<\/?([a-z][a-z0-9-]*)\b([^>]*)>|([^<]+)/gi)){
      if(token[3]){stack.at(-1)._text+=decode(token[3]);continue}
      if(token[0].startsWith('</')){if(stack.length>1)stack.pop();continue}
      const child=new Element(token[1],this.ownerDocument);
      for(const attr of token[2].matchAll(/([\w-]+)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)'|\s*=\s*([^\s>]+))?/g))child.setAttribute(attr[1],decode(attr[2]??attr[3]??attr[4]??''));
      stack.at(-1).append(child);if(!['input','img','br','hr','meta','link'].includes(token[1].toLowerCase()))stack.push(child);
    }
  }
  get innerHTML(){return this._html||''}
}
class Document extends EventTarget{
  constructor(){super();this.children=[];this.activeElement=null;this.body=new Element('body',this);this.body.parent=this;this.children.push(this.body);this.documentElement={clientWidth:1360,clientHeight:900}}
  createElement(tag){return new Element(tag,this)}
  getElementById(id){return this.body.querySelector('#'+id)}
  querySelectorAll(selector){return this.body.querySelectorAll(selector)}
  querySelector(selector){return this.body.querySelector(selector)}
}
function harness({store=new Map(),namespace='A'}={}){
  const document=new Document(),window=new EventTarget(),controls={writable:true,saves:0,renders:0,dirty:[],storageWrites:[],timers:[]};
  for(const id of ['overlay','toast','buyerDevOptions','buyerReasonOptions']){const element=document.createElement('div');element.id=id;document.body.append(element)}
  const workspace={storageKey:base=>namespace+':'+base};
  const context=vm.createContext({document,window,controls,console,Event:MiniEvent,MouseEvent:MiniEvent,KeyboardEvent:MiniEvent,innerWidth:1360,innerHeight:900,workspace,
    localStorage:{getItem:key=>store.get(key)??null,setItem(key,value){controls.storageWrites.push(key);store.set(key,String(value))}},
    setTimeout(callback){controls.timers.push(callback);return controls.timers.length},clearTimeout(){},requestAnimationFrame:callback=>callback()
  });
  const source=[line('const H='),line('const S='),line('const FIELD='),line('let buyerCustomOptions='),line('const rawLookupCache='),line('const keyMap='),line('function key('),line('function aliasFor('),between('// buyer-choice:start','// buyer-choice:end'),between('function rowHtml(','function closeProductCard('),line('function bindTable('),between('function batch()', 'function merge(')].join('\n');
  const api=vm.runInContext(`(function(){
    let rows=[],selected=new Set(),historyMode=false,opened=new Set();
    function canEditWorkspace(){return controls.writable}function value(record,field){return record.raw[field]??''}
    function idFor(record){return record.uid}function groupSelectionState(){return {total:1,count:0,checked:false,indeterminate:false}}
    function buyerOptionListId(){return ''}function invalidateRaw(){}function markDirty(record){controls.dirty.push(record.uid)}
    function save(){controls.saves++}function render(){controls.renders++}function rememberBuyerOptionStub(){}
    function updateSelectionUI(){}function updateCalculatedCells(){}async function regroup(){}function deriveRecord(){}
    ${source}
    return {H,drawOptions,rememberBuyerOption,removeBuyerOption,openBuyerChoice,closeBuyerChoice,bindBuyerChoices,refreshBuyerDatalists,rowHtml,bindTable,batch,norm,
      setRows(value){rows=value},setSelected(value){selected=new Set(value)},setHistory(value){historyMode=value},setWorkspace(value){globalThis.workspace=value}};
  })()`,context,{filename:'actual-buyer-choice-functions.js'});
  const row=(id='synthetic-row',reason='')=>({uid:id,raw:{[api.H[1]]:reason},preValue:'',preDate:'',preNote:''});
  const rowInput=(record,index=1)=>{api.setRows([record]);const host=document.createElement('div');host.innerHTML=api.rowHtml(record,[{h:api.H[index],k:index===0?'dev':'reason',display:index===0?'是否可开发':'不可开发原因'}],1,'synthetic-group',false);document.body.append(host);api.bindTable();return host.querySelector('[data-buyer-choice]')};
  const popup=()=>document.getElementById('buyerChoicePopup');
  const optionValues=()=>popup()?.querySelectorAll('.buyer-choice-value').map(element=>element.textContent)||[];
  const option=value=>popup()?.querySelectorAll('.buyer-choice-option').find(element=>element.querySelector('.buyer-choice-value')?.textContent===value);
  return {api,document,window,controls,store,namespace,row,rowInput,popup,optionValues,option};
}

test('a chosen row value reopens the complete list on focus, click and arrow keys',()=>{
  const h=harness(),record=h.row('row-1','26/已开发'),input=h.rowInput(record);assert.ok(input,'row markup wires data-buyer-choice');assert.equal(input.hasAttribute('list'),false);
  input.focus();assert.deepEqual(h.optionValues(),Array.from(h.api.drawOptions(1)));
  h.option('31/IP侵权').querySelector('.buyer-choice-value').click();assert.equal(record.raw[h.api.H[1]],'31/IP侵权');
  input.click();assert.deepEqual(h.optionValues(),Array.from(h.api.drawOptions(1)));
  h.api.closeBuyerChoice();input.dispatchEvent(new MiniEvent('keydown',{key:'ArrowDown',bubbles:true}));assert.deepEqual(h.optionValues(),Array.from(h.api.drawOptions(1)));
  assert.equal(h.popup().parentElement,h.document.body);assert.equal(h.popup().getAttribute('role'),'dialog');
});

test('only a current typing event filters the list and reopening resets that filter',()=>{
  const h=harness(),record=h.row(),input=h.rowInput(record);input.focus();input.value='侵权';input.dispatchEvent(new MiniEvent('input',{bubbles:true}));
  assert.deepEqual(h.optionValues(),['31/IP侵权']);input.click();assert.deepEqual(h.optionValues(),Array.from(h.api.drawOptions(1)));
});

test('development judgments and reasons use independent custom lists and exact field bindings',()=>{
  const h=harness(),custom='自定义开发判断';h.api.rememberBuyerOption(h.api.H[0],custom);h.api.rememberBuyerOption(h.api.H[1],'仅原因列表');
  const record=h.row('development-row','现有原因');record.raw[h.api.H[0]]='是';const input=h.rowInput(record,0);input.focus();
  assert.deepEqual(h.optionValues(),Array.from(h.api.drawOptions(0)));assert.equal(h.optionValues().includes('仅原因列表'),false);
  h.option('否').querySelector('.buyer-choice-value').click();assert.equal(record.raw[h.api.H[0]],'否');assert.equal(record.raw[h.api.H[1]],'现有原因');
  input.click();h.option(custom).querySelector('.buyer-choice-remove').click();assert.equal(h.api.drawOptions(0).includes(custom),false);assert.ok(h.api.drawOptions(1).includes('仅原因列表'));
});

test('row edits remember custom choices and batch shares them while selecting only changes its draft',()=>{
  const h=harness(),record=h.row('selected','原判断'),input=h.rowInput(record),custom='买手自定义 · 保留完整原因';
  input.value=custom;input.dispatchEvent(new MiniEvent('input',{bubbles:true}));input.dispatchEvent(new MiniEvent('change',{bubbles:true}));
  assert.equal(record.raw[h.api.H[1]],custom);assert.ok(record.userEditedFields.includes(h.api.H[1]));assert.ok(h.api.drawOptions(1).includes(custom));
  const other=h.row('not-selected','其他商品原判断');h.api.setRows([record,other]);h.api.setSelected([record.uid]);h.api.batch();
  const draft=h.document.querySelectorAll('[data-buyer-choice]').find(element=>element.hasAttribute('data-batch')&&element.dataset.buyerChoice===h.api.H[1]);assert.ok(draft);
  draft.focus();assert.ok(h.optionValues().includes(custom));h.option('31/IP侵权').querySelector('.buyer-choice-value').click();
  assert.equal(draft.value,'31/IP侵权');assert.equal(record.raw[h.api.H[1]],custom);assert.equal(other.raw[h.api.H[1]],'其他商品原判断');
  h.document.getElementById('applyBatch').click();assert.equal(record.raw[h.api.H[1]],'31/IP侵权');assert.equal(other.raw[h.api.H[1]],'其他商品原判断');
});

test('a batch remembers each custom choice once while applying it to every selected record',()=>{
  const h=harness(),rows=Array.from({length:4},(_,index)=>h.row('batch-'+index,'原原因'));h.api.setRows(rows);h.api.setSelected(rows.slice(0,3).map(row=>row.uid));h.api.batch();
  for(const input of h.document.querySelectorAll('[data-batch]'))if(input.dataset.batch===h.api.H[0])input.value='批量自定义判断';else if(input.dataset.batch===h.api.H[1])input.value='批量自定义原因';
  h.document.getElementById('applyBatch').click();
  for(const row of rows.slice(0,3)){assert.equal(row.raw[h.api.H[0]],'批量自定义判断');assert.equal(row.raw[h.api.H[1]],'批量自定义原因')}
  assert.equal(rows[3].raw[h.api.H[1]],'原原因');assert.equal(h.controls.storageWrites.length,2);
});

test('deleting a custom option changes only the current workspace choices and emits no editor events',()=>{
  const store=new Map([['B:pool-buyer-custom-options-v1','UNRELATED-WORKSPACE']]),h=harness({store}),custom='自定义待删原因';h.api.rememberBuyerOption(h.api.H[1],custom);
  const record=h.row('keeps-written-value',custom),input=h.rowInput(record);let inputs=0,changes=0;input.addEventListener('input',()=>inputs++);input.addEventListener('change',()=>changes++);
  input.focus();const remove=h.option(custom)?.querySelector('.buyer-choice-remove');assert.ok(remove);assert.equal(remove.getAttribute('aria-label'),'删除自定义选项 '+custom);
  remove.click();assert.equal(input.value,custom);assert.equal(record.raw[h.api.H[1]],custom);assert.equal(inputs,0);assert.equal(changes,0);assert.equal(h.api.drawOptions(1).includes(custom),false);
  assert.equal(store.get('B:pool-buyer-custom-options-v1'),'UNRELATED-WORKSPACE');assert.ok(h.controls.storageWrites.every(key=>key.startsWith('A:')));
  const reloaded=harness({store});assert.equal(reloaded.api.drawOptions(1).includes(custom),false);
});

test('a deleted custom value is not silently remembered again by the existing row on change or blur',()=>{
  const h=harness(),custom='删除后原商品仍保留';h.api.rememberBuyerOption(h.api.H[1],custom);const record=h.row('row-blur',custom),input=h.rowInput(record);
  input.focus();h.option(custom).querySelector('.buyer-choice-remove').click();const writes=h.controls.storageWrites.length;
  input.dispatchEvent(new MiniEvent('change',{bubbles:true}));input.dispatchEvent(new MiniEvent('blur'));input.dispatchEvent(new MiniEvent('focusout',{bubbles:true}));
  assert.equal(record.raw[h.api.H[1]],custom);assert.equal(input.value,custom);assert.equal(h.api.drawOptions(1).includes(custom),false);
  assert.equal(h.controls.storageWrites.length,writes);assert.equal(JSON.parse(h.store.get('A:pool-buyer-custom-options-v1'))[h.api.norm(h.api.H[1])].includes(custom),false);
});

test('a batch draft deleted from the choice list stays deleted when the unchanged draft is applied',()=>{
  const h=harness(),custom='批量草稿已删除候选';h.api.rememberBuyerOption(h.api.H[1],custom);const record=h.row('row-batch-delete',custom);h.api.setRows([record]);h.api.setSelected([record.uid]);h.api.batch();
  const draft=h.document.querySelectorAll('[data-buyer-choice]').find(input=>input.dataset.buyerChoice===h.api.H[1]);draft.focus();h.option(custom).querySelector('.buyer-choice-value').click();
  assert.equal(draft.value,custom);draft.click();h.option(custom).querySelector('.buyer-choice-remove').click();const writes=h.controls.storageWrites.length;
  h.document.getElementById('applyBatch').click();assert.equal(record.raw[h.api.H[1]],custom);assert.equal(h.api.drawOptions(1).includes(custom),false);assert.equal(h.controls.storageWrites.length,writes);
});

test('fresh user typing can deliberately add a previously deleted custom value again',()=>{
  const h=harness(),custom='允许用户重新手输';h.api.rememberBuyerOption(h.api.H[1],custom);const record=h.row('row-retype',custom),input=h.rowInput(record);
  input.focus();h.option(custom).querySelector('.buyer-choice-remove').click();assert.equal(h.api.drawOptions(1).includes(custom),false);
  input.value='';input.dispatchEvent(new MiniEvent('input',{bubbles:true,isTrusted:true}));input.value=custom;input.dispatchEvent(new MiniEvent('input',{bubbles:true,isTrusted:true}));input.dispatchEvent(new MiniEvent('change',{bubbles:true}));
  assert.equal(record.raw[h.api.H[1]],custom);assert.ok(h.api.drawOptions(1).includes(custom));
  const restored=harness({store:h.store});assert.ok(restored.api.drawOptions(1).includes(custom));
});

test('default options have no delete button and remain protected even when an old cache repeats their text',()=>{
  const h=harness(),defaultValue='26/已开发',key='A:pool-buyer-custom-options-v1';h.store.set(key,JSON.stringify({[h.api.norm(h.api.H[1])]:[defaultValue,'真正自定义']}));
  const restored=harness({store:h.store}),input=restored.rowInput(restored.row('row-default',defaultValue));input.focus();
  assert.equal(restored.option(defaultValue).querySelector('.buyer-choice-remove'),null);assert.ok(restored.option('真正自定义').querySelector('.buyer-choice-remove'));
  restored.api.removeBuyerOption(restored.api.H[1],defaultValue);assert.ok(restored.api.drawOptions(1).includes(defaultValue));assert.equal(input.value,defaultValue);
});

test('choosing an option dispatches one input and one change even after repeated binding',()=>{
  const h=harness(),record=h.row(),input=h.rowInput(record);let inputs=0,changes=0;input.addEventListener('input',()=>inputs++);input.addEventListener('change',()=>changes++);
  h.api.bindBuyerChoices();h.api.bindBuyerChoices();input.focus();h.option('31/IP侵权').querySelector('.buyer-choice-value').click();
  assert.equal(inputs,1);assert.equal(changes,1);assert.equal(input.value,'31/IP侵权');assert.equal(record.raw[h.api.H[1]],'31/IP侵权');
});

for(const changed of ['history','ownership','dataset','workspace'])test('stale choice and delete controls refuse changes after '+changed+' changes',()=>{
  const h=harness(),custom='保留自定义';h.api.rememberBuyerOption(h.api.H[1],custom);const record=h.row('stable-id','原判断'),input=h.rowInput(record);input.focus();
  const choose=h.option('31/IP侵权').querySelector('.buyer-choice-value'),remove=h.option(custom).querySelector('.buyer-choice-remove'),before=plain(record),stored=h.store.get('A:pool-buyer-custom-options-v1');
  if(changed==='history')h.api.setHistory(true);else if(changed==='ownership')h.controls.writable=false;else if(changed==='dataset')h.api.setRows([h.row('stable-id','新数据')]);else h.api.setWorkspace({storageKey:base=>'CHANGED:'+base});
  choose.click();remove.click();assert.deepEqual(plain(record),before);assert.equal(h.store.get('A:pool-buyer-custom-options-v1'),stored);assert.equal(h.store.has('CHANGED:pool-buyer-custom-options-v1'),false);
});

test('Escape closes only the picker and batch cancellation removes its floating popup',()=>{
  const h=harness(),record=h.row();h.api.setRows([record]);h.api.setSelected([record.uid]);h.api.batch();
  const draft=h.document.querySelector('[data-buyer-choice]');assert.ok(draft);draft.focus();assert.ok(h.popup());
  draft.dispatchEvent(new MiniEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(h.popup(),null);assert.ok(h.document.getElementById('applyBatch'));
  draft.click();assert.ok(h.popup());h.document.getElementById('cancel').click();assert.equal(h.popup(),null);assert.equal(h.document.getElementById('overlay').innerHTML,'');
});

for(const event of ['outside','scroll','resize'])test(event+' dismisses the floating picker',()=>{
  const h=harness(),input=h.rowInput(h.row());input.focus();assert.ok(h.popup());
  if(event==='outside')h.document.body.dispatchEvent(new MiniEvent('pointerdown',{bubbles:true}));else (event==='scroll'?h.document:h.window).dispatchEvent(new MiniEvent(event));
  assert.equal(h.popup(),null);
});

test('modal and picker CSS layers exceed the sticky toolbar layer',()=>{
  const styles=Array.from(html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi),match=>match[1]).join('\n');
  const layer=selector=>{let result;for(const rule of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g))if(rule[1].split(',').some(part=>part.trim()===selector)){const values=[...rule[2].matchAll(/z-index\s*:\s*(\d+)/g)];if(values.length)result=Number(values.at(-1)[1])}assert.ok(Number.isFinite(result),'CSS layer '+selector);return result};
  assert.ok(layer('.modalbg')>layer('.bulk'));assert.ok(layer('.buyer-choice-popup')>layer('.modalbg'));assert.ok(layer('.buyer-choice-popup')>layer('.panel'));
});
