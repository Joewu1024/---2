(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkbenchTranslationTasks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const KEY_PREFIX = 'GTASK-';
  const normalizeText = value => String(value == null ? '' : value).normalize('NFC').replace(/\s+/g, ' ').trim();
  const normalizeKey = value => String(value == null ? '' : value).replace(/\s+/g, '').toUpperCase();
  const now = () => typeof performance === 'object' ? performance.now() : Date.now();
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));

  function validateId(id) {
    if (typeof id !== 'string' || id.length !== 36 || !UUID.test(id)) throw new Error('翻译任务编号无效');
    return id.toLowerCase();
  }
  function randomId(cryptoImpl) {
    if (cryptoImpl && typeof cryptoImpl.randomUUID === 'function') return validateId(cryptoImpl.randomUUID());
    if (cryptoImpl && typeof cryptoImpl.getRandomValues === 'function') {
      const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
      bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    }
    throw new Error('浏览器无法安全创建翻译任务编号');
  }
  function keyFor(id, index) { return KEY_PREFIX + id.toUpperCase() + '-' + String(index + 1).padStart(8, '0'); }
  function checkAbort(signal) {
    if (signal && signal.aborted) { const error = new Error('翻译任务处理已取消'); error.name = 'AbortError'; throw error; }
  }
  function scheduler(options) {
    let deadline = now() + 8, count = 0;
    return {
      due() { checkAbort(options.signal); return ++count % 50 === 0 && now() >= deadline; },
      async yield() {
        await pause(); checkAbort(options.signal); deadline = now() + 8;
      }
    };
  }
  function readSource(value) {
    if (typeof value !== 'string') throw new Error('翻译任务原文必须是文本');
    const source = normalizeText(value);
    if (!source || source.length > 32767) throw new Error('翻译任务原文不能为空或超过 Excel 单元格上限');
    return source;
  }
  function copyReference(reference, source) {
    if (!reference || typeof reference.modelId !== 'string' || !reference.modelId ||
        !(typeof reference.field === 'string' && reference.field || Number.isInteger(reference.field) && reference.field >= 0) ||
        reference.source != null && typeof reference.source !== 'string') throw new Error('翻译任务本地映射无效');
    // Explicit projection keeps unrelated row fields out of the local mapping too.
    return { modelId: reference.modelId, field: reference.field, source: reference.source == null ? source : reference.source };
  }

  async function createTask(entries, options) {
    options = options || {};
    checkAbort(options.signal);
    if (!Array.isArray(entries)) throw new Error('翻译任务需要原文列表');
    const id = options.id == null ? randomId(Object.prototype.hasOwnProperty.call(options, 'crypto') ? options.crypto : root.crypto) : validateId(options.id);
    const task = { version: 1, id, createdAt: new Date().toISOString(), entries: [] };
    const table = { headers: ['任务键', '待翻译原文'], data: [] }, bySource = new Map(), tick = scheduler(options);
    await tick.yield();
    for (const input of entries) {
      const source = readSource(input && input.source);
      if (input.references != null && !Array.isArray(input.references)) throw new Error('翻译任务本地映射必须是列表');
      const language = typeof input.language === 'string' && input.language.trim() ? input.language.trim() : 'auto';
      let stored = bySource.get(source);
      if (!stored) {
        const entry = { key: keyFor(id, task.entries.length), source, language, references: [] };
        task.entries.push(entry); table.data.push([entry.key, source]);
        stored = { entry, referenceKeys: new Set() }; bySource.set(source, stored);
      } else if (stored.entry.language !== language) stored.entry.language = 'auto';
      for (const item of input.references || []) {
        const reference = copyReference(item, input.source), signature = JSON.stringify([reference.modelId, reference.field, reference.source]);
        if (readSource(reference.source) !== source) throw new Error('本地映射原文与待翻译原文不一致');
        if (!stored.referenceKeys.has(signature)) { stored.referenceKeys.add(signature); stored.entry.references.push(reference); }
        if (tick.due()) await tick.yield();
      }
      if (tick.due()) await tick.yield();
    }
    return { task, table };
  }

  function basicUnchangedAllowed(source, engine) {
    if (engine && typeof engine.passthrough === 'function') return engine.passthrough(source);
    if (/[\u3400-\u9fff]/.test(source) && !/[a-z]/.test(source)) return true;
    // A digit-bearing model/code or a known connector can legitimately stay
    // unchanged. Without the quality engine, ambiguous uppercase titles fail.
    return /^[A-Z0-9+().,*/#_\s:-]+$/.test(source) && /\d/.test(source) || /^(USB(?:-C)?|AUX|RCA|HDMI|XLR|FM|AM|AC|DC|WIFI|WI-FI|BLUETOOTH)$/.test(source);
  }
  function problem(source, translation, validate, engine) {
    const result = normalizeText(translation);
    if (!result) return 'empty';
    if (/ZXQ|QXZ/i.test(result)) return 'markers';
    const unchanged = result === normalizeText(source);
    if (unchanged && !basicUnchangedAllowed(source, engine)) return 'untranslated';
    if (validate) return validate(source, result) === true ? '' : 'invalid';
    return /[\u3400-\u9fff]/.test(result) || unchanged && basicUnchangedAllowed(source, engine) ? '' : 'invalid';
  }

  async function decodeResult(task, matrix, options) {
    options = options || {};
    checkAbort(options.signal);
    if (!task || task.version !== 1 || !Array.isArray(task.entries)) throw new Error('本地翻译任务缺失或格式无效');
    const id = validateId(task.id);
    if (!Array.isArray(matrix)) throw new Error('翻译结果必须是二维单元格列表');
    const tick = scheduler(options), expected = new Map(), seen = new Map(), unknownKeys = new Set();
    const engine = root.BuyerTranslation;
    const validate = typeof options.validate === 'function' ? options.validate : engine && typeof engine.usable === 'function' ? engine.usable : null;
    const counts = { expected: task.entries.length, translated: 0, missing: 0, conflicts: 0, unknown: 0, empty: 0, untranslated: 0, markers: 0, invalid: 0, duplicates: 0, ignoredRows: 0 };
    await tick.yield();
    for (let index = 0; index < task.entries.length; index++) {
      const entry = task.entries[index];
      if (!entry || entry.key !== keyFor(id, index) || readSource(entry.source) !== entry.source || !Array.isArray(entry.references)) throw new Error('本地翻译任务映射已损坏，请重新导出任务');
      expected.set(normalizeKey(entry.key), entry);
      if (tick.due()) await tick.yield();
    }
    for (const row of matrix) {
      if (!Array.isArray(row)) throw new Error('翻译结果包含无效数据行');
      const key = normalizeKey(row[0]);
      if (!expected.has(key)) {
        // Headers may be translated and can occur anywhere. They never select
        // a field. Old-task or damaged task keys are reported separately.
        if (key.startsWith(KEY_PREFIX)) unknownKeys.add(key);
        else counts.ignoredRows++;
        if (tick.due()) await tick.yield(); continue;
      }
      const translation = row[1] == null ? '' : typeof row[1] === 'string' || typeof row[1] === 'number' ? String(row[1]).normalize('NFC').trim() : '';
      const comparable = normalizeText(translation), previous = seen.get(key);
      if (previous) {
        counts.duplicates++;
        if (previous.comparable !== comparable) previous.conflict = true;
      } else seen.set(key, { translation, comparable, conflict: false });
      if (tick.due()) await tick.yield();
    }
    const entries = [], missingKeys = [], conflictKeys = [], rejectedEntries = [];
    for (const [key, original] of expected) {
      const candidate = seen.get(key);
      const reason = !candidate ? 'missing' : candidate.conflict ? 'conflicts' : problem(original.source, candidate.translation, validate, engine);
      if (reason) {
        missingKeys.push(original.key); rejectedEntries.push({ key: original.key, reason });
        if (reason === 'conflicts') { conflictKeys.push(original.key); counts.conflicts++; }
        else if (reason !== 'missing') counts[reason]++;
      } else {
        const references = [];
        for (const item of original.references) {
          const reference = copyReference(item, original.source);
          if (readSource(reference.source) !== original.source) throw new Error('本地翻译任务映射原文已损坏');
          references.push(reference); if (tick.due()) await tick.yield();
        }
        entries.push({ key: original.key, source: original.source, language: original.language, translation: candidate.translation,
          references });
      }
      if (tick.due()) await tick.yield();
    }
    counts.translated = entries.length; counts.missing = missingKeys.length; counts.unknown = unknownKeys.size;
    return { taskId: id, entries, missing: counts.missing, conflicts: counts.conflicts, unknown: counts.unknown,
      missingKeys, conflictKeys, unknownKeys: Array.from(unknownKeys), rejectedEntries, counts };
  }

  return { createTask, decodeResult, normalizeKey };
});
