const PRODUCTION_ORIGIN = 'https://joewu1024.github.io';
const STORE_NAME = 'buyer-product-shares-v1';
const STORE_REGION = 'ap-southeast-1';
const IDENTIFIER = /^[a-f0-9]{64}$/;
const CIPHERTEXT = /^[A-Za-z0-9_-]+$/;
export const MAX_CONTENT_BYTES = 2700000;
export const MAX_REQUEST_BYTES = MAX_CONTENT_BYTES + 200;

class RequestProblem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function headers(origin, allowedOrigins) {
  const result = new Headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Vary': 'Origin'
  });
  if (origin && allowedOrigins.has(origin)) result.set('Access-Control-Allow-Origin', origin);
  return result;
}

function json(status, data, responseHeaders) {
  const copy = new Headers(responseHeaders);
  copy.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), {status, headers:copy});
}

async function parseRequest(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new RequestProblem(415, '请使用 JSON 格式提交分享');
  }
  const declaredSize = request.headers.get('content-length');
  if (declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > MAX_REQUEST_BYTES)) {
    throw new RequestProblem(413, '分享内容过大');
  }
  if (!request.body) throw new RequestProblem(400, '分享内容为空');
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new RequestProblem(413, '分享内容过大');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); }
  catch { throw new RequestProblem(400, '分享数据格式无效'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).length !== 2 || typeof data.id !== 'string' || !IDENTIFIER.test(data.id) ||
      typeof data.content !== 'string') {
    throw new RequestProblem(400, '分享数据格式无效');
  }
  if (data.content.length > MAX_CONTENT_BYTES) throw new RequestProblem(413, '分享内容过大');
  if (data.content.length < 38 || data.content.length % 4 === 1 || !CIPHERTEXT.test(data.content)) {
    throw new RequestProblem(400, '分享数据格式无效');
  }
  return data;
}

function preflight(request, allowedOrigins, responseHeaders, methods) {
  if (request.method !== 'OPTIONS') return null;
  const requestedMethod = request.headers.get('access-control-request-method');
  const origin = request.headers.get('origin');
  const requestedHeaders = (request.headers.get('access-control-request-headers') || '')
    .toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
  if (!allowedOrigins.has(origin) || !methods.includes(requestedMethod) ||
      requestedHeaders.some(value => value !== 'content-type')) {
    return json(403, {message:'此页面不能访问分享服务'}, responseHeaders);
  }
  const copy = new Headers(responseHeaders);
  copy.set('Access-Control-Allow-Methods', methods.join(', ') + ', OPTIONS');
  copy.set('Access-Control-Allow-Headers', 'Content-Type');
  copy.set('Access-Control-Max-Age', '600');
  return new Response(null, {status:204, headers:copy});
}

export function createShareApi({getStore, allowedOrigins = [PRODUCTION_ORIGIN]}) {
  const origins = new Set(allowedOrigins);
  const store = () => getStore({name:STORE_NAME, consistency:'strong', region:STORE_REGION});

  async function publish(request) {
    const origin = request.headers.get('origin');
    const responseHeaders = headers(origin, origins);
    const options = preflight(request, origins, responseHeaders, ['POST']);
    if (options) return options;
    if (request.method !== 'POST') {
      responseHeaders.set('Allow', 'POST, OPTIONS');
      return json(405, {message:'请求方法不支持'}, responseHeaders);
    }
    if (!origins.has(origin)) return json(403, {message:'此页面不能发布分享'}, responseHeaders);
    if (new URL(request.url).pathname !== '/api/shares') return json(404, {message:'没有找到此接口'}, responseHeaders);
    try {
      const {id, content} = await parseRequest(request);
      const archive = store();
      const {modified} = await archive.set(id, content, {onlyIfNew:true});
      if (!modified) {
        const existing = await archive.get(id, {type:'text'});
        if (existing !== content) return json(409, {message:'分享标识已被使用，请重新生成'}, responseHeaders);
      }
      return json(201, {id}, responseHeaders);
    } catch (error) {
      if (error instanceof RequestProblem) return json(error.status, {message:error.message}, responseHeaders);
      return json(503, {message:'分享暂时无法保存，请稍后重试'}, responseHeaders);
    }
  }

  async function read(request) {
    const origin = request.headers.get('origin');
    const responseHeaders = headers(origin, origins);
    const options = preflight(request, origins, responseHeaders, ['GET', 'HEAD']);
    if (options) return options;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      responseHeaders.set('Allow', 'GET, HEAD, OPTIONS');
      return json(405, {message:'请求方法不支持'}, responseHeaders);
    }
    if (origin && !origins.has(origin)) return json(403, {message:'此页面不能读取分享'}, responseHeaders);
    const match = new URL(request.url).pathname.match(/^\/api\/shares\/([a-f0-9]{64})$/);
    if (!match) return json(404, {message:'没有找到这份分享'}, responseHeaders);
    try {
      const content = await store().get(match[1], {type:'text'});
      if (content === null) return json(404, {message:'没有找到这份分享，请确认链接完整'}, responseHeaders);
      responseHeaders.set('Content-Type', 'text/plain; charset=utf-8');
      return new Response(request.method === 'HEAD' ? null : content, {status:200, headers:responseHeaders});
    } catch {
      return json(503, {message:'分享暂时无法读取，请稍后重试'}, responseHeaders);
    }
  }
  return {publish, read};
}
