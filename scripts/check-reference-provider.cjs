'use strict';

// Fabricated product strings and mocked fetch only. No requests contact Tencent or another service.
const assert = require('node:assert/strict');
const { test, after, mock } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
require('../translation-engine.js');
const provider = require('../translation-reference-provider.js');

mock.method(globalThis, 'fetch', () => { throw new Error('Network access is forbidden in reference provider checks'); });
after(() => mock.restoreAll());

function response(values) {
  return { status: 200, json: async () => ({ header: { ret_code: 'succ' }, auto_translation: values }) };
}

function setup(handler, options = {}) {
  const fetchImpl = mock.fn(async (input, init) => handler(JSON.parse(init.body), init, input));
  return { ...provider.create({ fetchImpl, ...options }), fetchImpl };
}

test('exports the same browser global and CommonJS API', () => {
  assert.strictEqual(globalThis.BuyerReferenceTranslation, provider);
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../translation-reference-provider.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.BuyerReferenceTranslation.create, 'function');
});

test('uses the reference protocol with native arrays, complete text and no placeholder markers', async () => {
  const texts = ['Caixa de som FICT901\ncom cabo', 'Microfone FICT902'];
  const expected = ['音箱 FICT901，附电缆', '麦克风 FICT902'];
  const h = setup((payload, init, input) => {
    assert.equal(input, 'https://transmart.qq.com/api/imt');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'omit');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(Object.keys(payload).sort(), ['header', 'model_category', 'source', 'target', 'type']);
    assert.equal(payload.header.fn, 'auto_translation');
    assert.match(payload.header.client_key, /^browser-.+-[0-9a-f-]{36}-\d+$/);
    assert.equal(payload.type, 'plain');
    assert.equal(payload.model_category, 'normal');
    assert.deepEqual(payload.source, { lang: 'pt', text_list: texts });
    assert.deepEqual(payload.target, { lang: 'zh' });
    assert.doesNotMatch(JSON.stringify(payload.source), /ZXQ|QXZ/);
    return response(expected);
  });
  assert.deepEqual(await h.translateBatch(texts, 'pt'), expected);
  assert.equal(h.fetchImpl.mock.callCount(), 1);
});

