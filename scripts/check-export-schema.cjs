'use strict';

// Fabricated records only. The actual index.html mapper feeds the production
// Blob Worker bridge/source through Node worker_threads. No browser or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { Worker: NodeWorker } = require('node:worker_threads');
const { resolveObjectURL } = require('node:buffer');
const xlsx = require('../vendor/xlsx.full.min.js');
const csv = require('../workbench-import.js');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const lines = html.split(/\r?\n/);
const line = prefix => {
  const found = lines.find(text => text.startsWith(prefix));
  assert.ok(found, 'Missing actual definition: ' + prefix); return found;
};
const from = html.indexOf('function exportRows('), to = html.indexOf('function exportCsv(', from);
assert.ok(from >= 0 && to > from, 'Missing actual exportRows');
const statusDefinition = html.match(/const statusFilterKeys=\[[^;]+\];/);
assert.ok(statusDefinition, 'Missing actual status keys');
const mapping = [
  line('const H='), line('const S='), line('const FIELD='), statusDefinition[0],
  line('const rawLookupCache='), line('const keyMap='),
  ...['key', 'getRaw', 'normalizeModelId', 'round2', 'format2', 'calc', 'value', 'aliasFor', 'statusValue', 'statusLines'].map(name => line('function ' + name + '(')),
  html.slice(from, to), 'globalThis.schemaApi={H,FIELD,statusFilterKeys,exportRows};'
].join('\n');
const mapper = vm.createContext({ document: { getElementById: () => ({}) }, setTimeout });
vm.runInContext(mapping, mapper);
const { H, statusFilterKeys, exportRows } = mapper.schemaApi;

const records = [], expected = [];
for (let index = 0; index < 600; index++) {
  const raw = Object.fromEntries(H.filter((_, fieldIndex) => fieldIndex !== 5).map((header, fieldIndex) => [header, '虚构字段 ' + fieldIndex + ' / ' + index]));
  const modelId = index % 2 ? '0000000000000000' + String(index).padStart(5, '0') : String(900719925474099312345n + BigInt(index));
  const itemId = index % 3 === 0 ? String(800719925474099312345n + BigInt(index)) : index % 3 === 1 ? '000000000000000000' + String(index).padStart(5, '0') : '';
  raw.model_id = modelId; raw[index % 2 ? 'Item ID' : 'item_id'] = itemId;
  raw[H[13]] = '12.50'; raw[H[15]] = '10.20'; raw[H[17]] = '8.00';
  const note = '虚构买手备注 ' + index + '，逗号,"双引号"\n第二行 😀';
  raw[H[24]] = note; raw[H[25]] = '000000000000000' + index;
  const statuses = statusFilterKeys.map((key, offset) => index % 4 === 1 && offset % 2 ? '' : index % 4 === 2 ? '' : key === 'is_top_1k' ? (index % 2 ? 'false' : '0') : 'FAKE-' + index + '-' + offset);
  if (index % 4 === 3) raw[H[5]] = JSON.stringify(Object.fromEntries(statusFilterKeys.map((key, offset) => [key, statuses[offset]])));
  else statusFilterKeys.forEach((key, offset) => { raw[key] = statuses[offset]; });
  const preValue = index % 2 ? 'N' : 'Y', preDate = '2026-11-17', preNote = '虚构核价备注 ' + index + '\n续行';
  records.push({ uid: 'FAKE-' + index, raw, preValue, preDate, preNote, userEditedFields: [H[24], H[25]] });
  expected.push({ modelId, itemId, statuses, note, invitation: raw[H[25]], pre: [preValue, preDate, preNote].join(' | ') });
}
const table = exportRows(records);
const plain = value => JSON.parse(JSON.stringify(value));

