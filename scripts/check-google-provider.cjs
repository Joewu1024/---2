'use strict';

// All titles and responses are fabricated; these checks never contact Google.
const assert = require('node:assert/strict');
const { test, after, mock } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
require('../translation-engine.js');
const provider = require('../translation-google-provider.js');

mock.method(globalThis, 'fetch', () => { throw new Error('Network access is forbidden in Google provider checks'); });
after(() => mock.restoreAll());

function response(...segments) {
  return { ok: true, status: 200, json: async () => [segments.map(text => [text])] };
}

function setup(handler, options = {}) {
  const fetchImpl = mock.fn(async (input, init) => handler(new URL(input), init));
  return { ...provider.create({ fetchImpl, ...options }), fetchImpl };
}

function qualityFailure(error) {
  assert.ok(error.message);
  assert.equal(error.permanent, true);
  assert.equal(error.qualityFailed, true);
  return true;
}

test('exports a browser global and the same CommonJS API', () => {
  assert.strictEqual(globalThis.BuyerGoogleTranslation, provider);
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../translation-google-provider.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.BuyerGoogleTranslation.create, 'function');
});

test('sends each complete item separately and joins Google segments in response order', async () => {
  const titles = ['Portable speaker FICT801\nwith cable', 'Wireless microphone FICT802'];
  const translated = ['便携音箱 FICT801，附电缆', '无线麦克风 FICT802'];
  const h = setup(url => {
    assert.equal(url.origin + url.pathname, 'https://translate.googleapis.com/translate_a/single');
    assert.equal(url.searchParams.get('client'), 'gtx');
    assert.equal(url.searchParams.get('sl'), 'auto');
    assert.equal(url.searchParams.get('tl'), 'zh-CN');
    assert.equal(url.searchParams.get('dt'), 't');
    const index = titles.indexOf(url.searchParams.get('q'));
    assert.notEqual(index, -1, 'q is one intact title, including its own line break');
    return index === 0 ? response('便携音箱 ', 'FICT801，', '附电缆') : response(translated[index]);
  });
  assert.deepEqual(await Promise.all(titles.map(title => h.translate(title, 'en', { kind: 'item' }))), translated);
  assert.equal(h.fetchImpl.mock.callCount(), 2);
});

test('retries an unusable auto result once with a concrete language hint', async () => {
  const source = 'Caixa de som FICT803';
  const h = setup(url => response(url.searchParams.get('sl') === 'auto' ? source : '音箱 FICT803'));
  assert.equal(await h.translate(source, 'pt'), '音箱 FICT803');
  assert.deepEqual(h.fetchImpl.mock.calls.map(call => new URL(call.arguments[0]).searchParams.get('sl')), ['auto', 'pt']);
  assert.ok(h.fetchImpl.mock.calls.every(call => new URL(call.arguments[0]).searchParams.get('q') === source));
});

test('a valid auto result is returned without a second request', async () => {
  const h = setup(() => response('便携音箱 FICT804'));
  assert.equal(await h.translate('Portable speaker FICT804', 'en'), '便携音箱 FICT804');
  assert.equal(h.fetchImpl.mock.callCount(), 1);
});

test('auto without a concrete hint fails once with a visible permanent quality error', async () => {
  const h = setup(() => response('untranslated fragment'));
  await assert.rejects(h.translate('Portable speaker FICT805'), qualityFailure);
  assert.equal(h.fetchImpl.mock.callCount(), 1);
});

test('a custom validator rejection stops after auto and the hint', async () => {
  const validate = mock.fn(() => false);
  const h = setup(() => response('便携音箱 FICT806'), { validate });
  await assert.rejects(h.translate('Portable speaker FICT806', 'en'), qualityFailure);
  assert.equal(h.fetchImpl.mock.callCount(), 2);
  assert.equal(validate.mock.callCount(), 2);
});

test('a permissive validator still cannot accept a result without Chinese', async () => {
  const h = setup(() => response('not translated'), { validate: () => true });
  await assert.rejects(h.translate('Portable speaker FICT807'), qualityFailure);
});

test('a model uppercase brand prefix is never submitted for translation', async () => {
  const h = setup(url => {
    assert.equal(url.searchParams.get('q'), 'pocket speaker FICT808');
    return response('口袋音箱 FICT808');
  });
  assert.equal(await h.translate('FABLEO pocket speaker FICT808', 'en', { kind: 'model' }), 'FABLEO 口袋音箱 FICT808');
  assert.equal(h.fetchImpl.mock.callCount(), 1);
});

test('an explicit model brand keeps its original spelling and separator', async () => {
  const h = setup(url => {
    assert.equal(url.searchParams.get('q'), 'pocket speaker FICT809');
    return response('口袋音箱 FICT809');
  });
  assert.equal(await h.translate('Fableo: pocket speaker FICT809', 'en', { kind: 'model', brand: 'FABLEO' }), 'Fableo: 口袋音箱 FICT809');
});

for (const prefix of ['NEW', 'KIT', 'BLACK']) {
  test('generic uppercase ' + prefix + ' is translated as part of a model description', async () => {
    const source = prefix + ' pocket speaker FICT810';
    const h = setup(url => {
      assert.equal(url.searchParams.get('q'), source);
      return response('虚构商品音箱 FICT810');
    });
    assert.equal(await h.translate(source, 'en', { kind: 'model' }), '虚构商品音箱 FICT810');
  });
}

