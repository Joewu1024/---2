'use strict';

// Node timing is an engine check, not a browser rendering/FPS measurement.
// Fixtures are fabricated locally. This script does not use the network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const api = require('../workbench-import.js');
const fixture = require('./generate-large-import-fixture.cjs');

globalThis.fetch = () => { throw new Error('Network access is forbidden in import checks'); };

async function parseText(text, options) {
  return api.parseFile(new Blob([text]), Object.assign({ chunkSize: 256, sampleSize: 257 }, options));
}

async function edgeCases() {
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../workbench-import.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.WorkbenchImport.parseFile, 'function');

  const source = '\ufeffModel ID,标题,备注,金额,empty\r\n900719925474099312345,"中文 😀 𠀀","a,""b""\r\n下一行", "literal",\r\n000012345,"end","tail",1,\r\n';
  // Every single-character split, including CR/LF and doubled quote boundaries.
  for (let chunk = 1; chunk <= 19; chunk++) {
    const rows = [];
    const parser = api.createCsvParser(',', row => rows.push(row));
    const plain = source.slice(1);
    for (let offset = 0; offset < plain.length; offset += chunk) parser.write(plain.slice(offset, offset + chunk));
    parser.finish();
    assert.equal(rows.length, 3);
    assert.equal(rows[1][0], '900719925474099312345');
    assert.equal(rows[1][2], 'a,"b"\r\n下一行');
    assert.equal(rows[2][0], '000012345');
    assert.equal(rows[2][4], '');
  }
  const utf8 = new TextEncoder().encode('Model ID,标题\r\n1,汉😀𠀀');
  for (let tail = 0; tail <= 8; tail++) assert.equal(api.detectEncoding(utf8.subarray(0, utf8.length - tail)), 'utf-8');
  // A sniff sample may end inside a UTF-8 code point. The actual full decode
  // still receives those bytes, with no dropped/replacement character.
  for (let sampleSize = 17; sampleSize < 32; sampleSize++) {
    const parsed = await api.parseFile(new Blob([utf8]), { sampleSize });
    assert.equal(parsed.encoding, 'utf-8');
    assert.equal(parsed.matrix[0][1], '汉😀𠀀');
  }
  for (const delimiter of [',', ';', '\t', '|']) {
    const parsed = await parseText('ID' + delimiter + 'title\r\n00001' + delimiter + '"a,b; c|d\te"\r\n');
    assert.equal(parsed.delimiter, delimiter);
    assert.deepEqual(parsed.matrix, [['00001', 'a,b; c|d\te']]);
  }

  const utf16Text = '\ufeffModel ID,标题\r\n900719925474099312345,中文😀\r\n';
  const little = Buffer.from(utf16Text, 'utf16le');
  const big = Buffer.from(little).swap16();
  for (const [bytes, encoding] of [[little, 'utf-16le'], [big, 'utf-16be'], [little.subarray(2), 'utf-16le'], [big.subarray(2), 'utf-16be']]) {
    const parsed = await api.parseFile(new Blob([bytes]), { chunkSize: 257, sampleSize: 27 });
    assert.equal(parsed.encoding, encoding);
    assert.equal(parsed.matrix[0][1], '中文😀');
  }
  // GB18030 fixture includes both Chinese two-byte and supplementary four-byte
  // characters. Hex was generated from the displayed, fabricated text.
  const gb = Buffer.from('4d6f64656c2049442cb1eacce22cb1b8d7a20d0a3930303731393932353437343039393331323334352cd6d0cec4c9ccc6b72c953282369439fc360d0a', 'hex');
  const gbParsed = await api.parseFile(new Blob([gb]), { chunkSize: 257, sampleSize: 29 });
  assert.equal(gbParsed.encoding, 'gb18030');
  assert.deepEqual(gbParsed.headers, ['Model ID', '标题', '备注']);
  assert.deepEqual(gbParsed.matrix, [['900719925474099312345', '中文商品', '𠀀😀']]);
  const lateGB = new Blob(['ID,title\r\n00001,English-only-prefix\r\n', Buffer.from('30303030322cd6d0cec4c9ccc6b70d0a', 'hex')]);
  const lateParsed = await api.parseFile(lateGB, { sampleSize: 16 });
  assert.equal(lateParsed.encoding, 'gb18030');
  assert.deepEqual(lateParsed.matrix[1], ['00002', '中文商品']);
  await assert.rejects(api.parseFile(lateGB, { sampleSize: 16, encoding: 'utf-8' }), TypeError);
  const objects = await parseText('ID,Price\n000001,"1,299.90"', { objectRows: true });
  assert.equal(objects.matrix, undefined);
  assert.equal(objects.objectRows[0].ID, '000001');
  assert.equal(objects.objectRows[0].Price, '1,299.90');
  const fallback = await api.parseInWorker(new Blob(['ID,title\n0001,中文']), { worker: false });
  assert.deepEqual(fallback.matrix, [['0001', '中文']]);
  assert.deepEqual((await parseText('')).headers, []);
  await assert.rejects(parseText('a,b\n1,"broken'), /引号未闭合/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(parseText('a\n1', { signal: aborted.signal }), { name: 'AbortError' });
}

