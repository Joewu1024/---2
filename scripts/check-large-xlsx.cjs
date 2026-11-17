'use strict';

// Fully offline, fabricated workbooks. The browser Worker bridge and its exact
// source run on Node worker_threads with a local-only importScripts shim.
// These are Node measurements, not browser DOM/FPS/IndexedDB measurements.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const vm = require('node:vm');
const { resolveObjectURL } = require('node:buffer');
const { Worker: NodeWorker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const xlsx = require('../vendor/xlsx.full.min.js');
const api = require('../workbench-xlsx.js');
const fixture = require('./generate-large-import-fixture.cjs');
const source = fs.readFileSync(require.resolve('../workbench-xlsx.js'), 'utf8');
const vendorPath = require.resolve('../vendor/xlsx.full.min.js');
const vendorUrl = 'https://xlsx-fixture.invalid/vendor/xlsx.full.min.js';
globalThis.fetch = () => { throw new Error('Network is forbidden in XLSX checks'); };

const workers = [];
class BrowserWorkerShim {
  constructor(url) {
    this.pending = []; this.stopped = false; this.terminateCalls = 0;
    workers.push(this);
    resolveObjectURL(url).text().then(workerSource => {
      if (this.stopped) return;
      const prefix = 'const {parentPort}=require("node:worker_threads");' +
        'globalThis.fetch=()=>{throw Error("Network forbidden")};' +
        'globalThis.self={postMessage:message=>parentPort.postMessage(message)};' +
        'globalThis.importScripts=url=>{if(url!==' + JSON.stringify(vendorUrl) + ')throw Error("Unexpected library URL");self.XLSX=require(' + JSON.stringify(vendorPath) + ')};';
      this.worker = new NodeWorker(prefix + workerSource + ';parentPort.on("message",data=>self.onmessage({data}));', { eval: true });
      this.worker.on('message', data => { if (!this.stopped && this.onmessage) this.onmessage({ data }); });
      this.worker.on('error', error => { if (!this.stopped && this.onerror) this.onerror(error); });
      for (const message of this.pending) this.worker.postMessage(message);
      this.pending = [];
    }).catch(error => { if (!this.stopped && this.onerror) this.onerror(error); });
  }
  postMessage(message) { if (this.worker) this.worker.postMessage(message); else this.pending.push(message); }
  terminate() {
    this.stopped = true; this.terminateCalls++;
    this.termination = this.worker ? this.worker.terminate() : Promise.resolve();
  }
}

const sandbox = {
  Worker: BrowserWorkerShim, URL, Blob, performance, setTimeout, clearTimeout,
  location: { href: 'https://xlsx-fixture.invalid/index.html', origin: 'https://xlsx-fixture.invalid' },
  document: { baseURI: 'https://xlsx-fixture.invalid/index.html' }
};
vm.runInNewContext(source, sandbox);
const browserApi = sandbox.WorkbenchXlsx;
// XLSX XML text normalizes literal CRLF to LF. Build fixtures with LF so exact
// comparisons refer to values stored in the workbook, not pre-write XML input.
const xlsxRow = index => fixture.expectedRow(index).map(value => value.replace(/\r\n/g, '\n'));

// Exercise the actual import mapper against the row-preserving worker matrix.
// Only business alias/meta helpers are isolated; AUTO IDs use shipped mapper code.
const indexHtml = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const mapperStart = indexHtml.indexOf('function selectImportHeader(');
const mapperEnd = indexHtml.indexOf('async function parseCsv(', mapperStart);
assert.ok(mapperStart >= 0 && mapperEnd > mapperStart, 'Find actual header selector/import mapper');
const mapperContext = {
  setTimeout, H: Array.from({ length: 24 }, (_, index) => 'column' + index),
  headerScore: row => row.filter(header => ['item_name', 'model_name', 'Target Price'].includes(header)).length,
  key: header => String(header).toLowerCase().replace(/[_\s]/g, ''),
  getRaw: (record, names) => { for (const name of names) if (record.raw[name] !== undefined) return record.raw[name]; return ''; },
  isMetaRow: () => false
};
vm.createContext(mapperContext);
vm.runInContext(indexHtml.slice(mapperStart, mapperEnd), mapperContext);

function workbookBytes(rows) {
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['说明', 'Fictional fixtures only'], ['No customer data', 'No images fetched']]), '说明');
  const sheet = xlsx.utils.aoa_to_sheet(rows);
  xlsx.utils.book_append_sheet(workbook, sheet, '商品 SKU');
  return { workbook, sheet, bytes: () => xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }) };
}

