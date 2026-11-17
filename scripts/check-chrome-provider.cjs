'use strict';

// Native API contract tests with fabricated text only. No browser model or network is used.
const assert = require('node:assert/strict');
const { test, afterEach, mock } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const api = require('../translation-chrome-provider.js');
const providers = new Set();

afterEach(() => {
  for (const provider of providers) provider.destroy();
  providers.clear();
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function instance(handler = async text => '本地译文：' + text) {
  return { translate: mock.fn(handler), destroy: mock.fn() };
}

function setup(handlers = {}, options = {}) {
  const instances = [];
  const TranslatorImpl = {
    availability: mock.fn(handlers.availability || (async () => 'downloadable')),
    create: mock.fn(handlers.create || (async () => {
      const value = instance();
      instances.push(value);
      return value;
    }))
  };
  const provider = api.create({ TranslatorImpl, ...options });
  providers.add(provider);
  return { provider, TranslatorImpl, instances };
}

test('exports the same CommonJS and browser API', () => {
  assert.equal(globalThis.BuyerChromeTranslation, api);
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../translation-chrome-provider.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.BuyerChromeTranslation.create, 'function');
});

test('a missing native API is unavailable without pretending to translate', async () => {
  const provider = api.create({ TranslatorImpl: null });
  providers.add(provider);
  assert.equal(await provider.available('en'), 'unavailable');
  assert.equal((await provider.prepareLanguages(['en']))[0].status, 'unavailable');
  await assert.rejects(provider.translate('Fictional portable speaker', 'en'), { notPrepared: true });
});

test('availability preserves all four native states and canonicalizes regional tags', async () => {
  const reported = ['available', 'downloadable', 'downloading', 'unavailable'];
  const h = setup({ availability: async () => reported.shift() });
  for (const expected of ['available', 'downloadable', 'downloading', 'unavailable']) {
    assert.equal(await h.provider.available('pt-BR', 'zh-CN'), expected);
  }
  for (const call of h.TranslatorImpl.availability.mock.calls) {
    assert.deepEqual(call.arguments[0], { sourceLanguage: 'pt', targetLanguage: 'zh' });
  }
  assert.equal(h.TranslatorImpl.create.mock.callCount(), 0);
});

test('native unsupported and unknown availability values do not become available', async () => {
  const h = setup({ availability: async () => 'future-unknown-state' });
  assert.equal(await h.provider.available('ms-MY'), 'unavailable');
  assert.equal((await h.provider.prepareLanguages(['ms']))[0].status, 'unavailable');
  assert.equal(h.TranslatorImpl.create.mock.callCount(), 0);
});

test('auto and invalid tags require a concrete language hint without native calls', async () => {
  const h = setup();
  assert.equal(await h.provider.available('auto'), 'unavailable');
  assert.equal(await h.provider.available('not_a_language'), 'unavailable');
  const report = await h.provider.prepareLanguages(['auto']);
  assert.equal(report[0].status, 'unavailable');
  assert.equal(report[0].error.languageHintRequired, true);
  await assert.rejects(h.provider.translate('Fictional speaker', 'auto'), { languageHintRequired: true });
  assert.equal(h.TranslatorImpl.create.mock.callCount(), 0);
});

test('prepare invokes every create synchronously in the explicit click stack', async () => {
  let clicked = true;
  const h = setup({ create: () => {
    assert.equal(clicked, true, 'native create must retain transient user activation');
    return Promise.resolve(instance());
  }});
  const pending = h.provider.prepareLanguages(['en-US', 'vi-VN', 'pt-BR', 'en']);
  clicked = false;
  assert.equal(h.TranslatorImpl.create.mock.callCount(), 3);
  assert.equal(h.TranslatorImpl.availability.mock.callCount(), 0, 'no awaited availability call before create');
  assert.deepEqual((await pending).map(row => [row.sourceLanguage, row.status]), [['en', 'available'], ['vi', 'available'], ['pt', 'available']]);
});

test('prepare caches a ready pair and handles traditional Chinese separately', async () => {
  const h = setup();
  await h.provider.prepareLanguages(['en-US']);
  await h.provider.prepareLanguages(['en-GB']);
  await h.provider.prepareLanguages(['en'], { targetLanguage: 'zh-TW' });
  assert.equal(h.TranslatorImpl.create.mock.callCount(), 2);
  assert.equal(h.TranslatorImpl.create.mock.calls[1].arguments[0].targetLanguage, 'zh-Hant');
  assert.equal(await h.provider.available('en'), 'available');
});

test('one unsupported native pair does not hide success or user activation errors', async () => {
  const h = setup({ create: ({ sourceLanguage }) => {
    if (sourceLanguage === 'ms') throw Object.assign(new Error('No model'), { name: 'NotSupportedError' });
    if (sourceLanguage === 'vi') throw Object.assign(new Error('Needs user activation'), { name: 'NotAllowedError' });
    return Promise.resolve(instance());
  }});
  const report = await h.provider.prepareLanguages(['en', 'ms', 'vi']);
  assert.deepEqual(report.map(row => row.status), ['available', 'unavailable', 'error']);
  assert.equal(report[2].error.name, 'NotAllowedError');
  assert.equal(await h.provider.translate('Fictional speaker', 'en'), '本地译文：Fictional speaker');
});

test('download progress reaches the UI and its listener is removed after prepare', async () => {
  const gate = deferred(), events = [];
  const monitor = new EventTarget();
  const remove = mock.method(monitor, 'removeEventListener');
  const h = setup({ create: options => { options.monitor(monitor); return gate.promise; } });
  const pending = h.provider.prepareLanguages(['pt'], { onProgress: event => events.push(event) });
  const progress = Object.assign(new Event('downloadprogress'), { loaded: 0.4 });
  monitor.dispatchEvent(progress);
  gate.resolve(instance());
  await pending;
  assert.deepEqual(events.map(event => [event.status, event.loaded]), [['downloading', 0], ['downloading', 0.4], ['available', 1]]);
  assert.ok(events.every(event => event.sourceLanguage === 'pt' && event.targetLanguage === 'zh' && event.total === 1));
  assert.equal(remove.mock.callCount(), 1);
  monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 0.9 }));
  assert.equal(events.length, 3);
});

