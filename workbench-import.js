(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkbenchImport = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function createWorkbenchImport() {
  'use strict';

  const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  function abortError() {
    const error = new Error('CSV 导入已取消');
    error.name = 'AbortError';
    return error;
  }
  function checkAbort(signal) {
    if (signal && signal.aborted) throw abortError();
  }

  // stream:true deliberately leaves an incomplete final code point buffered. A
  // sample ending inside a valid UTF-8 character must not be mistaken for GBK.
  function detectEncoding(bytes, preferred) {
    if (preferred && preferred !== 'auto') return preferred;
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
    let evenZero = 0, oddZero = 0;
    const length = Math.min(bytes.length - bytes.length % 2, 4096);
    for (let i = 0; i < length; i += 2) {
      if (!bytes[i]) evenZero++;
      if (!bytes[i + 1]) oddZero++;
    }
    if (length >= 8 && oddZero / (length / 2) > 0.25 && evenZero / (length / 2) < 0.1) return 'utf-16le';
    if (length >= 8 && evenZero / (length / 2) > 0.25 && oddZero / (length / 2) < 0.1) return 'utf-16be';
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
      return 'utf-8';
    } catch (_) {
      return 'gb18030';
    }
  }

  function detectDelimiter(text) {
    const candidates = [',', '\t', ';', '|'];
    const samples = [];
    let counts = [0, 0, 0, 0], quoted = false, touched = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        if (quoted && text[i + 1] === '"') { i++; continue; }
        quoted = !quoted;
      } else if (!quoted) {
        const delimiter = candidates.indexOf(char);
        if (delimiter >= 0) counts[delimiter]++;
        else if (char === '\r' || char === '\n') {
          if (touched) samples.push(counts);
          if (samples.length >= 32) break;
          counts = [0, 0, 0, 0]; touched = false;
          if (char === '\r' && text[i + 1] === '\n') i++;
          continue;
        }
      }
      touched = true;
    }
    // Ignore the final partial record unless the sample has no complete row.
    if (!samples.length && touched) samples.push(counts);
    let winner = 0, best = 0;
    candidates.forEach((_, column) => {
      const frequency = new Map();
      samples.forEach(row => frequency.set(row[column], (frequency.get(row[column]) || 0) + 1));
      frequency.forEach((count, separators) => {
        const score = separators ? count / samples.length * 1000 + Math.min(separators, 100) : 0;
        if (score > best) { winner = column; best = score; }
      });
    });
    return candidates[winner];
  }

  // Stateful RFC-style record scanner. Quote, escaped quote, CRLF and UTF code
  // point boundaries can all occur between chunks. Values remain exact strings.
  function createCsvParser(delimiter, onRow, options) {
    options = options || {};
    if (!delimiter || delimiter.length !== 1 || /["\r\n]/.test(delimiter)) throw new Error('CSV 分隔符无效');
    let row = [], field = '', quoted = false, pendingQuote = false, skipLF = false, touched = false;
    let records = 0;
    function emit() {
      row.push(field);
      const value = row;
      row = []; field = ''; touched = false;
      if (options.skipEmptyRows !== false && value.every(cell => cell === '')) return;
      records++;
      onRow(value, records);
    }
    return {
      write(text) {
        for (let i = 0; i < text.length; i++) {
          const char = text[i];
          if (quoted) {
            if (!pendingQuote) {
              const nextQuote = text.indexOf('"', i);
              if (nextQuote < 0) { field += text.slice(i); return; }
              field += text.slice(i, nextQuote);
              pendingQuote = true;
              i = nextQuote;
              continue;
            }
            pendingQuote = false;
            if (char === '"') { field += '"'; continue; }
            quoted = false;
          }
          if (skipLF) {
            skipLF = false;
            if (char === '\n') continue;
          }
          if (char === '"' && field === '') { quoted = true; touched = true; }
          else if (char === delimiter) { row.push(field); field = ''; touched = true; }
          else if (char === '\r' || char === '\n') { emit(); skipLF = char === '\r'; }
          else {
            // Append spans, rather than creating one string node per character
            // in long titles. This keeps intermediate allocations small.
            let end = i + 1;
            while (end < text.length && text[end] !== delimiter && text[end] !== '\r' && text[end] !== '\n') end++;
            field += text.slice(i, end); touched = true; i = end - 1;
          }
        }
      },
      finish() {
        if (quoted && !pendingQuote) throw new Error('CSV 引号未闭合（第 ' + (records + 1) + ' 条记录）');
        if (touched || row.length || field) emit();
        return records;
      },
      get records() { return records; }
    };
  }

  async function parseFileOnce(file, options) {
    options = options || {};
    const signal = options.signal;
    checkAbort(signal);
    if (!file || typeof file.slice !== 'function' || !Number.isFinite(file.size)) throw new Error('请选择有效的 CSV 文件');
    const total = file.size;
    const chunkSize = Math.max(256, Math.min(4 * 1024 * 1024, Number(options.chunkSize) || 64 * 1024));
    const sampleSize = Math.max(4, Math.min(256 * 1024, Number(options.sampleSize) || 64 * 1024));
    const yieldMs = Math.max(1, Number(options.yieldMs) || 8);
    const progressIntervalMs = options.progressIntervalMs === undefined ? 80 : Math.max(0, Number(options.progressIntervalMs) || 0);
    let loaded = 0, headers = null, rowsParsed = 0;
    const matrix = [], objectRows = options.objectRows ? [] : null;
    let encoding = '', delimiter = '', lastProgress = -Infinity, lastYield = now();
    function progress(phase, force) {
      if (typeof options.onProgress !== 'function') return;
      const time = now();
      if (!force && time - lastProgress < progressIntervalMs) return;
      lastProgress = time;
      options.onProgress({ phase, loaded, total, percent: total ? Math.min(100, Math.floor(loaded / total * 100)) : 100, rowsParsed, encoding, delimiter });
    }
    progress('reading', true);
    const sample = new Uint8Array(await file.slice(0, sampleSize).arrayBuffer());
    checkAbort(signal);
    encoding = detectEncoding(sample, options.encoding);
    const sampleText = new TextDecoder(encoding, { fatal: true }).decode(sample, { stream: true });
    delimiter = options.delimiter || detectDelimiter(sampleText);
    const decoder = new TextDecoder(encoding, { fatal: true });
    function decode(bytes, streaming) {
      try { return decoder.decode(bytes, { stream: streaming }); }
      catch (error) {
        error.csvEncoding = encoding;
        error.csvHadBOM = sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf;
        throw error;
      }
    }
    const parser = createCsvParser(delimiter, cells => {
      if (!headers) { headers = cells; return; }
      rowsParsed++;
      if (objectRows) {
        const row = Object.create(null);
        headers.forEach((header, index) => { row[header] = cells[index] === undefined ? '' : cells[index]; });
        objectRows.push(row);
      } else matrix.push(cells);
    }, options);
    // Slice reads bound intermediate memory and permit cancellation between reads.
    // The initial sample is reused, so no part of the file is read twice.
    for (let offset = 0; offset < total;) {
      checkAbort(signal);
      const bytes = offset === 0 ? sample : new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
      checkAbort(signal);
      // The sniff sample can exceed a caller's tiny parsing chunk size. Feed it
      // in chunks too, which also exercises boundaries in deterministic tests.
      for (let start = 0; start < bytes.length; start += chunkSize) {
        checkAbort(signal);
        const part = bytes.subarray(start, Math.min(bytes.length, start + chunkSize));
        parser.write(decode(part, true));
        loaded += part.length;
        progress('parsing', false);
        if (now() - lastYield >= yieldMs) { await pause(); checkAbort(signal); lastYield = now(); }
      }
      offset += bytes.length;
    }
    parser.write(decode(undefined, false));
    parser.finish();
    checkAbort(signal);
    progress('done', true);
    return { headers: headers || [], matrix: objectRows ? undefined : matrix, objectRows: objectRows || undefined, encoding, delimiter, bytesRead: loaded, rowsParsed, workerUsed: false };
  }

  async function parseFile(file, options) {
    options = options || {};
    try { return await parseFileOnce(file, options); }
    catch (error) {
      // An ASCII-only prefix is ambiguous. If GB18030 characters occur only
      // later, restart the bounded scanner after a fatal UTF-8 decode failure.
      // Never override an explicit encoding or a UTF-8 BOM, or swallow aborts.
      if ((!options.encoding || options.encoding === 'auto') && error.csvEncoding === 'utf-8' && !error.csvHadBOM) {
        checkAbort(options.signal);
        return parseFileOnce(file, Object.assign({}, options, { encoding: 'gb18030' }));
      }
      throw error;
    }
  }

  function workerMain(factory) {
    const api = factory();
    let controller;
    self.onmessage = async event => {
      const message = event.data || {};
      if (message.type === 'cancel') { if (controller) controller.abort(); return; }
      if (message.type !== 'parse') return;
      controller = new AbortController();
      try {
        const result = await api.parseFile(message.file, Object.assign({}, message.options, {
          signal: controller.signal,
          onProgress: progress => self.postMessage({ type: 'progress', progress })
        }));
        result.workerUsed = true;
        self.postMessage({ type: 'done', result });
      } catch (error) {
        self.postMessage({ type: 'error', error: { name: error.name, message: error.message } });
      }
    };
  }

  function createWorkerSource() {
    return '(' + workerMain.toString() + ')(' + createWorkbenchImport.toString() + ');';
  }

  async function parseInWorker(file, options) {
    options = options || {};
    checkAbort(options.signal);
    if (options.worker === false || typeof Worker === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return parseFile(file, options);
    let worker, url;
    try {
      url = URL.createObjectURL(new Blob([createWorkerSource()], { type: 'text/javascript' }));
      worker = new Worker(url);
    } catch (error) {
      if (url) URL.revokeObjectURL(url);
      if (options.fallback === false) throw error;
      return parseFile(file, options);
    }
    const result = await new Promise((resolve, reject) => {
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
          if (options.onProgress) {
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
        const error = new Error(event.message || 'CSV Worker 无法启动');
        error.workerStartup = true;
        cleanup(); reject(error);
      };
      const settings = {};
      ['encoding', 'delimiter', 'chunkSize', 'sampleSize', 'yieldMs', 'progressIntervalMs', 'skipEmptyRows', 'objectRows'].forEach(key => {
        if (options[key] !== undefined) settings[key] = options[key];
      });
      try { worker.postMessage({ type: 'parse', file, options: settings }); }
      catch (error) { cleanup(); reject(error); }
    }).catch(error => {
      // Some hosts disallow blob workers via CSP. The same bounded, yielding
      // scanner remains usable in that host without a second parser implementation.
      if (error.workerStartup && options.fallback !== false) return parseFile(file, options);
      throw error;
    });
    return result;
  }

  return { parseFile, parseInWorker, createCsvParser, detectEncoding, detectDelimiter, createWorkerSource };
});
