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
const source = process.env.BUYER_SHARE_PREVIEW_SOURCE
  ? fs.readFileSync(path.resolve(root, process.env.BUYER_SHARE_PREVIEW_SOURCE), 'utf8')
  : html.slice(start, end);
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
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  removeAttribute(name) { delete this.attributes[name]; }
  set href(value) { this.setAttribute('href', value); }
  get href() { return this.getAttribute('href') || ''; }
  set target(value) { this.setAttribute('target', value); }
  get target() { return this.getAttribute('target') || ''; }
  set rel(value) { this.setAttribute('rel', value); }
  get rel() { return this.getAttribute('rel') || ''; }
  set tabIndex(value) { this.setAttribute('tabindex', value); }
  get tabIndex() { return this.getAttribute('tabindex') == null ? this.tagName === 'A' && this.href ? 0 : -1 : Number(this.getAttribute('tabindex')); }
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
  const controls = { ensureCalls: 0, categoryCalls: 0, saves: 0, renders: 0, dirty: [], writable: true, category: '音响', categoryNames: ['Audio'], timers: new Map(), nextTimer: 1, generatedUrls: [], copiedUrls: [], ...overrides };
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
    categoryValues: () => controls.categoryNames,
    categoryLabel: () => controls.category,
    hasChinese: text => /[\u3400-\u9fff]/.test(text),
    productDetail: row => ({ id: row.uid, model: '', itemChinese: row.raw[H[10]], modelChinese: row.raw[H[12]], category: controls.category, target: '2.00', badges: [] }),
    inlineBadgesMarkup: () => '',
    esc: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    canEditWorkspace: () => controls.writable,
    invalidateRaw() {}, markDirty: row => controls.dirty.push(row.uid), save: () => controls.saves++,
    render() { controls.renders++; context.closeProductCard(); }, toast: text => { controls.toast = text; },
    async ensureProductTranslations(records) { controls.ensureCalls++; return controls.ensure?.(records); },
    async ensureCategoryTranslations(records) { controls.categoryCalls++; return controls.ensureCategory?.(records); },
    async buildOnlineShareLink(records) {
      if (controls.generateError) throw controls.generateError;
      const row = records[0], payload = { id: row.uid, itemChinese: row.raw[H[10]], modelChinese: row.raw[H[12]], category: controls.category };
      const url = 'https://example.test/share.html#d=j' + Buffer.from(JSON.stringify(payload)).toString('base64url');
      controls.generatedUrls.push(url); return controls.generate ? controls.generate(records, url) : url;
    },
    copyShareText: async url => { controls.copiedUrls.push(url); return true; },
    closeProductCard() { document.getElementById('productCard')?.remove(); context.activeProductCard = ''; },
    $: id => document.getElementById(id),
    setTimeout(callback) { const id = controls.nextTimer++; controls.timers.set(id, callback); return id; }
  };
  vm.createContext(context); vm.runInContext(source, context);
  const open = () => { context.toggleProductCard(record.uid, anchor); return document.getElementById('productCard'); };
  const fill = row => { row.raw[H[10]] = '无线音箱'; row.raw[H[12]] = '黑色'; };
  return { H, record, controls, context, document, open, fill };
}

test('preview automatically fills Chinese fields without translation controls or pending copy', async () => {
  const gate = deferred(), h = harness({ ensure: () => gate.promise });
  const card = h.open();
  assert.equal(card.querySelector('[data-preview-field="10"]').hidden, true);
  assert.equal(card.querySelector('[data-preview-status]').hidden, true);
  assert.equal(card.querySelector('[data-retry-preview]'), null);
  assert.equal(card.querySelector('[data-edit-preview]'), null);
  assert.doesNotMatch(card.textContent, /Wireless speaker|Black|翻译中|待翻译|待补全/);
  h.fill(h.record); gate.resolve(); await flush();
  assert.equal(card.querySelector('[data-preview-chinese="10"]').textContent, '无线音箱');
  assert.equal(card.querySelector('[data-preview-chinese="12"]').textContent, '黑色');
  assert.equal(card.querySelector('[data-preview-field="10"]').hidden, false);
  assert.equal(card.querySelector('[data-preview-status]').hidden, true);
  assert.equal(card.querySelector('[data-generate-single]').disabled, false);
  assert.equal(h.controls.ensureCalls, 1); assert.equal(h.controls.categoryCalls, 1);
});

test('existing valid Chinese displays immediately and full wording is not shortened', async () => {
  const gate = deferred(), h = harness({ ensure: () => gate.promise });
  const title = '支持蓝牙连接的便携式无线音箱，含充电线与完整包装';
  h.record.raw[h.H[10]] = title; h.record.raw[h.H[12]] = '黑色，双扬声器，标准套装';
  const card = h.open();
  assert.equal(card.querySelector('[data-preview-chinese="10"]').textContent, title);
  assert.equal(card.querySelector('[data-preview-chinese="12"]').textContent, '黑色，双扬声器，标准套装');
  assert.equal(card.querySelector('[data-share-category]').textContent, '音响');
  assert.equal(card.querySelector('[data-generate-single]').disabled, false);
  gate.resolve(); await flush();
});

