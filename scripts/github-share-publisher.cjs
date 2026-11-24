'use strict';

// Publish a sealed snapshot to the existing GitHub Pages site using local Git credentials.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const HOST = '127.0.0.1';
const PORT = 43716;
const LOCAL = 'http://' + HOST + ':' + PORT;
const SITE = 'https://joewu1024.github.io';
const PROJECT = SITE + '/---2/';
const REMOTE = 'https://github.com/Joewu1024/---2.git';
const MAX_CONTENT = 2400080;
const ID = /^[a-f0-9]{64}$/;
const CONTENT = /^[A-Za-z0-9_-]+$/;
const UUID = /^[a-fA-F0-9-]{36}$/;
const MAX_POST = MAX_CONTENT + 400;
const READY_WAIT_MS = 100000;

async function git(args, directory) {
  const result = await exec('git', [
    '-c', 'http.sslBackend=openssl',
    '-c', 'credential.helper=manager',
    '-c', 'credential.interactive=false',
    ...args
  ], {
    cwd: directory, windowsHide: true, timeout: 35000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
  });
  return result.stdout.trim();
}

async function checkout(directory) {
  try {
    const initial = await git(['remote', 'get-url', 'origin'], directory);
    if (initial.toLowerCase() !== REMOTE.toLowerCase()) throw new Error('Unexpected publishing repository');
  } catch (error) {
    if (await fs.stat(directory).then(() => true, () => false)) throw error;
    await git(['clone', '--depth=1', '--single-branch', '--branch', 'main', REMOTE, directory], path.dirname(directory));
  }
  const dirty = await git(['status', '--porcelain'], directory);
  if (dirty) throw new Error('The publication checkout contains unfinished changes');
  await git(['fetch', '--depth=1', 'origin', 'main'], directory);
  await git(['switch', '--detach', 'FETCH_HEAD'], directory);
}

async function publishFile(directory, id, content) {
  const relative = 'p/data/' + id + '.txt';
  // Preserve an existing snapshot and retry once if another site deployment won the race.
  for (let attempt = 0; attempt < 2; attempt++) {
    await checkout(directory);
    const destination = path.join(directory, ...relative.split('/'));
    const saved = await fs.readFile(destination, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (saved !== null) {
      if (saved === content) return;
      throw new Error('A different snapshot already uses this identifier');
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content, { flag: 'wx', encoding: 'utf8' });
    await git(['add', '--', relative], directory);
    const [name, email] = (await git(['show', '-s', '--format=%an%n%ae', 'FETCH_HEAD'], directory)).split(/\r?\n/);
    await git(['-c', 'user.name=' + name, '-c', 'user.email=' + email,
      'commit', '-m', 'Publish product share ' + id.slice(0, 12)], directory);
    try {
      await git(['push', 'origin', 'HEAD:main'], directory);
      return;
    } catch (error) {
      if (attempt || !/(non-fast-forward|fetch first)/i.test(error.stderr || '')) throw error;
    }
  }
}

async function waitForPage(id, content) {
  const end = Date.now() + READY_WAIT_MS;
  const url = new URL('p/data/' + id + '.txt', PROJECT);
  while (Date.now() < end) {
    url.searchParams.set('check', String(Date.now()));
    try {
      const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(7500) });
      if (response.ok && (await response.text()).trim() === content) return;
    } catch (error) {}
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error('发布还在同步，请稍后重试');
}

async function readPost(request) {
  let size = 0;
  const chunks = [];
  for await (const part of request) {
    size += part.length;
    if (size > MAX_POST) throw new Error('分享内容过大');
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validPair(value, pair) {
  return typeof value === 'string' && value.length === pair.length &&
    /^[A-Za-z0-9_-]{43}$/.test(value) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(pair));
}

function json(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(data));
}

