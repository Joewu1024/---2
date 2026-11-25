'use strict';

// The actual wrapper runs with fabricated selections and deferred services.
// No product information, network, clipboard or browser storage is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('// link-card-integration:start');
const end = html.indexOf('// link-card-integration:end', start);
assert.ok(start >= 0 && end > start);
const source = html.slice(start, end);
const originalUrl = 'https://example.test/s.html?d=cExactSnapshot&from=workbench#preserved';
const cardUrl = 'https://link-card-maker.app.workbuddy.host/c/TEST01?sharecode=26URNVPWDI';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function harness(options = {}) {
  const records = ['A', 'B', 'PRIVATE-UNSELECTED'].map(uid => ({ uid }));
  const controls = { sources: [], cards: [], originals: [], order: [], current: true };
  const context = vm.createContext({
    rows: records,
    async buildOnlineShareLink(selected, settings) {
      controls.sources.push({ selected: Array.from(selected), settings });
      controls.order.push('source');
      if (options.sourceError) throw options.sourceError;
      if (options.sourceGate) await options.sourceGate.promise;
      return originalUrl;
    },
    BuyerLinkCard: { async generate(url, settings) {
      controls.cards.push({ url, settings }); controls.order.push('card');
      if (options.cardGate) await options.cardGate.promise;
      if (options.cardError) throw options.cardError;
      return cardUrl;
    } }
  });
  vm.runInContext(source, context);
  return { records, context, controls, generate(selected = records.slice(0, 2), onOriginal) {
    return context.buildLinkCardShareLink(selected, {
      isCurrent: () => controls.current,
      onOriginal(url) { controls.originals.push(url); controls.order.push('original'); onOriginal?.(url); }
    });
  } };
}

test('single and bulk wrappers feed the exact source into the card tool and return only its new URL', async () => {
  for (const count of [1, 2]) {
    const h = harness(), selected = h.records.slice(0, count);
    assert.equal(await h.generate(selected), cardUrl);
    assert.deepEqual(h.controls.sources[0].selected.map(row => row.uid), selected.map(row => row.uid));
    assert.deepEqual(h.controls.originals, [originalUrl]);
    assert.equal(h.controls.cards[0].url, originalUrl);
    assert.equal(h.controls.cards[0].settings.count, count);
    assert.deepEqual(h.controls.order, ['source', 'original', 'card']);
    assert.equal(h.controls.sources[0].settings.isCurrent(), true);
  }
});

test('a rejected source, including count or size errors, never contacts the card tool', async () => {
  const h = harness({ sourceError: new Error('每次最多只能分享 11 个 Model') });
  await assert.rejects(h.generate(), /11 个 Model/);
  assert.deepEqual(h.controls.originals, []); assert.deepEqual(h.controls.cards, []);
});

test('closing or replacing a dataset while preparing the source prevents prefill and external submission', async () => {
  for (const change of ['close', 'dataset', 'record']) {
    const gate = deferred(), h = harness({ sourceGate: gate }), pending = h.generate();
    await flush();
    if (change === 'close') h.controls.current = false;
    if (change === 'dataset') h.context.rows = [...h.records];
    if (change === 'record') h.records[0] = { uid: 'A' };
    gate.resolve();
    await assert.rejects(pending, /已变更/, change);
    assert.deepEqual(h.controls.originals, [], change); assert.deepEqual(h.controls.cards, [], change);
  }
});

test('closing during prefill prevents submission and closing during service work rejects the late card URL', async () => {
  const before = harness();
  await assert.rejects(before.generate(undefined, () => { before.controls.current = false; }), /已变更/);
  assert.deepEqual(before.controls.cards, []);
  const gate = deferred(), after = harness({ cardGate: gate }), pending = after.generate();
  await flush(); assert.equal(after.controls.cards.length, 1);
  after.controls.current = false; gate.resolve();
  await assert.rejects(pending, /已变更/);
});

test('a card-service failure remains an error and never returns the original long URL as a substitute', async () => {
  const h = harness({ cardError: new Error('外链工具暂不可用') });
  await assert.rejects(h.generate(), /外链工具暂不可用/);
  assert.equal(h.controls.cards.length, 1);
});
