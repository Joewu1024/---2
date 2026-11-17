(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkbenchXlsx = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function createWorkbenchXlsx() {
  'use strict';

  const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  function abortError() {
    const error = new Error('Excel 导入已取消'); error.name = 'AbortError'; return error;
  }
  function checkAbort(signal) { if (signal && signal.aborted) throw abortError(); }
  function cellString(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
    return String(value);
  }

  // The browser entry point below always runs this function in a Worker. It is
  // exported separately for deterministic offline Node checks with the same CE
  // library. Numeric cells use their underlying .v value; text IDs stay text.
  async function parseWorkbookBytes(bytes, xlsx, options) {
    options = options || {};
    checkAbort(options.signal);
    if (!xlsx || typeof xlsx.read !== 'function' || !xlsx.utils) throw new Error('Excel 解析库未就绪');
    const total = bytes.byteLength;
    let rowsParsed = 0, lastProgress = -Infinity, lastYield = now();
    function progress(phase, percent, sheet, force) {
      if (typeof options.onProgress !== 'function') return;
      const time = now();
      if (!force && time - lastProgress < 80) return;
      lastProgress = time;
      options.onProgress({ phase, percent, loaded: total, total, rowsParsed, sheet: sheet || '' });
    }
    progress('decoding', 15, '', true);
    checkAbort(options.signal);
    const decodeStart = now();
    const workbook = xlsx.read(bytes, {
      type: 'array', dense: true, raw: true, cellDates: false,
      cellText: false, cellNF: false, cellFormula: false, bookVBA: false
    });
    const decodeMilliseconds = now() - decodeStart;
    checkAbort(options.signal);
    const extractStart = now(), sheets = [], count = workbook.SheetNames.length;
    progress('extracting', 40, '', true);
    for (let index = 0; index < count; index++) {
      checkAbort(options.signal);
      const name = workbook.SheetNames[index];
      const matrix = xlsx.utils.sheet_to_json(workbook.Sheets[name], {
        header: 1, raw: true, defval: '', blankrows: true, range: 0
      });
      // Convert in place, retaining one final matrix per sheet. No JSON copy or
      // display formatter is used, so decimal precision and textual IDs survive.
      // Keep leading/interior blank rows: matrix[i] must mean Excel row i + 1,
      // including when the sheet's used range starts below row 1. AUTO IDs and
      // old buyer-edit matching depend on those original source row numbers.
      for (let rowIndex = 0; rowIndex < matrix.length; rowIndex++) {
        const row = matrix[rowIndex];
        let nonempty = false;
        for (let column = 0; column < row.length; column++) {
          row[column] = cellString(row[column]);
          if (row[column] !== '') nonempty = true;
        }
        if (nonempty) rowsParsed++;
        if (rowIndex % 500 === 0) {
          checkAbort(options.signal);
          progress('extracting', Math.floor(40 + 55 * (index + (rowIndex + 1) / Math.max(1, matrix.length)) / Math.max(1, count)), name, false);
          if (now() - lastYield >= 8) { await pause(); checkAbort(options.signal); lastYield = now(); }
        }
      }
      sheets.push({ name, matrix });
      progress('extracting', Math.floor(40 + 55 * (index + 1) / Math.max(1, count)), name, true);
    }
    checkAbort(options.signal);
    const extractMilliseconds = now() - extractStart;
    progress('done', 100, '', true);
    return {
      sheets, bytesRead: total, rowsParsed, sheetCount: sheets.length,
      engine: 'SheetJS CE', version: xlsx.version,
      timings: { decodeMilliseconds, extractMilliseconds }
    };
  }

  function workerMain(factory) {
    const api = factory();
    self.onmessage = async event => {
      const message = event.data || {};
      if (message.type !== 'parse') return;
      try {
        const vendor = new URL(message.vendorUrl);
        if (!/^https?:$/.test(vendor.protocol) || vendor.origin !== message.origin) throw new Error('Excel 解析库必须来自本站');
        self.postMessage({ type: 'progress', progress: { phase: 'reading', percent: 0, loaded: 0, total: message.file.size, rowsParsed: 0 } });
        importScripts(vendor.href);
        if (!self.XLSX || self.XLSX.version !== '0.20.3') throw new Error('Excel 解析库版本不正确');
        const bytes = await message.file.arrayBuffer();
        self.postMessage({ type: 'progress', progress: { phase: 'reading', percent: 10, loaded: bytes.byteLength, total: message.file.size, rowsParsed: 0 } });
        const result = await api.parseWorkbookBytes(bytes, self.XLSX, {
          onProgress: progress => self.postMessage({ type: 'progress', progress })
        });
        // Only the final matrices cross the Worker boundary; intermediate
        // workbook structures and compressed input remain in the Worker.
        self.postMessage({ type: 'done', result });
      } catch (error) {
        self.postMessage({ type: 'error', error: { name: error.name, message: error.message } });
      }
    };
  }

  function createWorkerSource() {
    return '(' + workerMain.toString() + ')(' + createWorkbenchXlsx.toString() + ');';
  }

  function resolveVendorUrl(value) {
    const base = typeof document !== 'undefined' ? document.baseURI : typeof location !== 'undefined' ? location.href : '';
    const origin = typeof location !== 'undefined' ? location.origin : '';
    const url = new URL(value || 'vendor/xlsx.full.min.js', base);
    if (!/^https?:$/.test(url.protocol) || !origin || url.origin !== origin) throw new Error('Excel 解析库必须通过本站地址加载');
    return url.href;
  }

  // No implicit main-thread SheetJS fallback: callers can retain their existing
  // small-file/embedded-image importer when Blob Workers are not available.
  async function parseInWorker(file, options) {
    options = options || {};
    checkAbort(options.signal);
    if (!file || typeof file.arrayBuffer !== 'function' || !Number.isFinite(file.size)) throw new Error('请选择有效的 Excel 文件');
    if (typeof Worker === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
      const error = new Error('当前环境无法启动 Excel 后台解析'); error.name = 'WorkerUnavailableError'; throw error;
    }
    const vendorUrl = resolveVendorUrl(options.vendorUrl);
    const origin = new URL(vendorUrl).origin;
    const url = URL.createObjectURL(new Blob([createWorkerSource()], { type: 'text/javascript' }));
    let worker;
    try { worker = new Worker(url); }
    catch (error) { URL.revokeObjectURL(url); throw error; }
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', cancelled);
        worker.terminate(); URL.revokeObjectURL(url);
      };
      const cancelled = () => { cleanup(); reject(abortError()); };
      if (signal) signal.addEventListener('abort', cancelled, { once: true });
      worker.onmessage = event => {
        const message = event.data || {};
        if (message.type === 'progress') {
          if (typeof options.onProgress === 'function') {
            try { options.onProgress(message.progress); }
            catch (error) { cleanup(); reject(error); }
          }
        } else if (message.type === 'done') { cleanup(); resolve(message.result); }
        else if (message.type === 'error') {
          const error = new Error(message.error.message); error.name = message.error.name;
          cleanup(); reject(error);
        }
      };
      worker.onerror = event => {
        const error = new Error(event.message || 'Excel 后台解析启动失败');
        cleanup(); reject(error);
      };
      try { worker.postMessage({ type: 'parse', file, vendorUrl, origin }); }
      catch (error) { cleanup(); reject(error); }
    });
  }

  return { parseInWorker, parseWorkbookBytes, createWorkerSource, resolveVendorUrl };
});
