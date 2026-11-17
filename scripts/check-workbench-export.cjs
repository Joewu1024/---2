'use strict';

// Wholly fabricated tables, no browser/user storage and no network. The exact
// production Blob Worker source runs in Node worker_threads for these checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveObjectURL } = require('node:buffer');
const { Worker: NodeWorker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const api = require('../workbench-export.js');
const csv = require('../workbench-import.js');
const xlsx = require('../vendor/xlsx.full.min.js');
const source = fs.readFileSync(require.resolve('../workbench-export.js'), 'utf8');
globalThis.fetch = () => { throw new Error('Export checks must stay offline'); };

const workers = [], activeUrls = new Set();
class BrowserWorkerShim {
  constructor(url) {
    this.pending = []; this.stopped = false; this.terminateCalls = 0;
    workers.push(this);
    resolveObjectURL(url).text().then(workerSource => {
      if (this.stopped) return;
      const prefix = 'const {parentPort}=require("node:worker_threads");' +
        'globalThis.fetch=()=>{throw Error("Network forbidden")};' +
        'globalThis.self={postMessage:message=>parentPort.postMessage(message)};';
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
  Worker: BrowserWorkerShim, Blob, TextEncoder, Uint8Array, Uint32Array, DataView, setTimeout,
  URL: {
    createObjectURL(blob) { const url = URL.createObjectURL(blob); activeUrls.add(url); return url; },
    revokeObjectURL(url) { activeUrls.delete(url); URL.revokeObjectURL(url); }
  }
};
vm.runInNewContext(source, sandbox);
const browserApi = sandbox.WorkbenchExport;

function crc32(bytes) {
  // Independent bitwise reference, rather than the production lookup table.
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ -1) >>> 0;
}
function readZipStrict(bytes) {
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  const count = bytes.readUInt16LE(bytes.length - 12), length = bytes.readUInt32LE(bytes.length - 10), offset = bytes.readUInt32LE(bytes.length - 6);
  assert.equal(count, 5); assert.equal(offset + length, bytes.length - 22);
  const files = new Map(); let directory = offset, localEnd = 0;
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(directory), 0x02014b50);
    assert.equal(bytes.readUInt16LE(directory + 10), 0);
    const size = bytes.readUInt32LE(directory + 20), expectedCrc = bytes.readUInt32LE(directory + 16), nameLength = bytes.readUInt16LE(directory + 28), local = bytes.readUInt32LE(directory + 42);
    const name = bytes.toString('utf8', directory + 46, directory + 46 + nameLength);
    assert.equal(local, localEnd); assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt16LE(local + 8), 0);
    assert.equal(bytes.readUInt32LE(local + 14), expectedCrc);
    assert.equal(bytes.readUInt32LE(local + 18), size);
    assert.equal(bytes.readUInt32LE(local + 22), size);
    const localNameLength = bytes.readUInt16LE(local + 26), extraLength = bytes.readUInt16LE(local + 28);
    assert.equal(bytes.toString('utf8', local + 30, local + 30 + localNameLength), name);
    const start = local + 30 + localNameLength + extraLength, data = bytes.subarray(start, start + size);
    assert.equal(crc32(data), expectedCrc, name + ' CRC');
    assert.equal(files.has(name), false);
    files.set(name, new TextDecoder('utf-8', { fatal: true }).decode(data));
    localEnd = start + size;
    directory += 46 + nameLength + bytes.readUInt16LE(directory + 30) + bytes.readUInt16LE(directory + 32);
  }
  assert.equal(directory, offset + length); assert.equal(localEnd, offset);
  return files;
}
function cleanText(value) {
  // XML 1.0 accepts these code points; the limit counts UTF-16 units, as Excel does.
  const characters = Array.from(String(value ?? '')).filter(char => {
    const n = char.codePointAt(0); return n === 9 || n === 10 || n === 13 || n >= 32 && n <= 0xD7FF || n >= 0xE000 && n <= 0xFFFD || n >= 0x10000 && n <= 0x10FFFF;
  });
  let result = '';
  for (const char of characters) { if (result.length + char.length > 32767) break; result += char; }
  return result;
}
function readSheet(bytes) {
  const book = xlsx.read(bytes, { type: 'buffer', raw: true, dense: true, WTF: true });
  assert.deepEqual(book.SheetNames, ['寻品工作看板']);
  const sheet = book.Sheets[book.SheetNames[0]];
  for (const row of sheet['!data'] || sheet) {
    if (!Array.isArray(row)) continue;
    for (const cell of row) if (cell) assert.equal(cell.t, 's');
  }
  return xlsx.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: true });
}
async function finished() {
  assert.equal(activeUrls.size, 0, 'Every Blob URL must be revoked');
  const worker = workers.at(-1);
  assert.equal(worker.terminateCalls, 1);
  await worker.termination;
}