test('network failure gives one concise instruction and never a new empty link', async () => {
  const h = harness({ ensure: () => { throw new Error('Google 翻译连接超时，敏感内部错误'); } });
  const card = h.open(); await flush();
  assert.match(card.querySelector('[data-preview-status]').textContent, /上方“一键翻译”/);
  assert.doesNotMatch(card.textContent, /敏感内部错误|重试翻译|补全中文/);
  assert.equal(card.querySelector('[data-generate-single]').disabled, true);
  await card.querySelector('[data-generate-single]').onclick();
  assert.equal(card.querySelector('[data-preview-link]').hidden, true);
  assert.equal(card.querySelector('[data-retry-preview]'), null);
});

test('translation-editor and category-cache updates refresh an open card', async () => {
  const gate = deferred(), h = harness({ category: '', ensure: () => gate.promise, ensureCategory: () => gate.promise });
  const card = h.open();
  assert.equal(card.querySelector('[data-preview-field="category"]').hidden, true);
  h.fill(h.record); card.refreshChinese(h.record);
  assert.equal(card.querySelector('[data-preview-chinese="10"]').textContent, '无线音箱');
  assert.equal(card.querySelector('[data-generate-single]').disabled, true);
  h.controls.category = '影音娱乐 > 家用音响'; card.refreshCategory();
  assert.equal(card.querySelector('[data-share-category]').textContent, '影音娱乐 > 家用音响');
  assert.equal(card.querySelector('[data-generate-single]').disabled, false);
  gate.resolve(); await flush();
});

test('watcher discovers external cache changes and stops after the card closes', async () => {
  const h = harness({ category: '' }); const card = h.open(); await flush();
  h.fill(h.record); h.controls.category = '家用音响';
  const tick = () => { const [id, callback] = h.controls.timers.entries().next().value; h.controls.timers.delete(id); callback(); };
  tick();
  assert.equal(card.querySelector('[data-share-category]').textContent, '家用音响');
  assert.equal(card.querySelector('[data-preview-status]').hidden, true);
  h.context.closeProductCard(); tick(); assert.equal(h.controls.timers.size, 0);
});

test('old async work cannot update another dataset or same-UID replacement card', async () => {
  const oldGate = deferred(), newGate = deferred(); let call = 0;
  const h = harness({ ensure: () => (++call === 1 ? oldGate.promise : newGate.promise) });
  const oldCard = h.open(); await flush(); h.context.closeProductCard();
  const replacement = { ...h.record, raw: { ...h.record.raw } }; h.context.rows = [replacement];
  const newCard = h.open(); await flush();
  h.fill(h.record); oldGate.resolve(); await flush();
  assert.equal(newCard.querySelector('[data-preview-field="10"]').hidden, true);
  assert.equal(oldCard.querySelector('[data-preview-chinese="10"]').textContent, '');
  h.fill(replacement); newGate.resolve(); await flush();
  assert.equal(newCard.querySelector('[data-preview-chinese="10"]').textContent, '无线音箱');
});

test('raw source, empty fields and pending categories never count as ready Chinese', async () => {
  const h = harness({ category: '类目翻译中' });
  h.record.raw[h.H[10]] = 'Wireless speaker'; h.record.raw[h.H[12]] = 'Black';
  const card = h.open(); await flush();
  for (const key of ['10', '12', 'category']) assert.equal(card.querySelector('[data-preview-field="' + key + '"]').hidden, true);
  assert.doesNotMatch(card.textContent, /Wireless speaker|Black|类目翻译中/);
  assert.equal(card.querySelector('[data-generate-single]').disabled, true);
  h.record.raw = {}; card.refreshChinese(h.record);
  assert.equal(card.querySelector('[data-generate-single]').disabled, true);
});

test('generation or copy controls remain usable and changed Chinese invalidates old links', async () => {
  const h = harness(); h.fill(h.record); const card = h.open(); await flush();
  h.controls.generateError = new Error('translation transport rejected');
  await card.querySelector('[data-generate-single]').onclick();
  assert.match(card.querySelector('[data-preview-status]').textContent, /链接生成失败/);
  assert.equal(card.querySelector('[data-generate-single]').disabled, false);
  h.controls.generateError = null; await card.querySelector('[data-generate-single]').onclick();
  assert.equal(card.querySelector('[data-preview-link]').hidden, false);
  await card.querySelector('[data-copy-single]').onclick({ currentTarget: card.querySelector('[data-copy-single]') });
  assert.equal(card.querySelector('[data-copy-single]').textContent, '已复制');
  h.record.raw[h.H[10]] = '买手核对后的完整中文音箱名称'; card.refreshChinese(h.record);
  assert.equal(card.querySelector('[data-preview-link]').hidden, true);
});

