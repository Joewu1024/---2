'use strict';

// Fabricated URLs, IDs and storage only. These tests never read browser/user data.
const assert = require('node:assert/strict');
const { test, after, mock } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const workspace = require('../workbench-workspace.js');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const BASE = 'https://example.invalid/buyer/index.html';

if (typeof globalThis.fetch === 'function') {
  mock.method(globalThis, 'fetch', () => { throw new Error('Workspace tests must stay offline'); });
}
after(() => mock.restoreAll());

function context(id) {
  return workspace.resolve({ href: BASE + (id ? '?workspace=' + id : '') });
}

function mockLocks() {
  const held = new Set();
  const pending = new Set();
  const calls = [];
  const locks = {
    request(name, options, callback) {
      calls.push({ name, options });
      assert.deepEqual(options, { mode: 'exclusive', ifAvailable: true });
      if (held.has(name)) return Promise.resolve(callback(null));
      held.add(name);
      const promise = Promise.resolve().then(() => callback({ name })).finally(() => {
        held.delete(name);
        pending.delete(promise);
      });
      pending.add(promise);
      return promise;
    }
  };
  return { navigator: { locks }, calls, drain: () => Promise.all([...pending]) };
}

test('exports a browser global and CommonJS API', () => {
  assert.strictEqual(globalThis.BuyerWorkspace, workspace);
  const sandbox = { URL, Uint8Array };
  vm.runInNewContext(fs.readFileSync(require.resolve('../workbench-workspace.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.BuyerWorkspace.resolve, 'function');
  assert.equal(sandbox.BuyerWorkspace.blankShareUrl(BASE), BASE + '?new=1');
});

test('the default entry preserves every legacy storage name without creating an ID', () => {
  const current = workspace.resolve({ href: BASE, crypto: null, history: null });
  assert.equal(current.id, null);
  assert.equal(current.created, false);
  assert.equal(current.isDefault, true);
  assert.equal(current.dbName(), 'buyer-pool-workbench');
  assert.equal(current.storageKey('pool-workbench-v2'), 'pool-workbench-v2');
  assert.equal(current.storageKey('pool-buyer-custom-options-v1'), 'pool-buyer-custom-options-v1');
  assert.equal(current.workspaceLabel(), '本机默认工作区');
  assert.equal(Object.isFrozen(current), true);
});

test('a generic blank link discards workspace, product fragments and all other query data', () => {
  const href = 'https://fake:fake@example.invalid/buyer/index.html?workspace=' + A + '&secret=fake#product=fake';
  assert.equal(workspace.blankShareUrl(href), BASE + '?new=1');
  assert.equal(context(A).blankShareUrl(), BASE + '?new=1');
  assert.equal(workspace.blankShareUrl('file:///C:/fake/index.html?workspace=' + A + '#fake'), 'file:///C:/fake/index.html?new=1');
});

test('first blank-link open replaces the address; refresh reopens the exact same workspace', () => {
  const state = { fake: true };
  const calls = [];
  const history = { state, replaceState: (...args) => calls.push(args) };
  const first = workspace.resolve({ href: BASE + '?new=1#fake', history, crypto: { randomUUID: () => A } });
  assert.equal(first.created, true);
  assert.equal(first.id, A);
  assert.equal(first.href, BASE + '?workspace=' + A);
  assert.deepEqual(calls, [[state, '', first.href]]);
  const refreshed = workspace.resolve({ href: first.href, crypto: null, history: null });
  assert.equal(refreshed.id, A);
  assert.equal(refreshed.created, false);
  assert.equal(refreshed.dbName(), first.dbName());
});

test('separate opens of a generic blank link create independent namespaces', () => {
  const ids = [A, B];
  const opts = { href: BASE + '?new=1', history: { replaceState() {} }, crypto: { randomUUID: () => ids.shift() } };
  const a = workspace.resolve(opts);
  const b = workspace.resolve(opts);
  assert.notEqual(a.dbName(), b.dbName());
  assert.notEqual(a.storageKey('pool-workbench-v2'), b.storageKey('pool-workbench-v2'));
});

test('legacy records and options are untouched; new workspaces have no legacy fallback key', () => {
  const fakeStorage = new Map([
    ['buyer-pool-workbench', { fakeRecords: ['legacy'] }],
    ['pool-workbench-v2', '{"fake":"legacy"}'],
    ['pool-buyer-custom-options-v1', '{"fake":"legacy option"}']
  ]);
  const before = [...fakeStorage.entries()];
  const a = context(A);
  assert.equal(fakeStorage.get(a.dbName()), undefined);
  assert.equal(fakeStorage.get(a.storageKey('pool-workbench-v2')), undefined);
  assert.equal(fakeStorage.get(a.storageKey('pool-buyer-custom-options-v1')), undefined);
  assert.deepEqual([...fakeStorage.entries()], before);
  fakeStorage.set(a.dbName(), { fakeRecords: ['buyer A'] });
  assert.equal(fakeStorage.get(context(B).dbName()), undefined);
  assert.deepEqual(fakeStorage.get('buyer-pool-workbench'), { fakeRecords: ['legacy'] });
});

test('each private persistence base receives the same validated namespace', () => {
  const a = context(A);
  assert.equal(a.dbName(), 'buyer-pool-workbench:workspace:' + A);
  assert.equal(a.storageKey('pool-buyer-custom-options-v1'), 'pool-buyer-custom-options-v1:workspace:' + A);
  assert.equal(a.storageKey('pool-workbench-v2'), 'pool-workbench-v2:workspace:' + A);
  assert.equal(workspace.dbName('fake', A), 'fake:workspace:' + A);
  assert.equal(workspace.storageKey('fake', A), 'fake:workspace:' + A);
  assert.equal(a.workspaceLabel(), '本机独立工作区 · 11111111');
});

test('UUIDs normalize case and invalid, empty or ambiguous selectors fail closed', () => {
  const upper = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  assert.equal(context(upper).id, upper.toLowerCase());
  for (const value of ['', '../fake', 'buyer-pool-workbench', 'null', 'fake', '11111111-1111-1111-8111-111111111111', A + '/fake', A + '\n']) {
    assert.throws(() => workspace.resolve({ href: BASE + '?workspace=' + encodeURIComponent(value) }), /工作区地址/);
  }
  for (const query of ['?workspace=' + A + '&workspace=' + B, '?new=1&new=1', '?new=0', '?new=', '?workspace=&new=1']) {
    assert.throws(() => workspace.resolve({ href: BASE + query }), /工作区地址/);
  }
  assert.throws(() => workspace.dbName('fake', '../fake'), /工作区地址/);
  assert.throws(() => workspace.storageKey('fake', ''), /工作区地址/);
  assert.throws(() => workspace.blankShareUrl('javascript:fake'), /HTTP/);
});

test('blank creation fails closed without secure randomness or successful address replacement', () => {
  const opts = { href: BASE + '?new=1', history: { replaceState() {} }, crypto: null };
  assert.throws(() => workspace.resolve(opts), /无法安全创建/);
  assert.throws(() => workspace.resolve({ ...opts, history: null }), /无法保留/);
  assert.throws(() => workspace.resolve({ ...opts, crypto: { randomUUID: () => 'fake' } }), /工作区地址/);
  assert.throws(() => workspace.resolve({ ...opts, crypto: { randomUUID: () => A }, history: { replaceState() { throw new Error('fake blocked history'); } } }), /fake blocked history/);
});

test('secure getRandomValues fallback produces a canonical UUID v4', () => {
  const current = workspace.resolve({
    href: BASE + '?new=1',
    history: { replaceState() {} },
    crypto: { getRandomValues(bytes) { bytes.fill(170); return bytes; } }
  });
  assert.equal(current.id, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
});

test('one workspace has one writer; a second tab cannot steal or release its lock', async () => {
  const locks = mockLocks();
  const first = await workspace.acquireWriter(context(A), locks);
  const second = await workspace.acquireWriter(context(A), locks);
  assert.equal(first.owner, true);
  assert.equal(first.status, 'owner');
  assert.equal(second.owner, false);
  assert.equal(second.status, 'busy');
  assert.equal(second.release(), false);
  const stillBusy = await workspace.acquireWriter(context(A), locks);
  assert.equal(stillBusy.status, 'busy');
  assert.equal(first.release(), true);
  assert.equal(first.release(), false);
  assert.equal(first.owner, false);
  assert.equal(first.status, 'released');
  await locks.drain();
  const afterClose = await workspace.acquireWriter(context(A), locks);
  assert.equal(afterClose.owner, true);
  afterClose.release();
  await locks.drain();
});

test('separate workspace tabs and the legacy default can all own their own writer lock', async () => {
  const locks = mockLocks();
  const owners = await Promise.all([context(null), context(A), context(B)].map(current => workspace.acquireWriter(current, locks)));
  assert.ok(owners.every(owner => owner.owner));
  assert.equal(new Set(locks.calls.map(call => call.name)).size, 3);
  assert.equal(locks.calls[0].name, 'buyer-pool-workbench:writer');
  owners.forEach(owner => owner.release());
  await locks.drain();
});

test('an unsupported or failed lock implementation never grants write permission', async () => {
  for (const navigator of [null, {}, { locks: {} }]) {
    const result = await workspace.acquireWriter(context(A), { navigator });
    assert.equal(result.owner, false);
    assert.equal(result.status, 'unsupported');
    assert.equal(result.release(), false);
  }
  for (const request of [() => { throw new Error('fake denied'); }, () => Promise.reject(new Error('fake denied'))]) {
    const result = await workspace.acquireWriter(context(A), { navigator: { locks: { request } } });
    assert.equal(result.owner, false);
    assert.equal(result.status, 'error');
    assert.match(result.error.message, /fake denied/);
  }
});