test('client_key describes the actual browser without setting or spoofing an HTTP User-Agent', async () => {
  let payload;
  const sandbox = {
    URL, AbortController, setTimeout, clearTimeout,
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/144.0.7000.2 Safari/537.36 Edg/144.0.3000.9', platform: 'Win32' },
    crypto: { randomUUID: () => '11111111-2222-4333-8444-555555555555' }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../translation-reference-provider.js'), 'utf8'), sandbox);
  const p = sandbox.BuyerReferenceTranslation.create({ fetchImpl: async (input, init) => {
    payload = JSON.parse(init.body);
    assert.deepEqual(Object.keys(init.headers), ['Content-Type']);
    return response(['虚构商品中文']);
  } });
  assert.equal((await p.translateBatch(['Fabricated product'], 'en'))[0], '虚构商品中文');
  assert.match(payload.header.client_key, /^browser-edge-144\.0\.3000\.9-Windows 10-11111111-2222-4333-8444-555555555555-\d+$/);
});

test('Vietnamese goes directly to Chinese in a single native-array request', async () => {
  const h = setup(payload => {
    assert.equal(payload.source.lang, 'vi');
    assert.equal(payload.target.lang, 'zh');
    return response(['虚构无线呼叫器，16张卡']);
  });
  assert.deepEqual(await h.translateBatch(['Bộ gọi FICT903 16 thẻ'], 'vi'), ['虚构无线呼叫器，16张卡']);
  assert.equal(h.fetchImpl.mock.callCount(), 1);
});

for (const language of ['th', 'ms']) {
  test(language + ' follows the reference English pivot while preserving item order', async () => {
    const texts = ['Fabricated source FICT904', 'Fabricated source FICT905'];
    const english = ['Fabricated English FICT904', 'Fabricated English FICT905'];
    const chinese = ['虚构中文 FICT904', '虚构中文 FICT905'];
    const h = setup(payload => {
      if (payload.source.lang === language) {
        assert.equal(payload.target.lang, 'en');
        assert.deepEqual(payload.source.text_list, texts);
        return response(english);
      }
      assert.equal(payload.source.lang, 'en');
      assert.equal(payload.target.lang, 'zh');
      assert.deepEqual(payload.source.text_list, english);
      return response(chinese);
    });
    assert.deepEqual(await h.translateBatch(texts, language), chinese);
    assert.equal(h.fetchImpl.mock.callCount(), 2);
  });
}

test('an explicit English target is one request without a Chinese-only check', async () => {
  const h = setup(payload => {
    assert.equal(payload.source.lang, 'th');
    assert.equal(payload.target.lang, 'en');
    return response(['Fabricated English speaker FICT906']);
  });
  assert.deepEqual(await h.translateBatch(['Fabricated Thai FICT906'], 'th', { targetLanguage: 'en' }), ['Fabricated English speaker FICT906']);
  assert.equal(h.fetchImpl.mock.callCount(), 1);
});

test('empty positions are restored locally without relying on service boundary placeholders', async () => {
  const h = setup(payload => {
    assert.deepEqual(payload.source.text_list, ['Speaker FICT907', 'Microphone FICT908']);
    return response(['音箱 FICT907', '麦克风 FICT908']);
  });
  assert.deepEqual(await h.translateBatch(['', 'Speaker FICT907', ' ', 'Microphone FICT908', ''], 'en'), ['', '音箱 FICT907', '', '麦克风 FICT908', '']);
  assert.equal(h.fetchImpl.mock.callCount(), 1);
});

test('a bad neighboring result retries only that title as one unmarked item', async () => {
  const calls = [];
  const h = setup(payload => {
    calls.push(payload.source.text_list);
    return payload.source.text_list.length === 2 ? response(['音箱 FICT909', '']) : response(['麦克风 FICT910']);
  });
  assert.deepEqual(await h.translateBatch(['Speaker FICT909', 'Microphone FICT910'], 'en'), ['音箱 FICT909', '麦克风 FICT910']);
  assert.deepEqual(calls, [['Speaker FICT909', 'Microphone FICT910'], ['Microphone FICT910']]);
});

test('misaligned array counts split into smaller native arrays until each result has a verified position', async () => {
  const texts = ['Item FICT911', 'Item FICT912', 'Item FICT913', 'Item FICT914'];
  const h = setup(payload => payload.source.text_list.length > 1 ? response(['混合结果，不能确定归属']) : response(['虚构中文 ' + payload.source.text_list[0]]));
  assert.deepEqual(await h.translateBatch(texts, 'en'), texts.map(text => '虚构中文 ' + text));
  assert.equal(h.fetchImpl.mock.callCount(), 7);
  for (const call of h.fetchImpl.mock.calls) {
    const payload = JSON.parse(call.arguments[1].body);
    assert.ok(payload.source.text_list.every(text => texts.includes(text)));
    assert.doesNotMatch(JSON.stringify(payload.source.text_list), /ZXQ|QXZ/);
  }
});

test('placeholder-contaminated output is rejected and recovered using a raw single-item request', async () => {
  const h = setup(payload => payload.source.text_list.length > 1 ? response(['音箱 FICT915', 'ZXQ0001QXZ 麦克风 FICT916']) : response(['麦克风 FICT916']));
  assert.deepEqual(await h.translateBatch(['Speaker FICT915', 'Microphone FICT916'], 'en'), ['音箱 FICT915', '麦克风 FICT916']);
  assert.equal(h.fetchImpl.mock.callCount(), 2);
  assert.deepEqual(JSON.parse(h.fetchImpl.mock.calls[1].arguments[1].body).source.text_list, ['Microphone FICT916']);
});

test('an unrecoverable single item does not erase a successful neighbor', async () => {
  const h = setup(payload => payload.source.text_list.length > 1 ? response(['音箱 FICT917', '']) : response(['']));
  assert.deepEqual(await h.translateBatch(['Speaker FICT917', 'Microphone FICT918'], 'en'), ['音箱 FICT917', '']);
  assert.equal(h.fetchImpl.mock.callCount(), 2);
});

test('all unusable results produce a bounded permanent quality error', async () => {
  const h = setup(payload => response(payload.source.text_list.map(() => 'untranslated')));
  await assert.rejects(h.translateBatch(['Speaker FICT919', 'Microphone FICT920'], 'en'), error => {
    assert.equal(error.permanent, true);
    assert.equal(error.qualityFailed, true);
    assert.ok(error.message);
    return true;
  });
  assert.equal(h.fetchImpl.mock.callCount(), 3);
});

test('pure model identities can remain unchanged without a false missing-Chinese failure', async () => {
  const h = setup(payload => response(payload.source.text_list));
  assert.deepEqual(await h.translateBatch(['FICT-921', 'USB-C'], 'en'), ['FICT-921', 'USB-C']);
});

test('the reported model-brand substitution is repaired using the complete remaining description', async () => {
  const calls=[];
  const h=setup(payload=>{
    const texts=payload.source.text_list;
    calls.push(texts);
    if(texts[0]==='TOMIGO Mẫu Mới')return response(['小米新型号']);
    assert.deepEqual(texts,['Mẫu Mới']);
    return response(['新款']);
  });
  assert.deepEqual(await h.translateBatch(['TOMIGO Mẫu Mới'],'vi',{contexts:[{kind:'model',brand:'TOMIGO'}]}),['TOMIGO 新款']);
  assert.deepEqual(calls,[['TOMIGO Mẫu Mới'],['Mẫu Mới']]);
});

test('a different uppercase model brand is protected generically without a brand dictionary', async () => {
  const source='FABLEO Mẫu Mới 12V 2 cái FICT940';
  const description='Mẫu Mới 12V 2 cái FICT940';
  const h=setup(payload=>{
    const text=payload.source.text_list[0];
    return response([text===source?'虚构别牌新型号 12V 2个 FICT940':text===description?'新款 FICT940，12V，2个':'']);
  });
  assert.deepEqual(await h.translateBatch([source],'vi',{contexts:[{kind:'model'}]}),['FABLEO 新款 FICT940，12V，2个']);
  assert.equal(h.fetchImpl.mock.callCount(),2);
});

test('an explicit mixed-case prefix brand takes precedence and retains its exact source spelling', async () => {
  const source='Fableo: Mẫu Mới 12V';
  const h=setup(payload=>response([payload.source.text_list[0]===source?'错误品牌新款 12V':'新款 12V']));
  assert.deepEqual(await h.translateBatch([source],'vi',{contexts:[{kind:'item',brand:'FABLEO',price:99,remarks:'never send this context'}]}),['Fableo: 新款 12V']);
  for(const call of h.fetchImpl.mock.calls)assert.doesNotMatch(call.arguments[1].body,/never send this context|remarks|price/);
});

test('already-preserved brand output is returned intact without another translation request', async () => {
  const result='FABLEO 新型号，12V';
  const h=setup(()=>response([result]));
  assert.deepEqual(await h.translateBatch(['FABLEO Mẫu Mới 12V'],'vi',{contexts:[{kind:'model',brand:'FABLEO'}]}),[result]);
  assert.equal(h.fetchImpl.mock.callCount(),1);
});

test('brand matching accepts case and punctuation variants without losing word boundaries', async () => {
  const h=setup(()=>response(['ORAL B 音箱 12V']));
  assert.deepEqual(await h.translateBatch(['Oral-B speaker 12V'],'en',{contexts:[{kind:'item',brand:'Oral-B'}]}),['ORAL B 音箱 12V']);
  assert.equal(h.fetchImpl.mock.callCount(),1);
  const changed=setup(payload=>response([payload.source.text_list[0].startsWith('FABLEO ')?'FABLEOS 新款 12V':'新款 12V']));
  assert.deepEqual(await changed.translateBatch(['FABLEO Mẫu Mới 12V'],'vi',{contexts:[{kind:'model'}]}),['FABLEO 新款 12V']);
  assert.equal(changed.fetchImpl.mock.callCount(),2);
});

test('an English target with an intact Latin brand is not mistaken for a missing brand', async () => {
  const h=setup(()=>response(['FABLEO new model 12V']));
  assert.deepEqual(await h.translateBatch(['FABLEO Mẫu Mới 12V'],'vi',{targetLanguage:'en',contexts:[{kind:'model'}]}),['FABLEO new model 12V']);
  assert.equal(h.fetchImpl.mock.callCount(),1);
});

for(const prefix of ['KIT','NEW','BLACK','ORIGINAL','NO BRAND','Bộ']) {
  test('ordinary description prefix '+prefix+' is not inferred as a model brand',async()=>{
    const source=prefix+' Mẫu Mới FICT941';
    const h=setup(payload=>{
      assert.deepEqual(payload.source.text_list,[source]);
      return response(['虚构商品新款 FICT941']);
    });
    assert.deepEqual(await h.translateBatch([source],'vi',{contexts:[{kind:'model'}]}),['虚构商品新款 FICT941']);
    assert.equal(h.fetchImpl.mock.callCount(),1);
  });
}

test('context positions stay aligned when empty inputs are omitted from the request', async () => {
  const h=setup(payload=>{
    const text=payload.source.text_list[0];
    return response([text==='Fableo Mẫu Mới'?'错误品牌新款':'新款']);
  });
  assert.deepEqual(await h.translateBatch(['','Fableo Mẫu Mới'],'vi',{contexts:[{brand:'UNRELATED'},{kind:'item',brand:'Fableo'}]}),['','Fableo 新款']);
  assert.equal(h.fetchImpl.mock.callCount(),2);
});

test('a missing interior brand stays unresolved without inventing a compatibility relation or erasing neighbors',async()=>{
  const h=setup(()=>response(['适用某牌的无线音箱 12V','虚构麦克风 FICT942']));
  assert.deepEqual(await h.translateBatch(['Wireless speaker for Fableo 12V','Microphone FICT942'],'en',{
    contexts:[{kind:'item',brand:'Fableo'},{kind:'item'}]
  }),['','虚构麦克风 FICT942']);
  assert.equal(h.fetchImpl.mock.callCount(),1);
});

for(const repaired of ['新款 12V FICT943','新款 12V 2个 FICT944']) {
  test('brand repair rejects missing numeric/model parameters: '+repaired,async()=>{
    const source='FABLEO Mẫu Mới 12V 2 cái FICT943';
    const h=setup(payload=>response([payload.source.text_list[0]===source?'错误品牌新款 12V 2个 FICT943':repaired]));
    await assert.rejects(h.translateBatch([source],'vi',{contexts:[{kind:'model'}]}),error=>{
      assert.equal(error.brandIntegrityFailed,true);
      assert.equal(error.permanent,true);
      return true;
    });
    assert.equal(h.fetchImpl.mock.callCount(),2);
  });
}

test('brand repair follows the reference English pivot for the whole description',async()=>{
  const source='FABLEO ตัวอย่าง 12V';
  const h=setup(payload=>{
    const text=payload.source.text_list[0];
    if(payload.source.lang==='th')return response([text===source?'Wrongbrand fabricated 12V':'Fabricated 12V']);
    return response([text.startsWith('Wrongbrand')?'错误品牌虚构 12V':'虚构 12V']);
  });
  assert.deepEqual(await h.translateBatch([source],'th',{contexts:[{kind:'model'}]}),['FABLEO 虚构 12V']);
  assert.equal(h.fetchImpl.mock.callCount(),4);
});

test('a rate limit during brand repair is propagated without repeating the repair',async()=>{
  let calls=0;
  const h=setup(()=>++calls===1?response(['错误品牌新款 12V']):{status:429,headers:{get:()=> '8'}});
  await assert.rejects(h.translateBatch(['FABLEO Mẫu Mới 12V'],'vi',{contexts:[{kind:'model'}]}),error=>error.rateLimited===true&&error.retryAfter===8000);
  assert.equal(h.fetchImpl.mock.callCount(),2);
});

for (const seconds of ['7', '0', '1.5']) {
  test('HTTP 429 Retry-After ' + seconds + ' is propagated once without split or pivot retries', async () => {
    const h = setup(() => ({ status: 429, headers: { get: () => seconds } }));
    await assert.rejects(h.translateBatch(['Item FICT922', 'Item FICT923'], 'th'), error => {
      assert.equal(error.rateLimited, true);
      assert.equal(error.retryAfter, Number(seconds) * 1000);
      assert.equal(error.pause, true);
      return true;
    });
    assert.equal(h.fetchImpl.mock.callCount(), 1);
  });
}

test('HTTP-date Retry-After is respected', async () => {
  const retryAt = Math.ceil((Date.now() + 12000) / 1000) * 1000;
  const h = setup(() => ({ status: 429, headers: { get: () => new Date(retryAt).toUTCString() } }));
  const before = Date.now();
  await assert.rejects(h.translateBatch(['Item FICT924'], 'en'), error => {
    assert.equal(error.rateLimited, true);
    assert.ok(error.retryAfter <= retryAt - before);
    assert.ok(error.retryAfter >= retryAt - Date.now());
    return true;
  });
});

for (const phase of ['fetch', 'json']) {
  test('a timeout during ' + phase + ' aborts once and never splits the batch', { timeout: 2000 }, async () => {
    let signal;
    const h = setup((payload, init) => {
      signal = init.signal;
      return phase === 'fetch' ? new Promise(() => {}) : { status: 200, json: () => new Promise(() => {}) };
    }, { timeoutMs: 15 });
    await assert.rejects(h.translateBatch(['Item FICT925', 'Item FICT926'], 'en'), error => {
      assert.equal(error.timeout, true);
      assert.equal(error.pause, true);
      return true;
    });
    assert.equal(signal.aborted, true);
    assert.equal(h.fetchImpl.mock.callCount(), 1);
  });
}

test('a network failure does not trigger smaller requests or a second language leg', async () => {
  const h = setup(() => { throw new TypeError('fabricated connection failure'); });
  await assert.rejects(h.translateBatch(['Item FICT927', 'Item FICT928'], 'ms'), error => error.pause === true);
  assert.equal(h.fetchImpl.mock.callCount(), 1);
});

test('an HTTP service outage is propagated once', async () => {
  const h = setup(() => ({ status: 503 }));
  await assert.rejects(h.translateBatch(['Item FICT929', 'Item FICT930'], 'en'), /503/);
  assert.equal(h.fetchImpl.mock.callCount(), 1);
});

for (const message of ['Unsupported-Language', 'the required translation engine is unavailable']) {
  test('an HTTP-200 application failure ' + message + ' is detected without retries', async () => {
    const h = setup(() => ({ status: 200, json: async () => ({ header: { ret_code: 'error' }, message }) }));
    await assert.rejects(h.translateBatch(['Item FICT931', 'Item FICT932'], 'ms'), error => {
      assert.equal(error.unsupportedLanguage, true);
      assert.equal(error.permanent, true);
      return true;
    });
    assert.equal(h.fetchImpl.mock.callCount(), 1);
  });
}

test('a general HTTP-200 application error is not mistaken for translated content', async () => {
  const h = setup(() => ({ status: 200, json: async () => ({ header: { ret_code: 'error' }, message: 'Fabricated temporary failure', auto_translation: ['错误中文'] }) }));
  await assert.rejects(h.translateBatch(['Item FICT933'], 'en'), error => error.providerError === true && error.pause === true);
  assert.equal(h.fetchImpl.mock.callCount(), 1);
});

for (const malformed of [null, {}, [''], ['坏字符 \uFFFD'], ['ZXQ0000QXZ 中文']]) {
  test('a malformed or contaminated single response fails clearly: ' + JSON.stringify(malformed), async () => {
    const h = setup(() => response(malformed));
    await assert.rejects(h.translateBatch(['Item FICT934'], 'en'), error => error.qualityFailed === true && error.permanent === true);
    assert.equal(h.fetchImpl.mock.callCount(), 1);
  });
}

test('invalid JSON fails a single item without repeated requests', async () => {
  const h = setup(() => ({ status: 200, json: async () => { throw new SyntaxError('fabricated malformed JSON'); } }));
  await assert.rejects(h.translateBatch(['Item FICT935'], 'en'), error => error.qualityFailed === true && error.permanent === true);
  assert.equal(h.fetchImpl.mock.callCount(), 1);
});

test('an empty batch or empty source strings never call fetch', async () => {
  const h = setup(() => assert.fail('empty input must remain local'));
  assert.deepEqual(await h.translateBatch([], 'en'), []);
  assert.deepEqual(await h.translateBatch(['', ' ', null], 'en'), ['', '', '']);
  assert.equal(h.fetchImpl.mock.callCount(), 0);
});