async function edgeCases() {
  assert.equal(xlsx.version, '0.20.3');
  assert.equal(typeof browserApi.parseInWorker, 'function');
  assert.equal(browserApi.resolveVendorUrl('vendor/xlsx.full.min.js'), vendorUrl);
  for (const url of ['https://other.invalid/xlsx.js', 'data:text/javascript,1', 'file:///xlsx.js', 'javascript:1']) assert.throws(() => browserApi.resolveVendorUrl(url), /本站/);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../vendor/sheetjs-ce-0.20.3-source.json'), 'utf8'));
  for (const entry of manifest.files) {
    const bytes = fs.readFileSync(path.join(__dirname, '../vendor', entry.path));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }
  const entry = workbookBytes([
    ['ID', 'Decimal', 'Date Serial', 'Text Long ID', 'Leading Zero', 'Boolean', 'Notes'],
    [7, 1234.56789012345, 45292, '900719925474099312345', '000012345', true, '中文 😀\r\n"quoted",value'],
    [], ['', '', ''], ['End', 0, '', '', '', false, '']
  ]);
  entry.sheet.B2.z = '#,##0.00';
  entry.sheet.C2.z = 'yyyy-mm-dd';
  const bytes = entry.bytes();
  const parsed = await api.parseWorkbookBytes(bytes, xlsx);
  assert.equal(parsed.sheets.length, 2);
  assert.equal(parsed.sheets[1].matrix.length, 5);
  assert.equal(parsed.rowsParsed, 5); // two cover rows plus three nonempty product rows
  assert.deepEqual(parsed.sheets[1].matrix[1], ['7', '1234.56789012345', '45292', '900719925474099312345', '000012345', 'true', '中文 😀\n"quoted",value']);
  assert.ok(parsed.sheets[1].matrix[2].every(value => value === ''));
  assert.ok(parsed.sheets[1].matrix[3].every(value => value === ''));
  assert.deepEqual(parsed.sheets[1].matrix[4], ['End', '0', '', '', '', 'false', '']);
  const threaded = await browserApi.parseInWorker(new Blob([bytes]), { vendorUrl });
  assert.deepEqual(threaded.sheets, parsed.sheets);
  assert.equal(workers.at(-1).terminateCalls, 1);
  await workers.at(-1).termination;

  const rowHeaders = ['item_name', 'model_name', 'Target Price'];
  for (const [inputRows, expectedHeaderRow, expectedSourceRows] of [
    [[rowHeaders, [], ['Product A', 'Model A', 1.25], [], ['Product B', 'Model B', 2.5]], 1, [3, 5]],
    [[[], [], rowHeaders, [], ['Product C', 'Model C', 3.5]], 3, [5]]
  ]) {
    const rowFixture = workbookBytes(inputRows);
    const sourceRows = await browserApi.parseInWorker(new Blob([rowFixture.bytes()]), { vendorUrl });
    await workers.at(-1).termination;
    const matrix = sourceRows.sheets[1].matrix;
    assert.equal(matrix.length, 5);
    for (let index = 0; index < expectedHeaderRow - 1; index++) assert.ok(matrix[index].every(value => value === ''));
    const choice = mapperContext.selectImportHeader(matrix, 3);
    assert.equal(choice.headerIndex + 1, expectedHeaderRow);
    const mapped = await mapperContext.mapImportedMatrix(matrix, choice, { prefix: 'xlsx' });
    assert.deepEqual(Array.from(mapped.rows, row => row.excelRow), expectedSourceRows);
    assert.deepEqual(Array.from(mapped.rows, row => row.raw._modelId), expectedSourceRows.map(row => 'AUTO-' + String(row).padStart(5, '0')));
    assert.equal(sourceRows.rowsParsed, 2 + 1 + expectedSourceRows.length); // cover + header + products
  }

  const already = new AbortController(); already.abort();
  await assert.rejects(browserApi.parseInWorker(new Blob([bytes]), { vendorUrl, signal: already.signal }), { name: 'AbortError' });
  await assert.rejects(api.parseInWorker(new Blob([bytes])), { name: 'WorkerUnavailableError' });
  await assert.rejects(browserApi.parseInWorker(new Blob([bytes]), { vendorUrl, onProgress() { throw new Error('Observer failure'); } }), /Observer failure/);
  await workers.at(-1).termination;
  await assert.rejects(browserApi.parseInWorker(new Blob([Buffer.from('504b0304696e76616c6964', 'hex')]), { vendorUrl }), /./);
  await workers.at(-1).termination;
}

