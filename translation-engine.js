(function (root) {
  'use strict';
  const normalize = value => String(value == null ? '' : value).normalize('NFC').replace(/\s+/g, ' ').trim();
  const chinese = value => /[\u3400-\u9fff]/.test(value);
  const codes = new Set(['USB', 'USB-C', 'AUX', 'RCA', 'HDMI', 'XLR', 'FM', 'AM', 'AC', 'DC', 'WIFI', 'WI-FI', 'BLUETOOTH']);
  function identity(value) {
    const text=normalize(value);
    if(!/^[A-Z0-9][A-Z0-9+().,*/#_\s-]{0,79}$/.test(text))return false;
    const words=text.match(/[A-Z]+/g)||[];
    return !words.some(word=>genericWords.has(word.toLowerCase())||['SALE','HOT','BEST','MODEL','COLOR','SIZE','SET','PIECES','ORIGINAL'].includes(word));
  }
  function sourceIssue(value) {
    const text=normalize(value);
    if(/[\uFFFD]/.test(text)||/(?:Ã[\u0080-\u00bf]|á»|áº|Æ°)/.test(text))return '原文疑似编码损坏，请核对';
    if(/[\p{L}][?？][\p{L}]/u.test(text)||(text.match(/[A-Za-zÀ-ỹ][?？](?=\s|$)/g)||[]).length>=2)return '原文字符缺失，请核对';
    return '';
  }
  function refine(source, result) {
    let chinese=normalize(result);
    if(/\bcontrole\s+remoto\b/i.test(source))chinese=chinese.replace(/远程控制(?:器)?/g,'遥控器').replace(/遥控器套件/g,'遥控器套装');
    if(/กล่องชาร์จ|charging case|charger case|kotak pengecas|hộp sạc|充电盒/i.test(source))chinese=chinese.replace(/充电器外壳/g,'充电盒');
    return chinese;
  }
  function passthrough(value) {
    const text = normalize(value);
    if(identity(text))return true;
    if(chinese(text)) {
      const remainder=text
        .replace(/\b[A-Z0-9][A-Z0-9+*/#.-]{0,39}\b/g,token=>genericWords.has(token.toLowerCase())?token:'')
        .replace(/\b\d+(?:[.,]\d+)?\s*(?:mm|cm|ml|kg|mah|gb|tb|khz|mhz|ghz|hz|m|l|g|w|v|a)\b/gi,'');
      if(/^[\u3400-\u9fff\d\s\p{P}\p{S}]+$/u.test(remainder))return true;
    }
    return !text || /^[\u3400-\u9fff\d\s.,，。!！?？:：;；()（）【】\-]+$/.test(text) ||
      (/^(?=.*\d)[A-Z0-9+().,*/#\s-]{1,40}$/.test(text)&&!(text.match(/[A-Z]+/g)||[]).some(word=>genericWords.has(word.toLowerCase()))) || codes.has(text.toUpperCase());
  }
  function simple(value) {
    const text=normalize(value),lower=text.toLowerCase();
    const colors=[['màu trắng','白色'],['màu đen','黑色'],['สีดำ','黑色'],['สีขาว','白色'],['trắng','白色'],['đen','黑色'],['hitam','黑色'],['putih','白色'],['preto','黑色'],['branco','白色'],['black','黑色'],['white','白色'],['blue','蓝色'],['red','红色'],['green','绿色'],['silver','银色'],['gold','金色']];
    for(const [source,chinese] of colors) {
      if(lower===source)return chinese;
      const needsBoundary=/[a-zÀ-ỹ]/i.test(source);
      if(lower.startsWith(source)&&(!needsBoundary||/[\s:：-]/.test(text[source.length]||''))) {
        const rest=text.slice(source.length).replace(/^[\s:：-]+/,'');
        if(rest&&passthrough(rest))return chinese+' '+rest;
      }
      if(lower.endsWith(source)&&(!needsBoundary||/[\s:：-]/.test(text[text.length-source.length-1]||''))) {
        const rest=text.slice(0,-source.length).replace(/[\s:：-]+$/,'');
        if(rest&&passthrough(rest))return rest+' '+chinese;
      }
    }
    return '';
  }
  const genericWords = new Set(('kit controle remoto com para fonte cabos cabo sem fio branco branca preto preta original modelo completo completa ' +
    'wireless earphones headphones speaker microphone charger charging case black white blue red cable remote control with without pack pieces ' +
    'bluetooth headset portable battery rechargeable television tv smart universal replacement new ' +
    'untuk dengan tanpa wayar hitam putih biru merah pembesar suara pengecas fon telinga ' +
    'for and the of self service system call pager buzzer keyboard mouse camera television headset tablet phone electric digital sensor receiver transmitter').split(' '));
  function usable(source, result) {
    source = normalize(source); result = normalize(result);
    if (!result || /\uFFFD|ZXQ\s*\d{3,}\s*QXZ/i.test(result)) return false;
    if(identity(source))return source===result;
    if(sourceIssue(source)&&/[A-Za-zÀ-ỹ][?？]|[?？][A-Za-zÀ-ỹ]/.test(result))return false;
    const direct=passthrough(source);
    if(direct&&source===result)return true;
    if (!chinese(result) || (!direct&&source.toLowerCase() === result.toLowerCase())) return false;
    if (/[\u0e00-\u0e7f\u0400-\u04ff\u3040-\u30ff\uac00-\ud7af]/.test(result)) return false;
    const sourceWords = new Set(source.toLowerCase().match(/[a-zÀ-ỹ]+/g) || []);
    const leftovers = (result.toLowerCase().match(/[a-zÀ-ỹ]+/g) || []).filter(w => genericWords.has(w) && sourceWords.has(w));
    if (leftovers.length >= 3) return false;
    const packed = result.toUpperCase().replace(/[\s_.\-]/g, '');
    const names=source.match(/\b[A-Z][A-Z0-9&_.+-]{1,29}\b/g)||[];
    if(names.some(name=>identity(name)&&/[A-Z]{2}/.test(name)&&!packed.includes(name.toUpperCase().replace(/[\s_.-]/g,''))))return false;
    const models = source.match(/\b[A-Z]{1,8}[-]?\d+[A-Z0-9-]*\b/g) || [];
    if (models.some(model => !/^(?:USB|BT|WIFI|HDMI)\d/.test(model) && !packed.includes(model.replace(/-/g, '')))) return false;
    const numericValue = token => {
      if(token.includes(',')&&token.includes('.'))token=token.lastIndexOf(',')>token.lastIndexOf('.')?token.replace(/\./g,'').replace(',','.'):token.replace(/,/g,'');
      else if(/^\d{1,3}(,\d{3})+$/.test(token))token=token.replace(/,/g,'');
      else token=token.replace(',','.');
      return String(Number(token));
    };
    const digits = text => new Set([...text.matchAll(/(?<![A-Za-z0-9])\d+(?:[.,]\d+)*(?!\d)/g)].map(match => numericValue(match[0])));
    const resultNumbers = digits(result);
    const chineseDigits={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
    const chineseNumber = token => {
      const units={'十':10,'百':100,'千':1000,'万':10000,'亿':100000000};
      if(!/[十百千万亿]/.test(token))return Number([...token].map(char=>chineseDigits[char]).join(''));
      let total=0,section=0,number=0;
      for(const char of token){if(char in chineseDigits){number=chineseDigits[char];continue}const unit=units[char];if(unit<10000){section+=(number||1)*unit;number=0}else{total+=(section+number)*unit;section=0;number=0}}
      return total+section+number;
    };
    for(const match of result.matchAll(/([零〇一二两三四五六七八九十百千万亿]+)(?:点([零〇一二两三四五六七八九]+))?(?=\s*(?:个|件|只|支|套|根|条|对|双|台|片|节|路|口|声道|毫米|厘米|米|伏|瓦|安|毫安|毫升|升|寸|英寸|赫兹|千克|克|小时|分钟|秒))/g)) {
      const decimal=match[2]?[...match[2]].map(char=>chineseDigits[char]).join(''):'';
      resultNumbers.add(String(Number(String(chineseNumber(match[1]))+(decimal?'.'+decimal:''))));
    }
    if(/双(?=声道|麦|喇叭|扬声器|耳|线|电缆|电池|接口|电压|屏|端|频|路)|一[对双]/.test(result))resultNumbers.add('2');
    if ([...digits(source)].some(n => !resultNumbers.has(n))) return false;
    return source.length < 60 || result.length >= source.length * 0.07;
  }
  function language(value, hint = '') {
    const text = normalize(value);
    if (/[\u0e00-\u0e7f]/.test(text)) return 'th';
    if (/[ăâđêôơưĂÂĐÊÔƠƯ\u1ea0-\u1ef9]/.test(text)) return 'vi';
    if (/[\u0400-\u04ff]/.test(text)) return 'ru';
    if (/[\u3040-\u30ff]/.test(text)) return 'ja';
    if (/[\uac00-\ud7af]/.test(text)) return 'ko';
    if (/[\u0600-\u06ff]/.test(text)) return 'ar';
    if (/\b(controle|remoto|fonte|cabos?|televis[aã]o|completa?|divers[aã]o|entretenimento|caixa|som|amplificada|microfone|fone|preto|branc[oa]|vermelh[oa]|prata|falante|ouvido|bivolt|polegadas|parafuso|tomada|produto|unidades?|marrom|tamanho)\b/i.test(text)) return 'pt';
    if (/\b(pembesar|suara|untuk|warna|hitam|putih|merah|biru|hijau|kuning|kecil|wayar|tanpa|mudah|alih|dengan|bateri|pakej|percuma|pengecas)\b/i.test(text)) return hint === 'id' ? 'id' : 'ms';
    if (/\b(auriculares|inal[aá]mbric[oa]s?|altavoz|blanco|negro|rojo|tama[ñn]o|cargador)\b/i.test(text)) return 'es';
    if (/\b(wireless|headphones?|speaker|microphone|charger|charging|black|white|blue|remote|control|with|without|case|cable|battery)\b/i.test(text)) return 'en';
    return ['pt', 'vi', 'th', 'ms', 'id', 'es', 'en', 'ru', 'ja', 'ko', 'ar'].includes(hint) ? hint : 'en';
  }
  class Queue {
    constructor(options) {
      this.options = options;
      this.cache = options.cache || new Map();
      this.jobs = new Map(); this.queue = []; this.failedUntil = new Map();
      this.active = 0; this.limit = options.concurrency || 3; this.maxLimit = this.limit;
      this.batchSize = options.batchSize || 12; this.maxChars = options.maxChars || 2400;
      this.paused = false; this.cooldown = 0; this.timer = 0; this.order = 0; this.scheduled = false;
      this.stats = {requests: 0, completed: 0, cacheHits: 0, failed: 0};
    }
    cached(text) {
      text = normalize(text);
      const value = this.cache.get(text);
      if (usable(text, value)) {
        const result=refine(text,value);
        if(result!==value){this.cache.set(text,result);this.options.onCache?.(text,result)}
        return result;
      }
      if (value != null) this.cache.delete(text);
      return '';
    }
    request(value, options = {}) {
      const text = normalize(value);
      if (!text) return Promise.resolve('');
      if(identity(text)){if(this.cache.has(text)&&this.cache.get(text)!==text)this.remember(text,text);return Promise.resolve(text)}
      const cached = this.cached(text);
      if (cached) { this.stats.cacheHits++; return Promise.resolve(cached); }
      const direct = [this.options.simple?.(text), simple(text), passthrough(text) ? text : ''].find(value=>value&&usable(text,value));
      if (direct) { this.remember(text, direct); return Promise.resolve(direct); }
      const lang = options.language || language(text), key = lang + '\u0000' + text;
      if ((this.failedUntil.get(key) || 0) > Date.now() && !options.retry) return Promise.resolve('');
      const priority = options.priority ?? 0;
      if (this.jobs.has(key)) {
        const job = this.jobs.get(key); job.priority = Math.min(job.priority, priority);
        this.schedule(); return job.promise;
      }
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      const job = {key, text, lang, priority, resolve, promise, context:options.context||{}, order: ++this.order, attempts: 0, single: lang === 'ms', readyAt: 0};
      this.jobs.set(key, job); this.queue.push(job);
      this.schedule();
      return promise;
    }
    schedule() { if(!this.scheduled) { this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;this.pump()}); } }
    remember(text, value) {
      if (!usable(text, value)) return;
      this.cache.set(text, value); this.options.onCache?.(text, value);
    }
    finish(job, value) {
      if (value) { this.remember(job.text, value); this.stats.completed++; }
      else { this.failedUntil.set(job.key, Date.now() + 5000); this.stats.failed++; }
      this.jobs.delete(job.key); job.resolve(value || '');
    }
    demoteQueued() { for (const job of this.queue) if (job.priority >= 0) job.priority = 2; }
    cancelQueued() { const pending = this.queue.splice(0); for (const job of pending) { this.jobs.delete(job.key); job.resolve(''); } }
    setPaused(value) { this.paused = !!value; this.options.onActivity?.(); if (!this.paused) this.pump(); }
    pump() {
      clearTimeout(this.timer);
      if (this.paused) return;
      const now = Date.now();
      if (now < this.cooldown) { this.timer = setTimeout(() => this.pump(), this.cooldown - now); return; }
      this.queue.sort((a,b) => a.priority - b.priority || a.order - b.order);
      while (this.active < this.limit && this.queue.length) {
        const firstIndex = this.queue.findIndex(job => job.readyAt <= Date.now());
        if (firstIndex < 0) {
          this.timer = setTimeout(() => this.pump(), Math.max(1, Math.min(...this.queue.map(job => job.readyAt)) - Date.now()));
          break;
        }
        const first = this.queue.splice(firstIndex,1)[0], batch = [first]; let size = first.text.length;
        if (!first.single) for (let i=0; i<this.queue.length && batch.length<this.batchSize;) {
          const job = this.queue[i];
          if (!job.single && job.lang === first.lang && job.readyAt <= Date.now() && size + job.text.length <= this.maxChars) {
            batch.push(job); size += job.text.length; this.queue.splice(i,1);
          } else i++;
        }
        this.active++;
        this.run(batch).finally(() => { this.active--; this.options.onActivity?.(); this.pump(); });
      }
      this.options.onActivity?.();
    }
    async run(batch) {
      try {
        this.stats.requests++;
        const result = await this.options.requestBatch(batch.map(job => job.text), batch[0].lang, batch.map(job=>job.context));
        if (!Array.isArray(result) || result.length !== batch.length) throw Object.assign(new Error('翻译返回条数不一致'), {split:true});
        for (let i=0; i<batch.length; i++) {
          if (usable(batch[i].text, result[i])) this.finish(batch[i], refine(batch[i].text,result[i]));
          else this.retry(batch[i], {split:true, message:'部分文本尚未获得完整中文'});
        }
      } catch (error) {
        if (error.rateLimited) {
          this.limit = Math.max(1, this.limit - 1);
          this.cooldown = Date.now() + Math.max(1000, error.retryAfter || 1500);
        }
        for (const job of batch) this.retry(job, error);
      }
    }
    retry(job, error) {
      if(error.permanent){this.options.onError?.(error);this.finish(job,'');this.failedUntil.set(job.key,Infinity);return}
      job.attempts++;
      if (error.split && !job.single) { job.single = true; job.readyAt = 0; this.queue.push(job); return; }
      if (job.attempts <= 2) {
        job.readyAt = Date.now() + (error.rateLimited ? 0 : 250 * job.attempts);
        this.queue.push(job);
      } else {
        this.options.onError?.(error); this.finish(job, '');
      }
    }
  }
  const api = {normalize, identity, sourceIssue, passthrough, simple, usable, language, refine, Queue};
  root.BuyerTranslation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