function relayPage() {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>生成分享链接</title>' +
    '<meta name="referrer" content="no-referrer"><body style="font:16px system-ui;padding:24px;color:#203a2e">' +
    '<p id="status" role="status">正在生成分享链接…</p><script>' +
    '(' + relay.toString() + ')(' + JSON.stringify(SITE) + ');</script></body></html>';
}

function relay(origin) {
  const workbench = window.opener;
  if (!workbench) {
    document.getElementById('status').textContent = '请在寻品工作台中生成分享链接';
    return;
  }
  let sent = false;
  window.addEventListener('message', async event => {
    if (sent || event.source !== workbench || event.origin !== origin || event.data?.type !== 'buyer-share-publish') return;
    sent = true;
    const { pair, id, content } = event.data;
    try {
      const response = await fetch('/publish', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pair, id, content })
      });
      const result = await response.json();
      if (response.ok && result.id === id) workbench.postMessage({ type: 'buyer-share-published', id }, origin);
      else throw new Error(result.message || '分享发布失败，请重试');
    } catch (error) {
      workbench.postMessage({ type: 'buyer-share-publish-error', message: error.message }, origin);
    }
  });
  workbench.postMessage({ type: 'buyer-share-publisher-ready' }, origin);
}

async function start(statePath) {
  await fs.mkdir(statePath, { recursive: true });
  const pairFile = path.join(statePath, 'pair.txt');
  let pair = await fs.readFile(pairFile, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (!/^[A-Za-z0-9_-]{43}$/.test(pair)) {
    pair = randomBytes(32).toString('base64url');
    await fs.writeFile(pairFile, pair, { mode: 0o600, flag: 'wx' });
  }
  const directory = path.join(statePath, 'pages');
  let active = false;
  const server = http.createServer(async (request, response) => {
    if (request.headers.host !== HOST + ':' + PORT) return json(response, 403, {});
    const route = new URL(request.url, LOCAL);
    if (route.origin !== LOCAL) return json(response, 403, {});
    if (request.method === 'GET' && route.pathname === '/health') return json(response, 200, { ready: true });
    if (request.method === 'GET' && route.pathname === '/connect') {
      const destination = new URL(PROJECT);
      const workspace = route.searchParams.get('workspace');
      if (workspace && UUID.test(workspace)) destination.searchParams.set('workspace', workspace);
      destination.hash = 'publisher=' + pair;
      response.writeHead(302, { Location: destination.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return response.end();
    }
    if (request.method === 'GET' && route.pathname === '/publish') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"
      });
      return response.end(relayPage());
    }
    if (request.method !== 'POST' || route.pathname !== '/publish') return json(response, 404, {});
    if (request.headers.origin !== LOCAL || request.headers['content-type'] !== 'application/json') return json(response, 403, { message: '此页面不能发布分享' });
    let body;
    try { body = await readPost(request); } catch (error) { return json(response, 400, { message: '分享内容过大或格式无效' }); }
    if (!body || !validPair(body.pair, pair) || typeof body.id !== 'string' || !ID.test(body.id) ||
        typeof body.content !== 'string' || body.content.length > MAX_CONTENT || !CONTENT.test(body.content)) {
      return json(response, 403, { message: '分享发布未授权' });
    }
    if (active) return json(response, 409, { message: '上一份链接正在发布，请稍后重试' });
    active = true;
    try {
      await publishFile(directory, body.id, body.content);
      await waitForPage(body.id, body.content);
      return json(response, 201, { id: body.id });
    } catch (error) {
      console.error('Product share failed:', error.message?.startsWith('发布') ? error.message : error.code || 'GitHub publication error');
      return json(response, 503, { message: error.message?.startsWith('发布') ? error.message : '分享发布失败，请稍后重试' });
    } finally { active = false; }
  });
  server.requestTimeout = 30000;
  server.listen(PORT, HOST, () => console.log('Local product share publisher is ready'));
  return server;
}

if (require.main === module) {
  const directory = process.argv[2];
  if (!directory || !path.isAbsolute(directory)) throw new Error('Specify an absolute publisher state directory');
  start(directory).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { start, publishFile };