function checkSchema(values) {
  assert.equal(values.length, 601); assert.equal(values[0].length, 34);
  assert.deepEqual(values[0].slice(0, 2), ['Model ID', 'item_id']);
  assert.equal(values[0].includes('model状态'), false);
  const actualStatusHeaders = values[0].slice(7, 14);
  assert.deepEqual(actualStatusHeaders, plain(statusFilterKeys));
  const noteColumn = values[0].indexOf('model备注'), inviteColumn = values[0].indexOf('邀请ID'), preColumn = values[0].indexOf('是否放前置核价');
  assert.ok(noteColumn > 13 && inviteColumn > 13 && preColumn > 13);
  for (let index = 0; index < 600; index++) {
    const row = values[index + 1], record = expected[index];
    assert.equal(row.length, 34, 'row width ' + index);
    assert.strictEqual(row[0], record.modelId); assert.strictEqual(row[1], record.itemId);
    assert.deepEqual(row.slice(7, 14), plain(record.statuses), 'seven independent statuses ' + index);
    assert.strictEqual(row[noteColumn], record.note); assert.strictEqual(row[inviteColumn], record.invitation); assert.strictEqual(row[preColumn], record.pre);
  }
}

const workers = [], activeUrls = new Set();
class BrowserWorkerShim {
  constructor(url) {
    this.pending = []; this.stopped = false; this.terminateCalls = 0; workers.push(this);
    resolveObjectURL(url).text().then(workerSource => {
      if (this.stopped) return;
      const prefix = 'const {parentPort}=require("node:worker_threads");globalThis.fetch=()=>{throw Error("Network forbidden")};globalThis.self={postMessage:message=>parentPort.postMessage(message)};';
      this.worker = new NodeWorker(prefix + workerSource + ';parentPort.on("message",data=>self.onmessage({data}));', { eval: true });
      this.worker.on('message', data => { if (!this.stopped) this.onmessage?.({ data }); });
      this.worker.on('error', error => { if (!this.stopped) this.onerror?.(error); });
      for (const message of this.pending) this.worker.postMessage(message);
      this.pending = [];
    }).catch(error => { if (!this.stopped) this.onerror?.(error); });
  }
  postMessage(message) { if (this.worker) this.worker.postMessage(message); else this.pending.push(message); }
  terminate() { this.stopped = true; this.terminateCalls++; this.termination = this.worker ? this.worker.terminate() : Promise.resolve(); }
}
const exporter = vm.createContext({
  Worker: BrowserWorkerShim, Blob, TextEncoder, Uint8Array, Uint32Array, DataView, setTimeout,
  fetch() { throw new Error('Network forbidden'); },
  URL: {
    createObjectURL(blob) { const url = URL.createObjectURL(blob); activeUrls.add(url); return url; },
    revokeObjectURL(url) { activeUrls.delete(url); URL.revokeObjectURL(url); }
  }
});
vm.runInContext(fs.readFileSync(require.resolve('../workbench-export.js'), 'utf8'), exporter);

test('actual exportRows expands to 34 ordered columns with exact IDs, statuses and buyer notes', () => {
  checkSchema(plain([table.headers, ...table.data]));
});

for (const format of ['xlsx', 'csv']) {
  test('600 actual mapped records retain all 34 columns through the ' + format + ' Worker', async () => {
    const result = await exporter.WorkbenchExport.exportInWorker(table, { format, chunkSize: 100, yieldMs: 0 });
    assert.equal(result.workerUsed, true);
    const bytes = Buffer.from(await result.blob.arrayBuffer()); let values;
    if (format === 'xlsx') {
      const book = xlsx.read(bytes, { type: 'buffer', raw: true, dense: true, WTF: true });
      const sheet = book.Sheets[book.SheetNames[0]];
      assert.equal(sheet['!ref'], 'A1:AH601');
      for (const row of sheet['!data'] || sheet) if (Array.isArray(row)) for (const cell of row) if (cell) assert.equal(cell.t, 's');
      values = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: true });
    } else {
      assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
      const parsed = await csv.parseFile(result.blob, { yieldMs: 0 }); values = [parsed.headers, ...parsed.matrix];
    }
    checkSchema(values);
    const expectedValues = plain([table.headers, ...table.data]).map(row => row.map(value => String(value ?? '')));
    assert.deepEqual(values, expectedValues, 'all 20,400 mapped data cells and 34 headers match');
    assert.equal(activeUrls.size, 0, 'Blob URLs revoked');
    const worker = workers.at(-1); assert.equal(worker.terminateCalls, 1); await worker.termination;
  });
}