test('a throwing UI progress callback does not break native preparation', async () => {
  const h = setup();
  assert.equal((await h.provider.prepareLanguages(['en'], { onProgress() { throw new Error('UI failure'); } }))[0].status, 'available');
});

test('translate never creates an unprepared model, even when native availability is available', async () => {
  const h = setup({ availability: async () => 'available' });
  assert.equal(await h.provider.available('en'), 'available');
  await assert.rejects(h.provider.translate('Fictional speaker', 'en'), { notPrepared: true });
  assert.equal(h.TranslatorImpl.create.mock.callCount(), 0);
});

test('translate sends one complete string and returns the actual local model output', async () => {
  const native = instance(async () => '虚构型号 FICT901 本地译文');
  const h = setup({ create: async () => native });
  await h.provider.prepareLanguages(['en']);
  const source = 'Fictional portable speaker FICT901\nwith microphone';
  assert.equal(await h.provider.translate(source, 'en-US'), '虚构型号 FICT901 本地译文');
  assert.equal(native.translate.mock.calls[0].arguments[0], source);
  assert.ok(native.translate.mock.calls[0].arguments[1].signal instanceof AbortSignal);
});

test('same-pair translations run serially while different pairs can proceed', async () => {
  const gate = deferred(), calls = [];
  const h = setup({ create: async ({ sourceLanguage }) => instance(async text => {
    calls.push(sourceLanguage + ':' + text);
    if (text === 'one') await gate.promise;
    return '本地：' + text;
  }) });
  await h.provider.prepareLanguages(['en', 'pt']);
  const first = h.provider.translate('one', 'en');
  const second = h.provider.translate('two', 'en');
  assert.equal(await h.provider.translate('three', 'pt'), '本地：three');
  assert.deepEqual(calls, ['en:one', 'pt:three']);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['本地：one', '本地：two']);
  assert.deepEqual(calls, ['en:one', 'pt:three', 'en:two']);
});

test('cancelling a queued middle job cannot let later work overtake an active job', async () => {
  const gate = deferred(), calls = [];
  const native = instance(async text => { calls.push(text); if (text === 'first') await gate.promise; return '译：' + text; });
  const h = setup({ create: async () => native });
  await h.provider.prepareLanguages(['en']);
  const first = h.provider.translate('first', 'en');
  const controller = new AbortController();
  const second = h.provider.translate('cancelled', 'en', { signal: controller.signal });
  const rejection = assert.rejects(second, { name: 'AbortError' });
  const third = h.provider.translate('third', 'en');
  controller.abort();
  await rejection;
  await flush();
  assert.deepEqual(calls, ['first']);
  assert.equal(native.destroy.mock.callCount(), 0);
  gate.resolve();
  await Promise.all([first, third]);
  assert.deepEqual(calls, ['first', 'third']);
});