async function benchmark(count) {
  const fixtureStart = performance.now();
  const rows = [['Synthetic source; ignore this preamble'], fixture.headers];
  for (let index = 0; index < count; index++) rows.push(xlsxRow(index));
  const entry = workbookBytes(rows);
  const bytes = entry.bytes();
  const buildMilliseconds = performance.now() - fixtureStart;
  const blob = new Blob([bytes]);
  let ticks = 0, lastTick = performance.now(), maxGap = 0, progressEvents = 0, lastPercent = -1;
  const phases = [];
  const heartbeat = setInterval(() => {
    const time = performance.now(); maxGap = Math.max(maxGap, time - lastTick); lastTick = time; ticks++;
  }, 10);
  const started = performance.now();
  let result;
  try {
    result = await browserApi.parseInWorker(blob, { vendorUrl, onProgress(progress) {
      progressEvents++;
      assert.ok(progress.percent >= lastPercent);
      lastPercent = progress.percent;
      if (!phases.includes(progress.phase)) phases.push(progress.phase);
    } });
  } finally { clearInterval(heartbeat); }
  const elapsed = performance.now() - started;
  await workers.at(-1).termination;
  assert.ok(ticks > 0, 'Parent event loop must continue during worker parsing');
  assert.deepEqual(phases, ['reading', 'decoding', 'extracting', 'done']);
  assert.equal(result.version, '0.20.3');
  assert.equal(result.bytesRead, bytes.length);
  assert.equal(result.sheets.length, 2);
  assert.equal(result.sheets[0].name, '说明');
  const matrix = result.sheets[1].matrix;
  assert.equal(matrix.length, count + 2);
  assert.deepEqual(matrix[1], fixture.headers);
  for (let index = 0; index < count; index++) assert.deepEqual(matrix[index + 2], xlsxRow(index), 'Exact source cells at SKU row ' + index);

  const controller = new AbortController();
  let requestedAt = 0;
  await assert.rejects(browserApi.parseInWorker(blob, { vendorUrl, signal: controller.signal, onProgress(progress) {
    if (progress.phase === 'decoding') { requestedAt = performance.now(); controller.abort(); }
  } }), { name: 'AbortError' });
  const cancelledAt = performance.now();
  assert.ok(requestedAt > 0);
  assert.equal(workers.at(-1).terminateCalls, 1);
  await workers.at(-1).termination;
  return {
    syntheticSkuRows: count, compressedXlsxBytes: bytes.length,
    fixtureBuildMillisecondsExcluded: +buildMilliseconds.toFixed(1),
    workerMillisecondsIncludingStartupReadAndFinalClone: +elapsed.toFixed(1),
    workerDecodeMilliseconds: +result.timings.decodeMilliseconds.toFixed(1),
    workerExtractMilliseconds: +result.timings.extractMilliseconds.toFixed(1),
    sheetCount: result.sheetCount, exactFieldComparisons: count * fixture.headers.length,
    parent10msHeartbeatTicks: ticks, maxObservedParentTimerGapMilliseconds: +maxGap.toFixed(1),
    progressEvents, phases,
    cancellation: { phase: 'decoding', requestToRejectionMilliseconds: +(cancelledAt - requestedAt).toFixed(1), workerTerminated: true }
  };
}

(async () => {
  await edgeCases();
  const measurements = [];
  for (const count of [10000, 20000]) measurements.push(await benchmark(count));
  const report = {
    generatedAt: new Date().toISOString(), runtime: process.version, platform: process.platform + '/' + process.arch,
    cpu: os.cpus()[0].model, synthetic: true, networkRequests: 0,
    library: { name: 'SheetJS CE', version: xlsx.version, sha256: crypto.createHash('sha256').update(fs.readFileSync(vendorPath)).digest('hex') },
    scope: 'Node worker_threads running the production browser Worker bridge/source; importScripts is shimmed to require the same local vendored SheetJS file. Fixture construction is excluded. No browser rendering/FPS/IndexedDB/business mapping or embedded-image extraction measurements.',
    edgeCases: 'Passed: UMD, same-origin vendor enforcement, vendor hashes, multiple sheets with cover and preamble, leading/interior blank source rows preserved, actual index.html mapper produces AUTO-00003/AUTO-00005 for products in Excel rows 3/5, header selection after leading blanks, nonempty rowsParsed count, Chinese/emoji/multiline quotes, raw formatted decimal precision, Excel date serial, textual long IDs and leading zeros, numeric zero and booleans, worker cleanup, error cleanup, unavailable-worker rejection, abort before start and terminate during decoding.',
    measurements
  };
  const destination = path.join(__dirname, '../artifacts/large-xlsx-node-report.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
