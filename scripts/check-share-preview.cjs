'use strict';

// Offline checks execute the actual preview functions. The small DOM below is
// deliberately simulated; translation transport and browser rendering are not run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const BuyerTranslation = require('../translation-engine.js');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const start = html.indexOf('function sharePreviewChineseValue(');
const end = html.indexOf('async function uploadRowImage(', start);
assert.ok(start >= 0 && end > start, 'Missing actual preview functions');
const source = html.slice(start, end);
const decode = text => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function matches(element, selector) {
  if (selector.startsWith('#')) return element.id === selector.slice(1);
  if (selector.startsWith('.')) return element.className.split(/\s+/).includes(selector.slice(1));
  const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
  if (attr) return Object.hasOwn(element.attributes, attr[1]) && (attr[2] == null || element.attributes[attr[1]] === attr[2]);
  return element.tagName.toLowerCase() === selector;
}

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parent = null;
    this.attributes = {}; this.dataset = {}; this.style = {}; this.className = '';
    this.id = ''; this.hidden = false; this.disabled = false; this.value = ''; this._text = '';
  }
  append(child) { child.parent = this; this.children.push(child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  contains(child) { return this === child || this.children.some(node => node.contains(child)); }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) {
    this._html = String(value); this._text = ''; this.children = [];
    const stack = [this];
    for (const token of this._html.matchAll(/<\/?([a-z][a-z0-9-]*)\b([^>]*)>|([^<]+)/gi)) {
      if (token[3]) { stack.at(-1)._text += decode(token[3]); continue; }
      if (token[0].startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      const element = new Element(token[1]);
      for (const attr of token[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
        const name = attr[1], text = decode(attr[2] || ''); element.attributes[name] = text;
        if (name === 'id') element.id = text;
        if (name === 'class') element.className = text;
        if (name === 'hidden') element.hidden = true;
        if (name.startsWith('data-')) element.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = text;
      }
      stack.at(-1).append(element);
      if (!['input', 'img', 'br', 'hr', 'meta', 'link'].includes(token[1])) stack.push(element);
    }
  }
  get innerHTML() { return this._html || ''; }
  getBoundingClientRect() { return { left: 20, right: 100, top: 80, bottom: 100 }; }
}

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function harness(overrides = {}) {
  const H = Array.from({ length: 26 }, (_, index) => 'field-' + index);
  const record = { uid: 'fake-row-1', raw: { [H[9]]: 'Wireless speaker', [H[11]]: 'Black' }, userEditedFields: [] };
  const controls = { ensureCalls: 0, categoryCalls: 0, saves: 0, renders: 0, dirty: [], writable: true, category: '音响', ...overrides };
  const body = new Element('body'), overlay = new Element(); overlay.id = 'overlay'; body.append(overlay);
  const anchor = new Element('button'); anchor.attributes['data-share'] = record.uid; anchor.dataset.share = record.uid; body.append(anchor);
  const document = { body, getElementById: id => body.querySelector('#' + id), createElement: tag => new Element(tag), querySelectorAll: selector => body.querySelectorAll(selector) };
  const context = {
    H, rows: [record], activeProductCard: '', historyMode: false, innerWidth: 1440, innerHeight: 900,
    document, BuyerTranslation, translationLastError: '', translationUserPaused: false,
    translationQueue: { failedUntil: new Map(), setPaused() {} }, scheduleTranslationStatus() {},
    value: (row, field) => row.raw[field] || '',
    translationSource: (row, index) => BuyerTranslation.normalize(row.raw[H[index]]),
    manualChinese: (row, index) => row.userEditedFields.includes(H[index]),
    categoryPath: () => controls.category,
    productDetail: row => ({ id: row.uid, model: '', itemChinese: row.raw[H[10]], modelChinese: row.raw[H[12]], category: controls.category, target: '2.00', badges: [] }),
    inlineBadgesMarkup: () => '',
    esc: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    canEditWorkspace: () => controls.writable,
    invalidateRaw() {}, markDirty: row => controls.dirty.push(row.uid), save: () => controls.saves++,
    render() { controls.renders++; context.closeProductCard(); }, toast: text => { controls.toast = text; },
    async ensureProductTranslations(records) { controls.ensureCalls++; return controls.ensure?.(records); },
    async ensureCategoryTranslations(records) { controls.categoryCalls++; return controls.ensureCategory?.(records); },
    async buildOnlineShareLink() { if (controls.generateError) throw controls.generateError; return 'https://example.test/share.html#d=fake'; },
    copyShareText: async () => true,
    closeProductCard() { document.getElementById('productCard')?.remove(); context.activeProductCard = ''; },
    $: id => document.getElementById(id)
  };
  vm.createContext(context); vm.runInContext(source, context);
  const open = () => { context.toggleProductCard(record.uid, anchor); return document.getElementById('productCard'); };
  const fill = row => { row.raw[H[10]] = '无线音箱'; row.raw[H[12]] = '黑色'; };
  return { H, record, controls, context, document, open, fill };
}

test('preview fills both Chinese names after translation without showing original source', async () => {
  const gate = deferred(), h = harness({ ensure: () => gate.promise });
  const card = h.open();
  assert.match(card.querySelector('[data-preview-chinese="10"]').textContent, /正在翻译/);
  assert.doesNotMatch(card.textContent, /Wireless speaker|Black/);
  h.fill(h.record); gate.resolve(); await flush();
  assert.equal(card.querySelector('[data-preview-chinese="10"]').textContent, '无线音箱');
  assert.equal(card.querySelector('[data-preview-chinese="12"]').textContent, '黑色');
  assert.match(card.querySelector('[data-preview-status]').textContent, /已就绪/);
  assert.equal(h.controls.ensureCalls, 1); assert.equal(h.controls.categoryCalls, 1);
});

test('network or generation failure retains retry, edit and generate controls', async () => {
  const h = harness({ ensure: () => { throw new Error('翻译连接超时'); } });
  const card = h.open(); await flush();
  assert.match(card.querySelector('[data-preview-status]').textContent, /超时/);
  assert.equal(card.querySelector('[data-retry-preview]').disabled, false);
  assert.ok(card.querySelector('[data-edit-preview]'));
  assert.ok(card.querySelector('[data-generate-single]'));
  h.controls.ensure = records => h.fill(records[0]);
  await card.querySelector('[data-retry-preview]').onclick();
  assert.match(card.querySelector('[data-preview-status]').textContent, /已就绪/);
  h.controls.generateError = new Error('类目翻译连接失败');
  await card.querySelector('[data-generate-single]').onclick();
  assert.match(card.querySelector('[data-preview-status]').textContent, /类目翻译连接失败/);
  assert.equal(card.querySelector('[data-generate-single]').disabled, false);
  assert.ok(card.querySelector('[data-retry-preview]'));
  h.controls.generateError = null;
  await card.querySelector('[data-generate-single]').onclick();
  assert.equal(card.querySelector('[data-preview-link]').hidden, false);
});

test('completion from an old dataset cannot update another card with the same UID', async () => {
  const oldGate = deferred(), newGate = deferred(); let call = 0;
  const h = harness({ ensure: () => (++call === 1 ? oldGate.promise : newGate.promise) });
  const oldCard = h.open(); await flush();
  h.context.closeProductCard();
  const replacement = { ...h.record, raw: { ...h.record.raw } }; h.context.rows = [replacement];
  const newCard = h.open(); await flush();
  h.fill(h.record); oldGate.resolve(); await flush();
  assert.match(newCard.querySelector('[data-preview-chinese="10"]').textContent, /正在翻译/);
  assert.doesNotMatch(oldCard.querySelector('[data-preview-status]').textContent, /已就绪/);
  h.fill(replacement); newGate.resolve(); await flush();
  assert.equal(newCard.querySelector('[data-preview-chinese="10"]').textContent, '无线音箱');
});

test('empty source and Chinese fields never become a completed preview or visible link', async () => {
  const h = harness(); h.record.raw = {};
  const card = h.open(); await flush();
  assert.equal(card.querySelector('[data-preview-chinese="10"]').textContent, '中文标题待补全');
  assert.match(card.querySelector('[data-preview-status]').textContent, /请补全中文/);
  await card.querySelector('[data-generate-single]').onclick();
  assert.equal(card.querySelector('[data-preview-link]').hidden, true);
  assert.match(card.querySelector('[data-preview-status]').textContent, /请补全中文标题和中文型号/);
});

test('manual completion validates Chinese and preserves explicit buyer edits', async () => {
  const h = harness();
  const card = h.open(); await flush(); card.querySelector('[data-edit-preview]').onclick();
  h.document.getElementById('shareChineseItem').value = 'Wireless speaker';
  h.document.getElementById('shareChineseModel').value = 'Black';
  h.document.getElementById('saveShareChinese').onclick();
  assert.equal(h.controls.saves, 0); assert.match(h.document.getElementById('shareChineseEditorStatus').textContent, /完整的中文标题/);
  h.document.getElementById('shareChineseItem').value = '无线音箱';
  h.document.getElementById('shareChineseModel').value = '黑色';
  h.document.getElementById('saveShareChinese').onclick(); await flush();
  assert.equal(h.record.raw[h.H[10]], '无线音箱'); assert.equal(h.record.raw[h.H[12]], '黑色');
  assert.ok(h.record.userEditedFields.includes(h.H[10])); assert.ok(h.record.userEditedFields.includes(h.H[12]));
  assert.equal(h.record.autoItemChinese, false); assert.equal(h.record.autoModelChinese, false);
  assert.equal(h.controls.saves, 1); assert.equal(h.controls.renders, 1); assert.deepEqual(h.controls.dirty, ['fake-row-1']);
  assert.equal(h.document.getElementById('shareChineseEditor'), null);
});

test('manual editor cannot save into a different dataset', async () => {
  const h = harness(); const card = h.open(); await flush(); card.querySelector('[data-edit-preview]').onclick();
  h.document.getElementById('shareChineseItem').value = '无线音箱'; h.document.getElementById('shareChineseModel').value = '黑色';
  h.context.rows = [];
  h.document.getElementById('saveShareChinese').onclick();
  assert.equal(h.controls.saves, 0); assert.match(h.document.getElementById('shareChineseEditorStatus').textContent, /数据已切换/);
});

test('legacy share payload gives explicit missing-Chinese text and ignores original fields', () => {
  const viewer = fs.readFileSync(path.join(root, 'share.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const context = { URL }; vm.createContext(context);
  vm.runInContext(viewer.slice(0, viewer.indexOf('\nload().catch')), context);
  const result = context.card({ id: 'FAKE-1', itemChinese: ' ', modelChinese: '—', itemOriginal: 'Wireless speaker', modelOriginal: 'Black' }, 0);
  assert.match(result, /中文标题未提供，请联系分享者补全/);
  assert.match(result, /中文型号未提供，请联系分享者补全/);
  assert.doesNotMatch(result, /Wireless speaker|Black/);
  assert.match(context.card({ id: 'FAKE-2', itemChinese: '音箱<img>', modelChinese: '黑色' }, 0), /音箱&lt;img&gt;/);
});