test('an active timeout aborts and destroys a hung native model without waiting for it', async () => {
  const gate = deferred(), native = instance(() => gate.promise);
  const h = setup({ create: async () => native });
  await h.provider.prepareLanguages(['en']);
  await assert.rejects(h.provider.translate('Fictional speaker', 'en', { timeoutMs: 15 }), { timeout: true });
  assert.equal(native.translate.mock.calls[0].arguments[1].signal.aborted, true);
  assert.equal(native.destroy.mock.callCount(), 1);
  await assert.rejects(h.provider.translate('Another title', 'en'), { notPrepared: true });
  gate.resolve('late output');
  await flush();
});

test('active cancellation releases the pair and rejects queued work', async () => {
  const gate = deferred(), native = instance(() => gate.promise);
  const h = setup({ create: async () => native });
  await h.provider.prepareLanguages(['vi']);
  const controller = new AbortController();
  const active = h.provider.translate('Tai nghe FICT902', 'vi', { signal: controller.signal });
  const queued = h.provider.translate('Tai nghe FICT903', 'vi');
  const rejected = Promise.all([assert.rejects(active, { name: 'AbortError' }), assert.rejects(queued, { name: 'AbortError' })]);
  await flush();
  controller.abort();
  await rejected;
  assert.equal(native.destroy.mock.callCount(), 1);
  assert.equal(native.translate.mock.callCount(), 1);
  gate.resolve('late output');
});

test('prepare timeout aborts native download and destroys a late model', async () => {
  const gate = deferred(), native = instance();
  let signal;
  const h = setup({ create: options => { signal = options.signal; return gate.promise; } });
  const report = await h.provider.prepareLanguages(['en'], { timeoutMs: 15 });
  assert.equal(report[0].status, 'error');
  assert.equal(report[0].error.timeout, true);
  assert.equal(signal.aborted, true);
  gate.resolve(native);
  await flush();
  assert.equal(native.destroy.mock.callCount(), 1);
});

test('cancelling prepare releases downloads; aborting its signal after success keeps the pair', async () => {
  const gate = deferred(), native = instance();
  const h = setup({ create: () => gate.promise });
  const controller = new AbortController();
  const pending = h.provider.prepareLanguages(['en'], { signal: controller.signal });
  controller.abort();
  assert.equal((await pending)[0].error.name, 'AbortError');
  gate.resolve(native);
  await flush();
  assert.equal(native.destroy.mock.callCount(), 1);
  const second = setup();
  const afterSuccess = new AbortController();
  await second.provider.prepareLanguages(['en'], { signal: afterSuccess.signal });
  afterSuccess.abort();
  assert.equal(await second.provider.translate('Fictional title', 'en'), '本地译文：Fictional title');
});

test('destroy rejects pending creation promptly and destroys its late result', async () => {
  const gate = deferred(), native = instance();
  const h = setup({ create: () => gate.promise });
  const pending = h.provider.prepareLanguages(['pt']);
  h.provider.destroy();
  assert.equal((await pending)[0].error.destroyed, true);
  assert.equal(await h.provider.available('pt'), 'unavailable');
  gate.resolve(native);
  await flush();
  assert.equal(native.destroy.mock.callCount(), 1);
  await assert.rejects(h.provider.translate('Fictional title', 'pt'), { destroyed: true });
});

test('an already cancelled prepare never starts a native download', async () => {
  const h = setup(), controller = new AbortController();
  controller.abort();
  const report = await h.provider.prepareLanguages(['en', 'vi'], { signal: controller.signal });
  assert.ok(report.every(row => row.status === 'error' && row.error.name === 'AbortError'));
  assert.equal(h.TranslatorImpl.create.mock.callCount(), 0);
});

test('overlapping prepare calls share the same pair and destroy stops pending availability', async () => {
  const creation = deferred(), availability = deferred();
  const h = setup({ create: () => creation.promise, availability: () => availability.promise });
  const first = h.provider.prepareLanguages(['en']);
  const second = h.provider.prepareLanguages(['en-US']);
  assert.equal(h.TranslatorImpl.create.mock.callCount(), 1);
  creation.resolve(instance());
  assert.equal((await first)[0].status, 'available');
  assert.equal((await second)[0].status, 'available');
  const pending = h.provider.available('vi');
  h.provider.destroy();
  assert.equal(await pending, 'unavailable');
  availability.resolve('downloadable');
});

test('failed preparation can be explicitly retried and empty model output is rejected', async () => {
  let attempts = 0;
  const h = setup({ create: () => {
    if (!attempts++) return Promise.reject(new Error('Transient download failure'));
    return Promise.resolve(instance(async () => ''));
  }});
  assert.equal((await h.provider.prepareLanguages(['en']))[0].status, 'error');
  assert.equal((await h.provider.prepareLanguages(['en']))[0].status, 'available');
  assert.equal(h.TranslatorImpl.create.mock.callCount(), 2);
  await assert.rejects(h.provider.translate('Fictional title', 'en'), { qualityFailed: true });
});