test('an intact item result containing its brand is never split or requested again', async () => {
  const source = 'Wireless FABLEO speaker FICT811';
  const h = setup(url => {
    assert.equal(url.searchParams.get('q'), source);
    return response('FABLEO 无线音箱 FICT811');
  });
  assert.equal(await h.translate(source, 'en', { kind: 'item', brand: 'FABLEO' }), 'FABLEO 无线音箱 FICT811');
  assert.equal(h.fetchImpl.mock.callCount(), 1);
});

test('only a lost source brand triggers ordered fragment translation and exact restoration', async () => {
  const source = 'Wireless Fableo speaker FICT812';
  const answers = new Map([[source, '无线虚构牌音箱 FICT812'], ['Wireless', '无线'], ['speaker FICT812', '音箱 FICT812']]);
  const requested = [];
  const h = setup(url => {
    const text = url.searchParams.get('q');
    requested.push(text);
    assert.ok(answers.has(text));
    assert.doesNotMatch(text, /ZXQ/);
    return response(answers.get(text));
  });
  assert.equal(await h.translate(source, 'en', { kind: 'item', brand: 'FABLEO' }), '无线 Fableo 音箱 FICT812');
  assert.deepEqual(requested, [source, 'Wireless', 'speaker FICT812']);
});

test('an unrelated brand hint neither rewrites nor splits the item', async () => {
  const source = 'Wireless speaker FICT813';
  const h = setup(url => {
    assert.equal(url.searchParams.get('q'), source);
    return response('无线音箱 FICT813');
  });
  assert.equal(await h.translate(source, 'en', { kind: 'item', brand: 'FABLEO' }), '无线音箱 FICT813');
  assert.equal(h.fetchImpl.mock.callCount(), 1);
});

test('a damaged description remains a visible failure instead of fabricating its missing words', async () => {
  const h = setup(url => {
    assert.equal(url.searchParams.get('q'), 'N?va C?r FICT814');
    return response('N?va C?r FICT814');
  });
  await assert.rejects(h.translate('FABLEO N?va C?r FICT814', 'pt', { kind: 'model' }), qualityFailure);
  assert.equal(h.fetchImpl.mock.callCount(), 2);
});

for (const seconds of ['7', '0', '1.5']) {
  test('HTTP 429 exposes Retry-After seconds ' + seconds + ' without retrying internally', async () => {
    const h = setup(() => ({ status: 429, headers: { get: name => name.toLowerCase() === 'retry-after' ? seconds : null } }));
    await assert.rejects(h.translate('Portable speaker FICT815', 'en'), error => {
      assert.equal(error.rateLimited, true);
      assert.equal(error.retryAfter, Number(seconds) * 1000);
      assert.ok(error.message);
      return true;
    });
    assert.equal(h.fetchImpl.mock.callCount(), 1);
  });
}

test('HTTP 429 respects an HTTP-date Retry-After', async () => {
  const retryAt = Math.ceil((Date.now() + 12000) / 1000) * 1000;
  const h = setup(() => ({ status: 429, headers: { get: () => new Date(retryAt).toUTCString() } }));
  const before = Date.now();
  await assert.rejects(h.translate('Portable speaker FICT816'), error => {
    assert.equal(error.rateLimited, true);
    assert.ok(error.retryAfter <= retryAt - before);
    assert.ok(error.retryAfter >= retryAt - Date.now());
    return true;
  });
});

test('a timeout aborts the request even when a fetch adapter never resolves', { timeout: 2000 }, async () => {
  let signal;
  const h = setup((url, init) => {
    signal = init.signal;
    return new Promise(() => {});
  }, { timeoutMs: 15 });
  await assert.rejects(h.translate('Portable speaker FICT817'), error => {
    assert.equal(error.timeout, true);
    assert.match(error.message, /超时/);
    return true;
  });
  assert.equal(signal.aborted, true);
  assert.equal(h.fetchImpl.mock.callCount(), 1);
});

for (const payload of [null, {}, [], [[]], [[['中文'], null]], [[[123]]]]) {
  test('rejects malformed Google payload ' + JSON.stringify(payload), async () => {
    const h = setup(() => ({ status: 200, json: async () => payload }));
    await assert.rejects(h.translate('Portable speaker FICT818'), qualityFailure);
  });
}

test('invalid JSON has a readable permanent quality error', async () => {
  const h = setup(() => ({ status: 200, json: async () => { throw new SyntaxError('fabricated malformed JSON'); } }));
  await assert.rejects(h.translate('Portable speaker FICT819'), qualityFailure);
});

test('service errors never switch to another host or retry with a language hint', async () => {
  const h = setup(url => {
    assert.equal(url.hostname, 'translate.googleapis.com');
    return { status: 503 };
  });
  await assert.rejects(h.translate('Portable speaker FICT820', 'en'), /503/);
  assert.equal(h.fetchImpl.mock.callCount(), 1);
});

test('empty input returns without invoking fetch', async () => {
  const h = setup(() => { throw new Error('empty input should not fetch'); });
  assert.equal(await h.translate('  '), '');
  assert.equal(h.fetchImpl.mock.callCount(), 0);
});