function assertSingleLinkUnavailable(card) {
  const result = card.querySelector('[data-preview-link]'), open = card.querySelector('[data-open-single]');
  assert.ok(open, 'Single preview includes an actual open-link anchor');
  assert.equal(result.hidden, true, 'No usable result before generation or after invalidation');
  assert.equal(result.querySelector('input').value, '', 'Previous URL text is cleared');
  assert.equal(open.getAttribute('href'), null, 'A hidden anchor must not retain a navigable old URL');
  assert.equal(open.getAttribute('aria-disabled'), 'true');
  assert.equal(open.tabIndex, -1);
}

test('single open link is unavailable before generation and points to the exact generated URL afterward', async () => {
  const h = harness(); h.fill(h.record); const card = h.open(); await flush();
  assertSingleLinkUnavailable(card);
  const open = card.querySelector('[data-open-single]');
  assert.equal(open.tagName, 'A'); assert.ok(open.className.split(/\s+/).includes('btn'));
  await card.querySelector('[data-generate-single]').onclick();
  const generatedUrl = h.controls.generatedUrls.at(-1);
  assert.equal(card.querySelector('[data-preview-link]').hidden, false);
  assert.equal(open.href, generatedUrl);
  assert.equal(card.querySelector('[data-preview-link]').querySelector('input').value, generatedUrl);
  assert.equal(open.target, '_blank');
  assert.ok(open.rel.split(/\s+/).includes('noopener')); assert.ok(open.rel.split(/\s+/).includes('noreferrer'));
  assert.notEqual(open.getAttribute('aria-disabled'), 'true'); assert.equal(open.tabIndex, 0);
  await card.querySelector('[data-copy-single]').onclick({ currentTarget: card.querySelector('[data-copy-single]') });
  assert.deepEqual(h.controls.copiedUrls, [generatedUrl]);
  assert.equal(card.querySelector('[data-generate-single]').disabled, false);
});

test('updated title, model or category clears the old open href until a fresh link is generated', async () => {
  const h = harness(); h.fill(h.record); const card = h.open(); await flush();
  const changes = [
    () => { h.record.raw[h.H[10]] = '已更新的虚构中文标题'; card.refreshChinese(h.record); },
    () => { h.record.raw[h.H[12]] = '已更新的虚构黑色型号'; card.refreshChinese(h.record); },
    () => { h.controls.category = '影音娱乐 > 无线音箱'; card.refreshCategory(h.record); }
  ];
  for (const change of changes) {
    await card.querySelector('[data-generate-single]').onclick();
    const oldUrl = card.querySelector('[data-open-single]').href;
    change(); assertSingleLinkUnavailable(card);
    await card.querySelector('[data-generate-single]').onclick();
    const newUrl = card.querySelector('[data-open-single]').href;
    assert.notEqual(newUrl, oldUrl); assert.equal(newUrl, h.controls.generatedUrls.at(-1));
  }
});

test('a pending or failed regeneration never exposes the previous successful open URL', async () => {
  const h = harness(); h.fill(h.record); const card = h.open(); await flush();
  await card.querySelector('[data-generate-single]').onclick();
  assert.ok(card.querySelector('[data-open-single]')?.href);
  const gate = deferred(); h.controls.generate = () => gate.promise;
  const generating = card.querySelector('[data-generate-single]').onclick(); await flush();
  assertSingleLinkUnavailable(card); assert.equal(card.querySelector('[data-generate-single]').disabled, true);
  gate.reject(new Error('Fabricated generation failure')); await generating;
  assertSingleLinkUnavailable(card); assert.equal(card.querySelector('[data-generate-single]').disabled, false);
  assert.match(card.querySelector('[data-preview-status]').textContent, /链接生成失败/);
});

test('a link completed after Chinese changes is discarded rather than attributed to the new product snapshot', async () => {
  const h = harness(); h.fill(h.record); const card = h.open(); await flush();
  const gate = deferred(); h.controls.generate = () => gate.promise;
  const generating = card.querySelector('[data-generate-single]').onclick(); await flush();
  const staleUrl = h.controls.generatedUrls.at(-1);
  h.record.raw[h.H[10]] = '生成期间更新的虚构中文标题'; card.refreshChinese(h.record);
  gate.resolve(staleUrl); await generating;
  assertSingleLinkUnavailable(card); assert.equal(card.querySelector('[data-generate-single]').disabled, false);
  h.controls.generate = null; await card.querySelector('[data-generate-single]').onclick();
  assert.notEqual(card.querySelector('[data-open-single]').href, staleUrl);
  assert.equal(card.querySelector('[data-open-single]').href, h.controls.generatedUrls.at(-1));
});

test('generation from a replaced dataset cannot attach an old URL to the new same-UID card', async () => {
  const h = harness(); h.fill(h.record); const oldCard = h.open(); await flush();
  const gate = deferred(); h.controls.generate = () => gate.promise;
  const generating = oldCard.querySelector('[data-generate-single]').onclick(); await flush();
  const oldUrl = h.controls.generatedUrls.at(-1);
  h.context.closeProductCard();
  h.context.rows = [{ ...h.record, raw: { ...h.record.raw, [h.H[10]]: '另一个数据集的虚构中文标题' } }];
  const newCard = h.open(); await flush();
  gate.resolve(oldUrl); await generating;
  assertSingleLinkUnavailable(newCard);
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
