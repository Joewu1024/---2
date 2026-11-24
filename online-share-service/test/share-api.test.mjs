import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createShareApi, MAX_CONTENT_BYTES, MAX_REQUEST_BYTES} from '../lib/share-api.mjs';

const ORIGIN = 'https://joewu1024.github.io';
const BASE = 'https://example.netlify.app/api/shares';
const ID = 'a'.repeat(64);
const CONTENT = Buffer.from('fabricated ciphertext with IV and authentication tag').toString('base64url');
const OTHER_CONTENT = Buffer.from('different fabricated ciphertext with IV and authentication tag').toString('base64url');

function harness(options = {}) {
  const values = new Map(), operations = [], settings = [];
  const storage = {
    async set(key, value, condition) {
      operations.push(['set', key, condition]);
      if (options.fail) throw new Error('private provider details');
      if (condition.onlyIfNew && values.has(key)) return {modified:false};
      values.set(key, value);
      return {modified:true};
    },
    async get(key, condition) {
      operations.push(['get', key, condition]);
      if (options.fail) throw new Error('private provider details');
      return values.has(key) ? values.get(key) : null;
    }
  };
  const api = createShareApi({
    getStore(config) { settings.push(config); return storage; },
    ...options.api
  });
  return {api, values, operations, settings};
}

function publishRequest(data = {id:ID, content:CONTENT}, headers = {}) {
  return new Request(BASE, {
    method:'POST',
    headers:{Origin:ORIGIN, 'Content-Type':'application/json; charset=utf-8', ...headers},
    body:JSON.stringify(data)
  });
}

const readRequest = (id = ID, options = {}) => new Request(BASE + '/' + id, {headers:{Origin:ORIGIN}, ...options});

test('publish stores an immediately readable snapshot using strong site-wide storage', async () => {
  const {api, settings} = harness();
  const saved = await api.publish(publishRequest());
  assert.equal(saved.status, 201);
  assert.deepEqual(await saved.json(), {id:ID});
  assert.equal(saved.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(saved.headers.get('access-control-allow-credentials'), null);
  const loaded = await api.read(readRequest());
  assert.equal(loaded.status, 200);
  assert.equal(await loaded.text(), CONTENT);
  assert.match(loaded.headers.get('content-type'), /^text\/plain/);
  assert.deepEqual(settings, [
    {name:'buyer-product-shares-v1', consistency:'strong', region:'ap-southeast-1'},
    {name:'buyer-product-shares-v1', consistency:'strong', region:'ap-southeast-1'}
  ]);
  assert.equal((await api.read(readRequest(ID, {headers:{}}))).status, 200);
});

test('concurrent retries are idempotent and a conflicting write cannot replace a snapshot', async () => {
  const {api, values} = harness();
  const results = await Promise.all([api.publish(publishRequest()), api.publish(publishRequest()), api.publish(publishRequest())]);
  assert.deepEqual(results.map(response => response.status), [201, 201, 201]);
  assert.equal(values.size, 1);
  const conflict = await api.publish(publishRequest({id:ID, content:OTHER_CONTENT}));
  assert.equal(conflict.status, 409);
  assert.equal(values.get(ID), CONTENT);
});

test('origin checks stop unknown browser writes before opening storage', async () => {
  const {api, operations} = harness();
  for (const origin of ['', 'null', 'https://joewu1024.github.io.attacker.test', 'https://example.test']) {
    const result = await api.publish(publishRequest(undefined, {Origin:origin}));
    assert.equal(result.status, 403);
    assert.equal(result.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await api.read(readRequest(ID, {headers:{Origin:'https://example.test'}}))).status, 403);
  assert.equal(operations.length, 0);
});

test('preflight allows only the original workbench method and content type header', async () => {
  const {api, operations} = harness();
  const preflight = (method, headers = 'content-type') => new Request(BASE, {
    method:'OPTIONS',
    headers:{Origin:ORIGIN, 'Access-Control-Request-Method':method, 'Access-Control-Request-Headers':headers}
  });
  const allowed = await api.publish(preflight('POST'));
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal((await api.publish(preflight('DELETE'))).status, 403);
  assert.equal((await api.publish(preflight('POST', 'authorization'))).status, 403);
  assert.equal((await api.read(preflight('GET', ''))).status, 204);
  assert.equal(operations.length, 0);
});

test('read exposes only an exact valid identifier and handles missing records explicitly', async () => {
  const {api, operations} = harness();
  for (const suffix of ['', '/', '../secret', ID + '/extra', ID.toUpperCase(), 'a'.repeat(63), '%61'.repeat(64)]) {
    assert.equal((await api.read(new Request(BASE + '/' + suffix))).status, 404);
  }
  assert.equal(operations.length, 0);
  const missing = await api.read(readRequest());
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).message, /没有找到/);
});

test('malformed JSON and unsupported content cannot write records', async () => {
  const {api, operations} = harness();
  for (const body of [
    null, [], {}, {id:ID}, {id:ID, content:CONTENT, extra:true},
    {id:42, content:CONTENT}, {id:{toString:ID}, content:CONTENT},
    {id:ID.toUpperCase(), content:CONTENT},
    {id:ID, content:''}, {id:ID, content:'a'.repeat(37)},
    {id:ID, content:'a'.repeat(41)}, {id:ID, content:'!'.repeat(40)}
  ]) assert.equal((await api.publish(publishRequest(body))).status, 400);
  assert.equal((await api.publish(publishRequest({}, {'Content-Type':'text/plain'}))).status, 415);
  const broken = new Request(BASE, {method:'POST', headers:{Origin:ORIGIN, 'Content-Type':'application/json'}, body:'{ invalid'});
  assert.equal((await api.publish(broken)).status, 400);
  assert.equal(operations.length, 0);
});

test('request limits are enforced from declared bytes and actual streamed bytes', async () => {
  const {api, operations} = harness();
  assert.equal((await api.publish(publishRequest({}, {'Content-Length':String(MAX_REQUEST_BYTES + 1)}))).status, 413);
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_REQUEST_BYTES + 1)); },
    cancel() { cancelled = true; }
  });
  const streamed = new Request(BASE, {
    method:'POST', duplex:'half',
    headers:{Origin:ORIGIN, 'Content-Type':'application/json'}, body
  });
  assert.equal((await api.publish(streamed)).status, 413);
  assert.equal(cancelled, true);
  assert.equal((await api.publish(publishRequest({id:ID, content:'a'.repeat(MAX_CONTENT_BYTES + 2)}))).status, 413);
  assert.equal(operations.length, 0);
});

test('the largest supported client snapshot remains storable', async () => {
  const {api, values} = harness();
  const content = 'a'.repeat(2666704);
  assert.equal((await api.publish(publishRequest({id:ID, content}))).status, 201);
  assert.equal(values.get(ID), content);
});

test('storage failures return a retry response without provider details', async () => {
  const {api} = harness({fail:true});
  for (const response of [await api.publish(publishRequest()), await api.read(readRequest())]) {
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.doesNotMatch(text, /private|provider|secret/);
    assert.match(text, /稍后重试/);
  }
});

test('enumeration and destructive methods never execute, and HEAD returns no body', async () => {
  const {api, operations} = harness();
  assert.equal((await api.publish(new Request(BASE))).status, 405);
  assert.equal((await api.read(new Request(BASE + '/' + ID, {method:'DELETE'}))).status, 405);
  assert.equal(operations.length, 0);
  await api.publish(publishRequest());
  const head = await api.read(readRequest(ID, {method:'HEAD'}));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
