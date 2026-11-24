'use strict';

// Actual bulk-dialog function; fabricated records, deferred builders and fake DOM.
// No shortener, network, clipboard, window or user browser storage is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('async function showShareLinkDialog('), end = html.indexOf('function sharePreviewChineseValue(', start);
assert.ok(start >= 0 && end > start, 'Missing actual bulk sharing function');
const source = html.slice(start, end);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

class Node {
  constructor() { this.hidden = false; this.textContent = ''; this.value = ''; this.disabled = false; this.dataset = {}; this.attributes = {}; this.nodes = new Map(); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  get href() { return this.getAttribute('href') || ''; }
  get tabIndex() { return Number(this.getAttribute('tabindex') ?? -1); }
  set tabIndex(value) { this.setAttribute('tabindex',value); }
  get isConnected() { return true; }
  contains(node) { return this === node || [...this.nodes.values()].some(child => child === node); }
  querySelector(selector) { return this.nodes.get(selector) || null; }
  querySelectorAll(selector) { const found = this.querySelector(selector); return found ? [found] : []; }
  set innerHTML(value) {
    this._html = value; this.nodes = new Map();
    if (!String(value).includes('data-share-close')) return;
    const modal = new Node(), controls = new Node(), input = new Node(), copy = new Node(), open = new Node(), status = new Node(), close = new Node(), file = new Node();
    controls.hidden = true;
    file.hidden = true;
    status.textContent = '正在整理产品信息和中文类目…';
    controls.nodes = new Map([['input', input], ['[data-copy-share]', copy], ['[data-open-share]', open]]);
    this.nodes = new Map([['.share-link-modal', modal], ['[data-share-close]', close], ['[data-share-status]', status], ['.share-link-controls', controls], ['[data-share-file]', file]]);
    modal.nodes = this.nodes; this.firstElementChild = modal;
  }
  get innerHTML() { return this._html || ''; }
}

function harness() {
  const dialog = new Node(); dialog.hidden = true;
  const records = ['FAKE-A', 'FAKE-B', 'FAKE-C'].map(uid => ({ uid, raw: {} }));
  const controls = { jobs: [], copied: [], opened: [], messages: [], timers: [], downloaded: [], clipboardAllowed: true };
  const builder = async (entries, options = {}) => {
    const gate = deferred(); controls.jobs.push({ ...gate, records: entries, options }); return gate.promise;
  };
  const context = vm.createContext({
    rows: records, historyMode: false, canEditWorkspace: () => true,
    $: id => id === 'shareLinkDialog' ? dialog : null,
    document: { getElementById: id => id === 'shareLinkDialog' ? dialog : null, body: { contains: () => true } },
    buildOnlineShareLink: builder,
    shareLinkMessage(url, count = 1) {
      controls.messages.push({ url, count });
      return '已生成 ' + count + ' 个产品的直达链接';
    },
    copyShareText: async url => { controls.copied.push(url); return controls.clipboardAllowed; },
    downloadShareFile: products => controls.downloaded.push(products),
    window: { open: (...args) => controls.opened.push(args) },
    setTimeout: callback => controls.timers.push(callback), AbortController, URL, console
  });
  vm.runInContext(source, context);
  const resolve = (index, url) => { controls.jobs[index].resolve(url); };
  return { dialog, records, controls, context, resolve, show: entries => context.showShareLinkDialog(entries) };
}

test('the bulk dialog shows, copies and opens one long URL for the selection', async () => {
  const h = harness();
  const work = h.show(h.records);
  const url = 'https://example.test/s.html?d=c' + 'A'.repeat(6700);
  h.resolve(0, url);
  await work;
  const controls = h.dialog.querySelector('.share-link-controls');
  assert.equal(controls.querySelector('input').value, url);
  assert.doesNotMatch(h.dialog.innerHTML, /data-share-parts|复制全部链接|打开第/);
  assert.deepEqual(h.controls.copied, [url]);
  controls.querySelector('[data-open-share]').onclick();
  assert.deepEqual(h.controls.opened.map(args => args[0]), [url]);
  assert.match(h.dialog.querySelector('[data-share-status]').textContent, /3 个产品的直达链接/);
});

test('when the selection cannot fit, only the complete product file is offered', async () => {
  const h = harness(), work = h.show(h.records);
  const products = [{id:'demo', model:'data:image/png;base64,AAAA'}];
  h.controls.jobs[0].reject(Object.assign(new Error('商品内容较多，可下载完整产品卡发给对方'),{shareProducts:products}));
  await work;
  const file = h.dialog.querySelector('[data-share-file]');
  assert.equal(file.hidden, false);
  assert.equal(h.dialog.querySelector('.share-link-controls').hidden, true);
  assert.deepEqual(h.controls.copied, []);
  file.onclick();
  assert.deepEqual(h.controls.downloaded, [products]);
});

function assertNoResult(dialog) {
  const controls = dialog.querySelector('.share-link-controls');
  assert.equal(controls.hidden, true); assert.equal(controls.querySelector('input').value, '');
  assert.equal(typeof controls.querySelector('[data-copy-share]').onclick, 'undefined');
  assert.equal(typeof controls.querySelector('[data-open-share]').onclick, 'undefined');
  assert.equal(dialog.querySelector('[data-direct-share]'),null);
}

test('bulk generation copies the exact direct URL once and retains its primary controls',async()=>{
  const h=harness(),pending=h.show(h.records.slice(0,2));await flush();
  const full='https://example.test/share.html#d=j'+Buffer.from(JSON.stringify({v:1,products:h.records.slice(0,2).map(r=>({id:r.uid,modelChinese:'  5pcs / 蓝色  '}))})).toString('base64url');h.resolve(0,full);await pending;
  const controls=h.dialog.querySelector('.share-link-controls'),open=controls.querySelector('[data-open-share]'),copy=controls.querySelector('[data-copy-share]');
  assert.equal(controls.hidden,false);assert.equal(controls.querySelector('input').value,full);
  assert.equal(h.dialog.querySelector('[data-direct-share]'),null);assert.doesNotMatch(h.dialog.innerHTML,/is\.gd|短链接|data-copy-direct/);
  const decoded=JSON.parse(Buffer.from(new URL(full).hash.slice(4),'base64url'));assert.deepEqual(decoded.products.map(p=>p.id),['FAKE-A','FAKE-B']);assert.equal(decoded.products[1].modelChinese,'  5pcs / 蓝色  ');
  assert.deepEqual(h.controls.copied,[full]);
  assert.match(h.dialog.querySelector('[data-share-status]').textContent,/已复制/);
  await copy.onclick({currentTarget:copy});assert.deepEqual(h.controls.copied,[full,full]);
  open.onclick();assert.equal(h.controls.opened[0][0],full);
});

test('bulk share retains the generated link when the browser blocks automatic copy', async () => {
  const h = harness(); h.controls.clipboardAllowed = false;
  const pending = h.show(h.records); await flush();
  const url = 'https://example.test/share.html#d=cFakeCompleteProducts'; h.resolve(0, url); await pending;
  const controls = h.dialog.querySelector('.share-link-controls');
  const copy = controls.querySelector('[data-copy-share]');
  assert.deepEqual(h.controls.copied, [url]);
  assert.doesNotMatch(h.dialog.querySelector('[data-share-status]').textContent, /已复制|链接生成失败/);
  assert.equal(controls.hidden, false);
  assert.equal(controls.querySelector('input').value, url);
  h.controls.clipboardAllowed = true;
  await copy.onclick({ currentTarget: copy });
  assert.equal(copy.textContent, '已复制');
  assert.deepEqual(h.controls.copied, [url, url]);
});

test('bulk direct handlers cannot copy or navigate after close, replacement or dataset change',async()=>{
  for(const action of ['close','replacement','dataset']){
    const h=harness(),pending=h.show(h.records);await flush();h.resolve(0,'https://example.test/share.html#d=jOldFull');await pending;
    const controls=h.dialog.querySelector('.share-link-controls'),copy=controls.querySelector('[data-copy-share]'),open=controls.querySelector('[data-open-share]');
    let next;if(action==='close')h.dialog.querySelector('[data-share-close]').onclick();
    if(action==='dataset')h.context.rows=[...h.records];
    if(action==='replacement'){next=h.show(h.records.slice(0,1));await flush();assertNoResult(h.dialog)}
    await copy.onclick({currentTarget:copy});open.onclick();
    assert.deepEqual(h.controls.copied,['https://example.test/share.html#d=jOldFull'],action);assert.deepEqual(h.controls.opened,[],action);
    if(next){h.resolve(1,'https://example.test/share.html#d=jNewFull');await next}
  }
});

test('bulk sharing keeps every selected record and copies/opens the exact direct URL', async () => {
  const h = harness(), pending = h.show(h.records); await flush();
  assert.deepEqual(Array.from(h.controls.jobs[0].records, record => record.uid), ['FAKE-A', 'FAKE-B', 'FAKE-C']);
  assertNoResult(h.dialog);
  const url = 'https://example.test/share.html#d=jFakeABC'; h.resolve(0, url); await pending;
  const controls = h.dialog.querySelector('.share-link-controls');
  assert.equal(controls.hidden, false); assert.equal(controls.querySelector('input').value, url);
  assert.match(h.dialog.querySelector('[data-share-status]').textContent, /3 个产品的直达链接/);
  assert.deepEqual(h.controls.messages.at(-1), { url, count: 3 });
  await controls.querySelector('[data-copy-share]').onclick({ currentTarget: controls.querySelector('[data-copy-share]') });
  controls.querySelector('[data-open-share]').onclick();
  assert.deepEqual(h.controls.copied, [url, url]); assert.equal(h.controls.opened[0][0], url); assert.equal(h.controls.opened[0][1], '_blank');
});

test('bulk direct sharing is usable in the primary controls and has no duplicate fallback row', async () => {
  const h = harness(), pending = h.show(h.records.slice(0, 2)); await flush();
  const url = 'https://example.test/share.html#d=jFakeCompleteProducts'; h.resolve(0, url, false); await pending;
  assert.equal(h.dialog.querySelector('.share-link-controls').querySelector('input').value, url);
  assert.equal(h.dialog.querySelector('[data-direct-share]'),null,'the direct URL is only shown in primary controls');
  const status = h.dialog.querySelector('[data-share-status]').textContent;
  assert.match(status, /2 个产品的直达链接/); assert.doesNotMatch(status, /短链接|is\.gd|一键翻译|翻译失败/);
});

test('an earlier generation cannot overwrite a newer pending or completed dialog', async () => {
  const h = harness(), first = h.show(h.records.slice(0, 1)); await flush();
  const second = h.show(h.records.slice(1)); await flush();
  h.resolve(0, 'https://is.gd/FakeOld'); await first;
  assertNoResult(h.dialog);
  assert.deepEqual(h.controls.copied, []);
  const url = 'https://is.gd/FakeNew'; h.resolve(1, url); await second;
  assert.equal(h.dialog.querySelector('.share-link-controls').querySelector('input').value, url);
  assert.match(h.dialog.querySelector('[data-share-status]').textContent, /2 个产品/);
  assert.deepEqual(h.controls.copied, [url]);
});

test('late errors from an old request cannot overwrite a newer successful link', async () => {
  const h = harness(), first = h.show(h.records.slice(0, 1)); await flush();
  const second = h.show(h.records.slice(1)); await flush();
  const url = 'https://is.gd/FakeWinner'; h.resolve(1, url); await second;
  const status = h.dialog.querySelector('[data-share-status]').textContent;
  h.controls.jobs[0].reject(new Error('Fabricated obsolete error')); await first;
  assert.equal(h.dialog.querySelector('[data-share-status]').textContent, status);
  assert.equal(h.dialog.querySelector('.share-link-controls').querySelector('input').value, url);
});

for (const close of ['button', 'backdrop', 'hidden']) {
  test('closing by ' + close + ' ignores a later URL or error', async () => {
    for (const fail of [false, true]) {
      const h = harness(), pending = h.show(h.records); await flush();
      if (close === 'button') h.dialog.querySelector('[data-share-close]').onclick();
      else if (close === 'backdrop') h.dialog.onclick({ target: h.dialog });
      else h.dialog.hidden = true;
      const status = h.dialog.querySelector('[data-share-status]').textContent;
      if (fail) h.controls.jobs[0].reject(new Error('Fabricated error after close')); else h.resolve(0, 'https://is.gd/FakeClosed');
      await pending;
      assert.equal(h.dialog.hidden, true); assertNoResult(h.dialog);
      assert.equal(h.dialog.querySelector('[data-share-status]').textContent, status);
      assert.deepEqual(h.controls.copied, []);
    }
  });
}

test('a new generation clears an old result and current failure is not called a translation failure', async () => {
  const h = harness(), first = h.show(h.records); await flush(); h.resolve(0, 'https://is.gd/FakePrevious'); await first;
  const next = h.show(h.records.slice(0, 1)); await flush(); assertNoResult(h.dialog);
  h.controls.jobs[1].reject(new Error('虚构分享服务不可用')); await next;
  assertNoResult(h.dialog);
  const status = h.dialog.querySelector('[data-share-status]').textContent;
  assert.match(status, /链接生成失败/); assert.doesNotMatch(status, /一键翻译|翻译失败/);
});

test('builder receives a current-request guard that turns false on close or replacement', async () => {
  const h = harness(), first = h.show(h.records); await flush();
  const oldCurrent = h.controls.jobs[0].options.isCurrent;
  assert.equal(typeof oldCurrent, 'function'); assert.equal(oldCurrent(), true);
  const second = h.show(h.records.slice(1)); await flush();
  const newCurrent = h.controls.jobs[1].options.isCurrent;
  assert.equal(oldCurrent(), false); assert.equal(newCurrent(), true);
  h.dialog.querySelector('[data-share-close]').onclick(); assert.equal(newCurrent(), false);
  h.resolve(0, 'https://is.gd/FakeOldGuard'); h.resolve(1, 'https://is.gd/FakeNewGuard'); await Promise.all([first, second]);
  assertNoResult(h.dialog); assert.equal(h.dialog.hidden, true);
  assert.deepEqual(h.controls.copied, []);
});

test('obsolete copy/open handlers cannot act after a newer request or dialog close', async () => {
  const h = harness(), first = h.show(h.records); await flush(); h.resolve(0, 'https://is.gd/FakeObsolete'); await first;
  const oldControls = h.dialog.querySelector('.share-link-controls'), oldCopyButton = oldControls.querySelector('[data-copy-share]');
  const oldCopy = oldCopyButton.onclick, oldOpen = oldControls.querySelector('[data-open-share]').onclick;
  const next = h.show(h.records.slice(0, 1)); await flush();
  await oldCopy({ currentTarget: oldCopyButton }); oldOpen();
  assert.deepEqual(h.controls.copied, ['https://is.gd/FakeObsolete']); assert.deepEqual(h.controls.opened, []);
  h.resolve(1, 'https://is.gd/FakeCurrent'); await next;
  const currentControls = h.dialog.querySelector('.share-link-controls'), copyButton = currentControls.querySelector('[data-copy-share]');
  const copy = copyButton.onclick, open = currentControls.querySelector('[data-open-share]').onclick;
  h.dialog.querySelector('[data-share-close]').onclick();
  await copy({ currentTarget: copyButton }); open();
  assert.deepEqual(h.controls.copied, ['https://is.gd/FakeObsolete', 'https://is.gd/FakeCurrent']); assert.deepEqual(h.controls.opened, []);
});
