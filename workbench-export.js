(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkbenchExport = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function createWorkbenchExport() {
  'use strict';

  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  function abortError() {
    const error = new Error('导出已取消'); error.name = 'AbortError'; return error;
  }
  function checkAbort(signal) { if (signal && signal.aborted) throw abortError(); }
  function validate(table, format) {
    if (format !== 'xlsx' && format !== 'csv') throw new Error('请选择 Excel 或 CSV 导出格式');
    if (!table || !Array.isArray(table.headers) || !table.headers.length || !Array.isArray(table.data)) {
      throw new Error('导出数据必须包含 headers 和 data');
    }
    if (format === 'xlsx' && (table.headers.length > 16384 || table.data.length > 1048575)) {
      throw new Error('导出数据超出 Excel 行列限制，请筛选后重试');
    }
  }

  // Keep the same XML 1.0 cleaning and Excel UTF-16 cell limit as index.html.
  function xmlEsc(s) {
    let input = String(s ?? ''), clean = '';
    for (let i = 0; i < input.length; i++) {
      const c = input.charCodeAt(i);
      if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 0xD7FF) || (c >= 0xE000 && c <= 0xFFFD)) { clean += input[i]; continue; }
      if (c >= 0xD800 && c <= 0xDBFF) { const n = input.charCodeAt(i + 1); if (n >= 0xDC00 && n <= 0xDFFF) clean += input[i] + input[++i]; continue; }
      if (c >= 0xDC00 && c <= 0xDFFF) continue;
    }
    if (clean.length > 32767) clean = clean.slice(0, 32767).replace(/[\uD800-\uDBFF]$/, '');
    return clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function colName(n) {
    let s = ''; for (n++; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s;
  }
  function zip(files) {
    const encoder = new TextEncoder(), parts = [], central = []; let offset = 0;
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); table[n] = c >>> 0; }
    const crc32 = bytes => { let c = 0xffffffff; for (const b of bytes) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const put16 = (view, at, value) => view.setUint16(at, value, true), put32 = (view, at, value) => view.setUint32(at, value >>> 0, true);
    for (const file of files) {
      const name = encoder.encode(file.n), data = encoder.encode(String(file.d)), crc = crc32(data), local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
      put32(lv, 0, 0x04034b50); put16(lv, 4, 20); put16(lv, 6, 0x0800); put16(lv, 8, 0); put16(lv, 10, 0); put16(lv, 12, 33); put32(lv, 14, crc); put32(lv, 18, data.length); put32(lv, 22, data.length); put16(lv, 26, name.length); put16(lv, 28, 0); local.set(name, 30); parts.push(local, data);
      const entry = new Uint8Array(46 + name.length), cv = new DataView(entry.buffer);
      put32(cv, 0, 0x02014b50); put16(cv, 4, 20); put16(cv, 6, 20); put16(cv, 8, 0x0800); put16(cv, 10, 0); put16(cv, 12, 0); put16(cv, 14, 33); put32(cv, 16, crc); put32(cv, 20, data.length); put32(cv, 24, data.length); put16(cv, 28, name.length); put16(cv, 30, 0); put16(cv, 32, 0); put16(cv, 34, 0); put16(cv, 36, 0); put32(cv, 38, 0); put32(cv, 42, offset); entry.set(name, 46); central.push(entry); offset += local.length + data.length;
    }
    const directoryLength = central.reduce((sum, part) => sum + part.length, 0), end = new Uint8Array(22), ev = new DataView(end.buffer);
    put32(ev, 0, 0x06054b50); put16(ev, 4, 0); put16(ev, 6, 0); put16(ev, 8, files.length); put16(ev, 10, files.length); put32(ev, 12, directoryLength); put32(ev, 16, offset); put16(ev, 20, 0);
    return new Blob([...parts, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  function csvRow(row) {
    return row.map(value => { const text = String(value ?? ''); return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text; }).join(',');
  }
  function xlsxRow(row, number) {
    return '<row r="' + number + '">' + row.map((value, index) => '<c r="' + colName(index) + number + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(value) + '</t></is></c>').join('') + '</row>';
  }

  async function serializeTable(table, options) {
    options = options || {};
    const format = options.format || 'xlsx';
    checkAbort(options.signal); validate(table, format);
    const totalRows = table.data.length;
    const progress = (phase, percent, count) => {
      if (typeof options.onProgress === 'function') options.onProgress({ phase, percent, rowsExported: count, totalRows });
      checkAbort(options.signal);
    };
    progress('serializing', 0, 0);
    // The fallback shares these chunks so it yields while building cells. The
    // final XLSX join/CRC still runs locally when workerUsed is false.
    await pause(); checkAbort(options.signal);
    const parts = format === 'csv' ? ['\uFEFF', csvRow(table.headers)] : [xlsxRow(table.headers, 1)];
    for (let index = 0; index < totalRows; index++) {
      const row = table.data[index];
      if (!Array.isArray(row) || row.length !== table.headers.length) throw new Error('导出数据行与表头列数不一致');
      if (format === 'csv') parts.push('\r\n', csvRow(row));
      else parts.push(xlsxRow(row, index + 2));
      if ((index + 1) % 250 === 0) {
        progress('serializing', Math.floor(85 * (index + 1) / Math.max(1, totalRows)), index + 1);
        await pause(); checkAbort(options.signal);
      }
    }
    progress('packaging', 90, totalRows);
    await pause(); checkAbort(options.signal);
    let blob;
    if (format === 'csv') blob = new Blob(parts, { type: 'text/csv;charset=utf-8' });
    else {
      const end = colName(table.headers.length - 1) + (totalRows + 1);
      const sheet = '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><sheetData>' + parts.join('') + '</sheetData><autoFilter ref="A1:' + end + '"/></worksheet>';
      const ct = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
      const wb = '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="寻品工作看板" sheetId="1" r:id="rId1"/></sheets></workbook>';
      const re = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
      const br = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
      blob = zip([{ n: '[Content_Types].xml', d: ct }, { n: '_rels/.rels', d: re }, { n: 'xl/workbook.xml', d: wb }, { n: 'xl/_rels/workbook.xml.rels', d: br }, { n: 'xl/worksheets/sheet1.xml', d: sheet }]);
    }
    progress('done', 100, totalRows);
    return blob;
  }

  function workerMain(factory) {
    const api = factory();
    self.onmessage = async event => {
      const message = event.data || {};
      if (message.type !== 'export') return;
      try {
        const blob = await api.serializeTable(message.table, { format: message.format, onProgress: progress => self.postMessage({ type: 'progress', progress }) });
        self.postMessage({ type: 'done', blob });
      } catch (error) {
        self.postMessage({ type: 'error', error: { name: error.name, message: error.message } });
      }
    };
  }
  function createWorkerSource() { return '(' + workerMain.toString() + ')(' + createWorkbenchExport.toString() + ');'; }

  async function exportInWorker(table, options) {
    options = options || {};
    const format = options.format || 'xlsx';
    checkAbort(options.signal); validate(table, format);
    const result = (blob, workerUsed) => ({ blob, workerUsed, format, rowsExported: table.data.length });
    const fallback = async () => result(await serializeTable(table, options), false);
    if (typeof Worker === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return fallback();
    let url, worker;
    try {
      url = URL.createObjectURL(new Blob([createWorkerSource()], { type: 'text/javascript' }));
      worker = new Worker(url);
    } catch (error) {
      if (url) URL.revokeObjectURL(url);
      return fallback();
    }
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      let settled = false;
      const finish = (error, blob) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', cancelled);
        worker.terminate(); URL.revokeObjectURL(url);
        if (error) reject(error); else resolve(result(blob, true));
      };
      const cancelled = () => finish(abortError());
      if (signal) signal.addEventListener('abort', cancelled, { once: true });
      worker.onmessage = event => {
        const message = event.data || {};
        if (message.type === 'progress') {
          if (typeof options.onProgress === 'function') {
            try { options.onProgress(message.progress); } catch (error) { finish(error); }
          }
        } else if (message.type === 'done') finish(null, message.blob);
        else if (message.type === 'error') {
          const error = new Error(message.error.message); error.name = message.error.name; finish(error);
        }
      };
      worker.onerror = event => finish(new Error(event.message || '后台导出失败，请重试'));
      try { checkAbort(signal); worker.postMessage({ type: 'export', table, format }); }
      catch (error) { finish(error); }
    });
  }
  return { exportInWorker, serializeTable, createWorkerSource, xmlEsc, colName };
});