async function workerCheck(blob, count) {
  const source = 'const {parentPort}=require("node:worker_threads");' +
    'globalThis.self={postMessage:message=>parentPort.postMessage(message)};' +
    api.createWorkerSource() +
    ';parentPort.on("message",data=>self.onmessage({data}));';
  const started = performance.now();
  const worker = new Worker(source, { eval: true });
  let progress = 0;
  try {
    const result = await new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', message => {
        if (message.type === 'progress') progress++;
        if (message.type === 'error') reject(new Error(message.error.message));
        if (message.type === 'done') resolve(message.result);
      });
      worker.postMessage({ type: 'parse', file: blob, options: { chunkSize: 64 * 1024 } });
    });
    assert.equal(result.matrix.length, count);
    assert.deepEqual(result.matrix[count - 1], fixture.expectedRow(count - 1));
    assert.ok(progress >= 2);
    return { millisecondsIncludingStartupAndFinalClone: +(performance.now() - started).toFixed(1), progressEvents: progress, correctRows: result.matrix.length };
  } finally { await worker.terminate(); }
}

async function benchmark(count) {
  const blob = new Blob(Array.from(fixture.fixtureChunks(count)), { type: 'text/csv' });
  let ticks = 0, maxTimerGap = 0, lastTick = performance.now(), progress = 0, lastPercent = -1;
  const heartbeat = setInterval(() => {
    const time = performance.now(); maxTimerGap = Math.max(maxTimerGap, time - lastTick); lastTick = time; ticks++;
  }, 10);
  const started = performance.now();
  let result;
  try {
    result = await api.parseFile(blob, { onProgress(value) {
      assert.ok(value.percent >= lastPercent); lastPercent = value.percent; progress++;
    } });
  } finally { clearInterval(heartbeat); }
  const elapsed = performance.now() - started;
  assert.equal(result.rowsParsed, count);
  assert.equal(result.bytesRead, blob.size);
  assert.deepEqual(result.headers, fixture.headers);
  assert.equal(result.matrix.length, count);
  for (let i = 0; i < count; i++) assert.deepEqual(result.matrix[i], fixture.expectedRow(i), 'Exact source fields at row ' + i);
  assert.ok(ticks > 0, 'Timer must run while main-thread scanner yields');
  assert.equal(lastPercent, 100);

  const controller = new AbortController();
  let lastRows = 0, abortRequestedAt = 0;
  const cancelStart = performance.now();
  await assert.rejects(api.parseFile(blob, { signal: controller.signal, progressIntervalMs: 0, onProgress(value) {
    lastRows = value.rowsParsed;
    if (value.rowsParsed >= 100 && value.phase !== 'done') { abortRequestedAt = performance.now(); controller.abort(); }
  } }), { name: 'AbortError' });
  assert.ok(lastRows < count, 'Cancellation must stop before the full fixture');

  return {
    rows: count, bytes: blob.size, megabytes: +(blob.size / 1024 / 1024).toFixed(2),
    parseMilliseconds: +elapsed.toFixed(1), exactFieldComparisons: count * fixture.headers.length,
    heartbeatTicks: ticks, maxObserved10msTimerGapMilliseconds: +maxTimerGap.toFixed(1), progressEvents: progress,
    cancellation: { millisecondsUntilRejection: +(performance.now() - cancelStart).toFixed(1), requestToRejectionMilliseconds: +(performance.now() - abortRequestedAt).toFixed(1), rowsParsedAtAbort: lastRows, name: 'AbortError' },
    workerThread: await workerCheck(blob, count)
  };
}

(async () => {
  await edgeCases();
  const measurements = [];
  for (const count of [10000, 20000]) measurements.push(await benchmark(count));
  const report = {
    generatedAt: new Date().toISOString(), runtime: process.version, platform: process.platform + '/' + process.arch,
    cpu: os.cpus()[0].model, synthetic: true, networkRequests: 0,
    scope: 'Node streaming parser and Node worker_threads running the exact serialized browser-worker parser. Includes no DOM, browser FPS, IndexedDB, business field mapping, grouping or translation measurements.',
    edgeCases: 'Passed: UMD, UTF-8 sniff partial-tail boundaries, BOM, UTF-16 LE/BE with and without BOM, GB18030 Chinese/supplementary characters and ASCII-only sniff prefix, comma/tab/semicolon/pipe, string IDs/prices, empty cells, quoted multiline records, chunk-split escaped quotes/CRLF, malformed quote rejection, cancellation.',
    measurements
  };
  const destination = path.join(__dirname, '../artifacts/large-import-node-report.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