async function edgeCases() {
  assert.equal(typeof browserApi.exportInWorker, 'function');
  assert.equal(api.colName(0), 'A'); assert.equal(api.colName(25), 'Z'); assert.equal(api.colName(26), 'AA'); assert.equal(api.colName(16383), 'XFD');
  const table = {
    headers: ['Model ID', 'Leading zero', '零', '空', 'XML', 'Control', 'Long', 'Surrogate edge', 'Unicode'],
    data: [['900719925474099312345', '00000000123', 0, null, ' A&B <tag> "quoted" ', 'x\u0000\u0001\u000b\ufffe\uffff\ud800y\udc00z',
      'a'.repeat(32770), 'b'.repeat(32766) + '😀tail', '中文 😀 𠀀\nsecond line']]
  };
  const documentHtml = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  // Inline modules also define xmlEsc. Only the last application script owns
  // the legacy pure export functions used for byte-for-byte compatibility.
  const originalHtml = Array.from(documentHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)).at(-1)?.[1];
  assert.ok(originalHtml, 'Missing main application script');
  const start = originalHtml.indexOf('function xmlEsc('), end = originalHtml.indexOf('function mergeBuyerEdits(', start);
  assert.ok(start >= 0 && end > start);
  const pure = originalHtml.slice(start, end).replace(/^function exportRows\(list\).*$/m, 'function exportRows(value){return value}');
  const original = vm.runInNewContext(pure + ';({exportXlsx,exportCsv})', { Blob, TextEncoder, Uint8Array, Uint32Array, DataView });
  for (const format of ['xlsx', 'csv']) {
    const result = await browserApi.exportInWorker(table, { format });
    assert.equal(result.workerUsed, true); assert.equal(result.format, format); assert.equal(result.rowsExported, 1);
    const bytes = Buffer.from(await result.blob.arrayBuffer());
    assert.deepEqual(bytes, Buffer.from(await original[format === 'xlsx' ? 'exportXlsx' : 'exportCsv'](table).arrayBuffer()), 'Existing ' + format + ' output is unchanged');
    await finished();
    if (format === 'xlsx') {
      const files = readZipStrict(bytes), xml = files.get('xl/worksheets/sheet1.xml');
      assert.doesNotMatch(xml, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u);
      assert.deepEqual(readSheet(bytes), [table.headers, table.data[0].map(cleanText)]);
      assert.match(xml, /A&amp;B &lt;tag&gt; &quot;quoted&quot;/);
      assert.equal(cleanText(table.data[0][7]).length, 32766);
      if (process.argv[2]) {
        const destination = path.resolve(process.argv[2]);
        fs.writeFileSync(destination.replace(/\.xlsx$/i, '') + '-edges.xlsx', bytes);
      }
    }
  }
  const empty = await api.exportInWorker({ headers: ['Model ID'], data: [] }, { format: 'xlsx' });
  assert.equal(empty.workerUsed, false); assert.deepEqual(readSheet(Buffer.from(await empty.blob.arrayBuffer())), [['Model ID']]);
  let yielded = false; setTimeout(() => { yielded = true; }, 0);
  const fallback = await api.exportInWorker({ headers: ['Model ID'], data: [['0001']] }, { format: 'csv' });
  assert.equal(fallback.workerUsed, false); assert.equal(yielded, true);
  assert.equal(await fallback.blob.text(), 'Model ID\r\n0001'); // Blob.text strips UTF-8 BOM.
  const unavailable = sandbox.Worker;
  sandbox.Worker = class { constructor() { throw new Error('Fake CSP block'); } };
  assert.equal((await browserApi.exportInWorker({ headers: ['ID'], data: [] })).workerUsed, false);
  assert.equal(activeUrls.size, 0); sandbox.Worker = unavailable;
  for (const [badTable, options] of [[null, {}], [{ headers: [], data: [] }, {}], [{ headers: ['a'], data: [] }, { format: 'pdf' }], [{ headers: ['a'], data: [[]] }, {}]]) {
    await assert.rejects(browserApi.exportInWorker(badTable, options), /导出/);
  }
  if (workers.at(-1).terminateCalls) await finished();
  const controller = new AbortController(); controller.abort();
  const before = workers.length;
  await assert.rejects(browserApi.exportInWorker(table, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(workers.length, before);
  await assert.rejects(browserApi.exportInWorker(table, { onProgress() { throw new Error('Fake progress observer failure'); } }), /Fake progress observer failure/);
  await finished();
}

function testTable(count) {
  return {
    headers: ['Model ID', 'item name中文', 'Model name中文', 'Non Brand 倒算价', 'C8倒算价', '1688价格', 'model备注', '邀请ID', '是否放前置核价', 'Model name原文', '状态', '空白'],
    data: Array.from({ length: count }, (_, i) => [
      (900719925474099312345n + BigInt(i)).toString(), 'QATEST 虚构音箱 QA' + i + ' 5 W', 'QATEST 黑色 QB' + i + ' 2 件',
      i % 5 ? 10.25 : 0, i % 3 ? 9.99 : '', i % 2 ? 8.88 : 0,
      'QATEST 私有备注 ' + i + '，"引号", A&B <tag>\n第二行 😀 𠀀', '0000' + String(i).padStart(12, '0'),
      i % 2 ? 'Y | 2026-11-17 | QATEST 核价备注' : 'N |  | QATEST 待复核',
      'QATEST Black QB' + i + ' 2 pcs', i % 2 ? '待处理' : '已核价', ''
    ])
  };
}
async function largeChecks() {
  const table = testTable(20000), measures = [];
  for (const format of ['xlsx', 'csv']) {
    let ticks = 0, lastPercent = -1, events = 0;
    const timer = setInterval(() => ticks++, 10), start = performance.now();
    let result;
    try {
      result = await browserApi.exportInWorker(table, { format, onProgress(progress) {
        assert.ok(progress.percent >= lastPercent); lastPercent = progress.percent; events++;
        assert.equal(progress.totalRows, table.data.length);
      } });
    } finally { clearInterval(timer); }
    const milliseconds = performance.now() - start;
    assert.equal(result.workerUsed, true); assert.equal(lastPercent, 100); assert.ok(ticks > 0);
    await finished();
    const bytes = Buffer.from(await result.blob.arrayBuffer());
    let values;
    if (format === 'xlsx') {
      const files = readZipStrict(bytes);
      assert.match(files.get('xl/worksheets/sheet1.xml'), /autoFilter ref="A1:L20001"/);
      values = readSheet(bytes);
      if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), bytes);
    } else {
      assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
      const parsed = await csv.parseFile(result.blob, { yieldMs: 0 });
      values = [parsed.headers, ...parsed.matrix];
    }
    assert.deepEqual(values[0], table.headers);
    assert.equal(values.length, table.data.length + 1);
    for (let i = 0; i < table.data.length; i++) assert.deepEqual(values[i + 1], table.data[i].map(value => String(value ?? '')), format + ' exact source row ' + i);
    measures.push({ format, rows: 20000, exactDataCells: 240000, bytes: bytes.length, milliseconds: +milliseconds.toFixed(1), parent10msHeartbeatTicks: ticks, progressEvents: events, workerUsed: result.workerUsed });
  }
  for (const phase of ['serializing', 'packaging']) {
    const controller = new AbortController();
    await assert.rejects(browserApi.exportInWorker(table, { signal: controller.signal, onProgress(progress) {
      if (progress.phase === phase && (phase !== 'serializing' || progress.rowsExported >= 250)) controller.abort();
    } }), { name: 'AbortError' });
    await finished();
  }
  const localAbort = new AbortController();
  await assert.rejects(api.exportInWorker(table, { signal: localAbort.signal, onProgress(progress) { if (progress.rowsExported >= 250) localAbort.abort(); } }), { name: 'AbortError' });
  return measures;
}
(async () => {
  await edgeCases();
  console.log(JSON.stringify({ fabricatedOnly: true, networkRequests: 0, scope: 'Node worker_threads execute the exact production Blob Worker bridge and source; timings are not browser DOM/FPS measurements.', strictZipAndSheetJsReadback: true, measurements: await largeChecks() }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
