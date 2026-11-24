(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./vendor/fflate-0.8.3.min.js'));
  } else {
    root.BuyerShareCodec = factory(root.fflate);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fflate) {
  'use strict';

  const MAX_TOKEN_LENGTH = 2000000;
  const MAX_DECODED_BYTES = 32 * 1024 * 1024;
  const INPUT_CHUNK_BYTES = 1024;
  const FIELDS = ['id', 'itemChinese', 'modelChinese', 'target', 'category', 'invitation', 'model', 'shopee', 'shopeeUrl'];
  const BADGES = [
    ['diamond', '💎', '150%投流'],
    ['crown', '👑', '运营重点主推款']
  ];

  // The dictionary is part of the "c" link format. A change requires a new prefix.
  const REGIONS = ['com.my', 'vn', 'tw', 'co.th', 'ph', 'sg', 'co.id', 'com.br', 'com.mx', 'cl', 'co'];
  const DICTIONARY_TEXT = REGIONS.map(region =>
    'https://shopee.' + region + '/product/https://cf.shopee.' + region + '/file/'
  ).join('') +
    'http://shopee.com.my/product/http://shopee.ph/product/' +
    'https://down-tx-my.img.susercontent.com/file/https://down-my.img.susercontent.com/file/' +
    'https://down-vn.img.susercontent.com/file/https://down-th.img.susercontent.com/file/' +
    'https://down-ph.img.susercontent.com/file/data:image/jpeg;base64,data:image/webp;base64,data:image/png;base64,' +
    '家用电器遥控器配件智能电视远程控制适用于无线蓝牙';
  const dictionary = fflate.strToU8(DICTIONARY_TEXT);

  function tooLarge() {
    return new Error('分享数据过大，请分批生成分享链接');
  }

  function invalid() {
    return new Error('分享数据损坏或格式无效，请向分享者索取新链接');
  }

  function pack(product) {
    const row = FIELDS.map(name => product[name] == null ? '' : String(product[name]));
    if (row[2] && row[2] === row[1]) row[2] = 0;
    if (row[8] && row[8] === row[7]) row[8] = 0;
    if (product.badges && product.badges.length) {
      row.push(product.badges.map(badge => {
        const fields = [badge.kind, badge.icon, badge.text].map(value => value == null ? '' : String(value));
        const known = BADGES.findIndex(entry => entry.every((value, i) => value === fields[i]));
        return known < 0 ? fields : known + 1;
      }));
    }
    while (row.length > 1 && row[row.length - 1] === '') row.pop();
    return row;
  }

  function unpack(row) {
    if (!Array.isArray(row) || row.length < 1 || row.length > FIELDS.length + 1) throw invalid();
    const product = {};
    FIELDS.forEach((name, i) => {
      let value = i < row.length ? row[i] : '';
      if (value === 0 && i === 2) value = product.itemChinese;
      if (value === 0 && i === 8) value = product.shopee;
      if (typeof value !== 'string') throw invalid();
      product[name] = value;
    });
    const badges = row.length > FIELDS.length ? row[FIELDS.length] : [];
    if (!Array.isArray(badges)) throw invalid();
    product.badges = badges.map(value => {
      const fields = value === 1 || value === 2 ? BADGES[value - 1] : value;
      if (!Array.isArray(fields) || fields.length !== 3 || fields.some(field => typeof field !== 'string')) throw invalid();
      return {kind:fields[0], icon:fields[1], text:fields[2]};
    });
    return product;
  }

  // Adler-32 detects accidental edits and truncation of the compressed snapshot.
  function checksum(bytes) {
    let a = 1;
    let b = 0;
    for (let i = 0; i < bytes.length; i++) {
      a += bytes[i];
      if (a >= 65521) a -= 65521;
      b += a;
      if (b >= 65521) b -= 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  function base64Url(bytes) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(offset, offset + 8192)));
    }
    return btoa(chunks.join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(value) {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw invalid();
    const padding = (4 - value.length % 4) % 4;
    const string = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, padding));
    const bytes = new Uint8Array(string.length);
    for (let i = 0; i < string.length; i++) bytes[i] = string.charCodeAt(i);
    return bytes;
  }

  function encode(products) {
    if (!Array.isArray(products) || !products.length) throw new Error('分享链接中没有产品');
    const bytes = fflate.strToU8(JSON.stringify(products.map(pack)));
    if (bytes.length > MAX_DECODED_BYTES) throw tooLarge();
    const compressed = fflate.deflateSync(bytes, {level:9, dictionary});
    const packet = new Uint8Array(4 + compressed.length);
    new DataView(packet.buffer).setUint32(0, checksum(bytes));
    packet.set(compressed, 4);
    const token = 'c' + base64Url(packet);
    if (token.length > MAX_TOKEN_LENGTH) throw tooLarge();
    return token;
  }

  function inflate(compressed) {
    const chunks = [];
    let length = 0;
    const stream = new fflate.Inflate({dictionary}, chunk => {
      length += chunk.length;
      if (length > MAX_DECODED_BYTES) throw tooLarge();
      chunks.push(chunk);
    });
    // Chunked input lets the decoder enforce the expansion limit during inflation.
    for (let offset = 0; offset < compressed.length; offset += INPUT_CHUNK_BYTES) {
      const end = offset + INPUT_CHUNK_BYTES;
      stream.push(compressed.subarray(offset, end), end >= compressed.length);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  function decodeUtf8(bytes) {
    if (typeof TextDecoder === 'function') {
      try {
        const decoded = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
        // Some WebViews silently ignore fatal mode. Validate any replacement characters below.
        if (!decoded.includes('\uFFFD')) return decoded;
      } catch (error) {
        // A WebView may expose TextDecoder without supporting strict decoding.
      }
    }
    const chunks = [];
    let part = '';
    for (let i = 0; i < bytes.length;) {
      const first = bytes[i++];
      let point = first;
      let extra = 0;
      let minimum = 0;
      if (first >= 194 && first <= 223) {
        point = first & 31;
        extra = 1;
        minimum = 128;
      } else if (first >= 224 && first <= 239) {
        point = first & 15;
        extra = 2;
        minimum = 2048;
      } else if (first >= 240 && first <= 244) {
        point = first & 7;
        extra = 3;
        minimum = 65536;
      } else if (first > 127) {
        throw invalid();
      }
      if (i + extra > bytes.length) throw invalid();
      for (let j = 0; j < extra; j++) {
        const next = bytes[i++];
        if ((next & 192) !== 128) throw invalid();
        point = point * 64 + (next & 63);
      }
      if (point < minimum || point > 1114111 || (point >= 55296 && point <= 57343)) throw invalid();
      if (point > 65535) {
        point -= 65536;
        part += String.fromCharCode(55296 + (point >> 10), 56320 + (point & 1023));
      } else {
        part += String.fromCharCode(point);
      }
      if (part.length >= 8192) {
        chunks.push(part);
        part = '';
      }
    }
    chunks.push(part);
    return chunks.join('');
  }

  function decode(token) {
    if (typeof token !== 'string' || token.charAt(0) !== 'c') throw invalid();
    if (token.length > MAX_TOKEN_LENGTH) throw tooLarge();
    try {
      const packet = fromBase64Url(token.slice(1));
      if (packet.length <= 4) throw invalid();
      const bytes = inflate(packet.subarray(4));
      if (checksum(bytes) !== new DataView(packet.buffer).getUint32(0)) throw invalid();
      const rows = JSON.parse(decodeUtf8(bytes));
      if (!Array.isArray(rows) || !rows.length) throw invalid();
      return {v:1, products:rows.map(unpack)};
    } catch (error) {
      if (error && /^分享数据过大/.test(error.message)) throw error;
      throw invalid();
    }
  }

  return {encode, decode, decodeUtf8};
});
