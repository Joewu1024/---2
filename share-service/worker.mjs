// A durable product snapshot service. No database or bucket is created by requests.
const DAY = 86400000;
const TRUSTED_IMAGE_HOSTS = new Set([
  'cf.shopee.com.my','cf.shopee.vn','cf.shopee.com.br','cf.shopee.ph',
  'cf.shopee.sg','cf.shopee.co.th','cf.shopee.co.id','cf.shopee.tw',
  'down-my.img.susercontent.com','down-vn.img.susercontent.com',
  'down-br.img.susercontent.com','down-ph.img.susercontent.com',
  'down-sg.img.susercontent.com','down-th.img.susercontent.com',
  'down-id.img.susercontent.com','down-tw.img.susercontent.com'
]);
const IMAGE_TYPES = new Set(['image/jpeg','image/png','image/webp','image/gif','image/avif']);
const TEXT_FIELDS = ['id','model','itemChinese','modelChinese','category','invitation','target','shopee','shopeeUrl'];

export class ShareError extends Error {
  constructor(status, code, message) { super(message); this.status=status; this.code=code; }
}
function fail(status,code,message) { throw new ShareError(status,code,message); }
function positive(value,fallback,max=Number.MAX_SAFE_INTEGER) {
  const n=Number(value); return Number.isSafeInteger(n)&&n>0&&n<=max?n:fallback;
}
function settings(env) {
  return {
    maxProducts:positive(env.MAX_PRODUCTS,200,2000), maxFieldChars:20000,
    maxBodyBytes:positive(env.MAX_BODY_BYTES,2097152,8388608),
    maxImageBytes:positive(env.MAX_IMAGE_BYTES,8388608,8388608),
    maxAssetBytes:positive(env.MAX_ASSET_BYTES,33554432,33554432),
    maxArchiveMs:positive(env.MAX_IMAGE_ARCHIVE_MS,45000,60000),
    maxRemoteFetches:positive(env.MAX_REMOTE_IMAGE_FETCHES,24,32),
    bootstrapIp:positive(env.BOOTSTRAP_IP_DAILY_LIMIT,10),
    bootstrapGlobal:positive(env.BOOTSTRAP_GLOBAL_DAILY_LIMIT,200),
    shareIp:positive(env.SHARE_IP_DAILY_LIMIT,50),
    shareWriter:positive(env.SHARE_WRITER_DAILY_LIMIT,50),
    shareGlobal:positive(env.SHARE_GLOBAL_DAILY_LIMIT,200),
    bytesGlobal:positive(env.GLOBAL_BYTES_DAILY_LIMIT,1073741824),
    bytesTotal:positive(env.GLOBAL_BYTES_TOTAL_LIMIT,8589934592)
  };
}
export function escapeHtml(value) {
  return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function base64url(bytes) {
  let s=''; for(let i=0;i<bytes.length;i++)s+=String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export function randomId(byteLength=16) { return base64url(crypto.getRandomValues(new Uint8Array(byteLength))); }
async function sha256(value) {
  const data=typeof value==='string'?new TextEncoder().encode(value):value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),n=>n.toString(16).padStart(2,'0')).join('');
}
function equalHash(a,b) {
  if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;
  let difference=0;for(let i=0;i<a.length;i++)difference|=a.charCodeAt(i)^b.charCodeAt(i);return difference===0;
}
export function sanitizeProducts(products,limits={maxProducts:200,maxFieldChars:20000}) {
  const maxProducts=limits.maxProducts??200,maxChars=limits.maxFieldChars??20000;
  if(!Array.isArray(products)||!products.length)fail(400,'NO_PRODUCTS','请至少选择一个产品');
  if(products.length>maxProducts)fail(413,'TOO_MANY_PRODUCTS','一次最多分享 '+maxProducts+' 个产品，请分批生成');
  return products.map(product=>{
    if(!product||typeof product!=='object'||Array.isArray(product))fail(400,'INVALID_PRODUCT','产品字段格式不正确');
    const clean={};
    for(const field of TEXT_FIELDS) {
      const value=product[field]??'';
      if(typeof value!=='string')fail(400,'INVALID_FIELD','产品字段必须是文字');
      // Data images are bounded by the total JSON and image byte limits instead.
      if(field!=='model'&&value.length>maxChars)fail(413,'FIELD_TOO_LONG','产品文字太长，请减少内容');
      clean[field]=value;
    }
    if(product.badges!=null&&!Array.isArray(product.badges))fail(400,'INVALID_BADGES','产品标签格式不正确');
    if((product.badges||[]).length>8)fail(400,'INVALID_BADGES','产品标签过多');
    clean.badges=(product.badges||[]).map(badge=>{
      if(!badge||typeof badge!=='object'||Array.isArray(badge))fail(400,'INVALID_BADGES','产品标签格式不正确');
      const result={};for(const key of ['kind','icon','text']) {
        const value=badge[key]??'';
        if(typeof value!=='string'||value.length>200)fail(400,'INVALID_BADGES','产品标签格式不正确');
        result[key]=value;
      }return result;
    });
    return clean;
  });
}
export function trustedImageUrl(value) {
  let url;try {url=new URL(value);}catch {fail(400,'IMAGE_URL','图片网址格式不正确');}
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!TRUSTED_IMAGE_HOSTS.has(url.hostname)) {
    fail(400,'IMAGE_HOST','图片来源不在允许归档的 HTTPS 商品图片域名中');
  }
  // Exact public CDN names only: no arbitrary DNS names, raw IPs or private hosts.
  url.hash='';return url;
}
export function imageSignature(bytes,type) {
  const ascii=(from,to)=>String.fromCharCode(...bytes.subarray(from,to));
  if(type==='image/jpeg')return bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if(type==='image/png')return [137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b);
  if(type==='image/webp')return ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP';
  if(type==='image/gif')return /^GIF8[79]a$/.test(ascii(0,6));
  return type==='image/avif'&&ascii(4,8)==='ftyp'&&/avif|avis/.test(ascii(8,32));
}
async function readLimited(stream,maxBytes,overflowMessage='请求内容过大') {
  if(!stream)return new Uint8Array();
  const reader=stream.getReader(),chunks=[];let length=0;
  try {
    while(true) {
      const {value,done}=await reader.read();if(done)break;
      length+=value.byteLength;if(length>maxBytes)fail(413,'TOO_LARGE',overflowMessage);
      chunks.push(value);
    }
  } catch(error) {try{await reader.cancel();}catch{}throw error;} finally {reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
async function readJson(request,maxBytes) {
  if(!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type')||''))fail(415,'JSON_REQUIRED','请使用 JSON 请求');
  const length=Number(request.headers.get('Content-Length'));
  if(Number.isFinite(length)&&length>maxBytes)fail(413,'TOO_LARGE','请求内容过大');
  try {
    const bytes=await readLimited(request.body,maxBytes);
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }catch(error){if(error instanceof ShareError)throw error;fail(400,'INVALID_JSON','请求内容不是有效 JSON');}
}
function requireBindings(env) {
  if(!env.DB||!env.BUCKET)fail(503,'STORAGE_UNAVAILABLE','分享存储尚未就绪，请稍后重试');
}
function publicBase(request,env) {
  let url;try{url=new URL(env.PUBLIC_BASE_URL||new URL(request.url).origin);}catch{fail(503,'SERVICE_CONFIG','分享服务地址配置有误');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)fail(503,'SERVICE_CONFIG','分享服务地址必须是公开 HTTPS 地址');
  return url.href.replace(/\/$/,'');
}
function corsOrigin(request,env) {
  const own=new URL(request.url).origin,origin=request.headers.get('Origin');
  const allowed=new Set([own,'https://joewu1024.github.io']);
  for(const raw of String(env.ALLOWED_ORIGINS||'').split(',')) {
    try{const url=new URL(raw.trim());if(url.protocol==='https:'&&url.origin===raw.trim())allowed.add(url.origin);}catch{}
  }
  return origin&&allowed.has(origin)?origin:null;
}
function headersFor(request,env,extra={}) {
  const headers=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...extra});
  const origin=corsOrigin(request,env);if(origin){headers.set('Access-Control-Allow-Origin',origin);headers.set('Vary','Origin');}
  return headers;
}
function json(request,env,data,status=200,extra={}) {
  return new Response(JSON.stringify(data),{status,headers:headersFor(request,env,{'Content-Type':'application/json;charset=UTF-8',...extra})});
}
function requireWriteOrigin(request,env) {if(!corsOrigin(request,env))fail(403,'ORIGIN_DENIED','此网站不能写入分享服务');}
function quotaStatement(db,key,amount,limit) {
  return db.prepare('INSERT INTO quota_counters(key,used,max_count) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET used=quota_counters.used+excluded.used,max_count=excluded.max_count').bind(key,amount,limit);
}
async function ipKey(request) {
  // Cloudflare supplies this header; never accept the caller-controlled X-Forwarded-For.
  return sha256('buyer-share-ip:'+String(request.headers.get('CF-Connecting-IP')||'unknown'));
}
async function runBatch(db,statements) {
  try {
    const results=await db.batch(statements);
    if(results.some(result=>result.success===false))throw new Error('Database batch failed');
    return results;
  }catch(error){if(/RATE_LIMIT/.test(String(error?.message)))fail(429,'RATE_LIMIT','今日分享额度已用完，请稍后再试');throw error;}
}
async function issueWriter(request,env) {
  requireBindings(env);requireWriteOrigin(request,env);await readJson(request,4096);
  const cfg=settings(env),now=Date.now(),day=Math.floor(now/DAY),ip=await ipKey(request);
  const id=randomId(),secret=randomId(32),hash=await sha256(secret);
  await runBatch(env.DB,[
    quotaStatement(env.DB,'bootstrap-global:'+day,1,cfg.bootstrapGlobal),
    quotaStatement(env.DB,'bootstrap-ip:'+day+':'+ip,1,cfg.bootstrapIp),
    env.DB.prepare('INSERT INTO writers(id,secret_hash,created_at,disabled) VALUES(?,?,?,0)').bind(id,hash,now)
  ]);
  return json(request,env,{token:id+'.'+secret},201);
}
async function authenticateWriter(request,env) {
  const match=/^Bearer ([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization')||'');
  if(!match)fail(401,'WRITER_REQUIRED','请重新连接分享服务');
  const writer=await env.DB.prepare('SELECT id,secret_hash,disabled FROM writers WHERE id=?').bind(match[1]).first();
  if(!writer||writer.disabled||!equalHash(writer.secret_hash,await sha256(match[2])))fail(401,'WRITER_INVALID','分享身份已失效，请重新连接');
  return writer.id;
}
async function dataImage(source,cfg) {
  const match=/^data:(image\/(?:jpeg|png|webp|gif|avif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
  if(!match)fail(400,'IMAGE_DATA','图片内嵌数据格式不正确');
  if(match[2].length>Math.ceil(cfg.maxImageBytes/3)*4+4)fail(413,'IMAGE_TOO_LARGE','图片超过大小上限');
  let binary;try{binary=atob(match[2]);}catch{fail(400,'IMAGE_DATA','图片内嵌数据不完整');}
  const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
  if(bytes.length>cfg.maxImageBytes||!imageSignature(bytes,match[1]))fail(400,'IMAGE_TYPE','图片内容与格式不符');
  return {bytes,type:match[1]};
}
async function remoteImage(source,cfg,timeoutMs=12000,budget={count:0,max:24}) {
  let url=trustedImageUrl(source);const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    for(let redirects=0;redirects<=4;redirects++) {
      if(budget.count>=budget.max)fail(400,'IMAGE_FETCH_BUDGET','此次图片归档请求已达上限，请分批分享');
      budget.count++;
      const response=await fetch(url.href,{method:'GET',redirect:'manual',signal:controller.signal,headers:{Accept:'image/avif,image/webp,image/png,image/jpeg,image/gif'}});
      if([301,302,303,307,308].includes(response.status)) {
        await response.body?.cancel();const target=response.headers.get('Location');
        if(!target||redirects===4)fail(400,'IMAGE_REDIRECT','图片跳转过多或地址缺失');
        url=trustedImageUrl(new URL(target,url).href);continue;
      }
      if(!response.ok){await response.body?.cancel();fail(400,'IMAGE_HTTP','图片来源暂时无法访问');}
      const type=(response.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase();
      if(!IMAGE_TYPES.has(type)){await response.body?.cancel();fail(400,'IMAGE_TYPE','图片来源返回了非图片内容');}
      const length=Number(response.headers.get('Content-Length'));
      if(Number.isFinite(length)&&length>cfg.maxImageBytes){await response.body?.cancel();fail(413,'IMAGE_TOO_LARGE','图片超过大小上限');}
      const bytes=await readLimited(response.body,cfg.maxImageBytes,'图片超过大小上限');
      if(!bytes.length||!imageSignature(bytes,type))fail(400,'IMAGE_TYPE','图片内容与格式不符');
      return {bytes,type};
    }
    fail(400,'IMAGE_REDIRECT','图片跳转过多');
  }catch(error){if(error instanceof ShareError)throw error;fail(400,'IMAGE_NETWORK','图片下载超时或连接失败');}finally{clearTimeout(timer);}
}
async function archiveImages(products,cfg) {
  const bySource=new Map(),assets=new Map(),images=Array(products.length).fill(null),failures=[],started=Date.now(),fetchBudget={count:0,max:cfg.maxRemoteFetches};let total=0;
  // Sequential bounded downloads keep one request safely below Worker memory limits.
  for(let index=0;index<products.length;index++) {
    const source=products[index].model;if(!source.trim())continue;
    try {
      const cached=bySource.get(source);
      if(cached?.error)throw cached.error;
      if(!cached) {
        const remaining=cfg.maxArchiveMs-(Date.now()-started);
        if(remaining<=0)fail(400,'IMAGE_TIME_BUDGET','图片归档超时，本次保留文字内容');
        const image=source.startsWith('data:')?await dataImage(source,cfg):await remoteImage(source,cfg,Math.min(12000,remaining),fetchBudget);
        const hash=await sha256(image.bytes);
        if(!assets.has(hash)) {
          total+=image.bytes.length;if(total>cfg.maxAssetBytes)fail(413,'TOTAL_IMAGES_TOO_LARGE','此次分享图片总量过大，请减少产品数量');
          assets.set(hash,{...image,hash});
        }
        bySource.set(source,{hash});
      }
      images[index]=bySource.get(source).hash;
    }catch(error){
      if(error instanceof ShareError&&error.code==='TOTAL_IMAGES_TOO_LARGE')throw error;
      bySource.set(source,{error});
      failures.push({index,message:error instanceof ShareError?error.message:'图片未能保存'});
      // Repeated invalid sources are still explicit per-product failures.
    }
  }
  return {assets,images,failures,total,imagesArchived:images.filter(Boolean).length};
}
function safeHttp(value) {try{const url=new URL(value);return /^https?:$/.test(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}}
function field(label,value) {
  return '<div class="field"><b>'+escapeHtml(label)+'</b><span>'+escapeHtml(String(value??'').trim()?value:'未填写')+'</span></div>';
}
export function renderShareHtml(id,products,imageHashes,failures=[],basePath='') {
  const failed=new Map(failures.map(item=>[item.index,item.message]));
  const cards=products.map((p,index)=>{
    const image=imageHashes[index]?'<img loading="lazy" src="'+escapeHtml(basePath)+'/s/'+id+'/images/'+imageHashes[index]+'" alt="型号图片">':'<div class="empty">'+(failed.has(index)?'图片未能归档':'暂无图片')+'</div>';
    const badges=p.badges.map(b=>'<span class="badge">'+escapeHtml(b.icon)+' '+escapeHtml(b.text)+'</span>').join('');
    const shopee=safeHttp(p.shopeeUrl),link=p.shopee?(shopee?'<a href="'+escapeHtml(shopee)+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(p.shopee)+'</a>':escapeHtml(p.shopee)):'未填写';
    return '<article><header><span>产品 '+(index+1)+'</span><b>Model ID '+escapeHtml(p.id)+'</b></header>'+image+'<div class="caption"><span>model 图片（SKU图）</span><span>'+badges+'</span></div>'+field('中文标题',p.itemChinese)+field('中文型号',p.modelChinese)+field('上新类目',p.category)+field('目标价',p.target)+(p.invitation?field('邀请ID',p.invitation):'')+'<div class="field"><b>Shopee link</b><span>'+link+'</span></div>'+(failed.has(index)?'<p class="warning">'+escapeHtml(failed.get(index))+'</p>':'')+'</article>';
  }).join('');
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow,noarchive"><title>寻品产品分享 · '+products.length+' 个产品</title><style>*{box-sizing:border-box}body{margin:0;background:#f2f6f3;color:#203a2e;font:16px/1.55 system-ui,"Microsoft YaHei",sans-serif;padding:20px}main{max-width:1000px;margin:auto}h1{font-size:24px;margin:0}main>p{font-size:13px;color:#607269}article{padding:20px;margin:18px 0;background:white;border:1px solid #dce7df;border-radius:14px;break-inside:avoid}article header{display:flex;justify-content:space-between;gap:10px;overflow-wrap:anywhere}img,.empty{display:block;width:100%;height:340px;object-fit:contain;background:#f6f8f6;border-radius:8px;margin-top:10px}.empty{display:grid;place-items:center;color:#718078}.caption{display:flex;justify-content:space-between;gap:8px;align-items:center;margin:8px 0;font-size:12px;color:#607269}.badge{display:inline-block;margin-left:4px;border-radius:12px;background:#fff6d9;color:#80550a;padding:2px 7px}.field{display:grid;grid-template-columns:130px minmax(0,1fr);gap:12px;border-top:1px solid #edf1ee;padding:9px 0;overflow-wrap:anywhere;white-space:pre-wrap}.field b{color:#607269;font-weight:600}a{color:#167653}.warning{color:#875515;background:#fff6df;padding:8px;border-radius:6px;font-size:13px}@media(max-width:560px){body{padding:8px}article{padding:12px}.field{grid-template-columns:88px minmax(0,1fr);gap:8px}img,.empty{height:240px}h1{font-size:21px}article header{font-size:13px}}@media print{body{padding:0;background:white}article{box-shadow:none}}</style></head><body><main><h1>寻品产品信息</h1><p>'+products.length+' 个产品 · 生成时内容快照 · 已保存图片 '+imageHashes.filter(Boolean).length+' / '+products.filter(p=>p.model.trim()).length+' 张</p>'+cards+'<p>产品信息来自买手工作看板 · 此分享未设置到期时间</p></main></body></html>';
}
function resultFor(row,base) {
  let failures=[];try{failures=JSON.parse(row.failures_json);}catch{}
  return {id:row.id,url:base+'/s/'+row.id,persisted:true,imagesArchived:row.images_archived,imageFailures:failures,productCount:row.product_count};
}
async function existingResult(request,env,row,payloadHash,base) {
  if(row.payload_hash!==payloadHash)fail(409,'IDEMPOTENCY_CONFLICT','此生成编号已用于不同内容，请重新生成');
  if(row.status==='pending')fail(409,'SHARE_PENDING','这次分享仍在保存，请稍后重试');
  if(row.status!=='ready')fail(409,'SHARE_FAILED','上次保存没有完成，请重新生成');
  // Do not report a successfully persisted snapshot if its required HTML is absent.
  if(!await env.BUCKET.head(row.html_key))fail(503,'ARCHIVE_MISSING','分享文件暂时无法读取，请稍后重试');
  return json(request,env,resultFor(row,base));
}
async function createShare(request,env,ctx) {
  requireBindings(env);requireWriteOrigin(request,env);
  const writerId=await authenticateWriter(request,env),cfg=settings(env),body=await readJson(request,cfg.maxBodyBytes);
  if(!body||typeof body!=='object'||Array.isArray(body)||body.v!==1)fail(400,'INVALID_VERSION','分享数据版本不受支持');
  if(typeof body.requestId!=='string'||!/^[-_A-Za-z0-9]{8,80}$/.test(body.requestId))fail(400,'REQUEST_ID','缺少有效生成编号');
  const products=sanitizeProducts(body.products,cfg),payloadHash=await sha256(JSON.stringify({v:1,products})),base=publicBase(request,env);
  const findExisting=()=>env.DB.prepare('SELECT * FROM shares WHERE writer_id=? AND request_id=?').bind(writerId,body.requestId).first();
  const previous=await findExisting();if(previous)return existingResult(request,env,previous,payloadHash,base);
  const now=Date.now(),day=Math.floor(now/DAY),ip=await ipKey(request),id=randomId(),createdKeys=[];let published=false,reserved=false;
  try {
    try {
      await runBatch(env.DB,[
        quotaStatement(env.DB,'shares-global:'+day,1,cfg.shareGlobal),
        quotaStatement(env.DB,'shares-ip:'+day+':'+ip,1,cfg.shareIp),
        quotaStatement(env.DB,'shares-writer:'+day+':'+writerId,1,cfg.shareWriter),
        env.DB.prepare('INSERT INTO shares(id,writer_id,request_id,payload_hash,status,created_at,product_count) VALUES(?,?,?,?,\'pending\',?,?)').bind(id,writerId,body.requestId,payloadHash,now,products.length)
      ]);
      reserved=true;
    }catch(error){
      const race=await findExisting();
      if(race&&race.id===id&&race.status==='pending'&&race.payload_hash===payloadHash)reserved=true;
      else if(race)return existingResult(request,env,race,payloadHash,base);
      else throw error;
    }
    const archived=await archiveImages(products,cfg),html=renderShareHtml(id,products,archived.images,archived.failures,new URL(base).pathname.replace(/\/$/,''));
    const manifest=JSON.stringify({v:1,id,createdAt:now,products,images:archived.images,imageFailures:archived.failures});
    const htmlKey='shares/'+id+'/index.html',manifestKey='shares/'+id+'/manifest.json';
    const storageBytes=archived.total+new TextEncoder().encode(html).length+new TextEncoder().encode(manifest).length;
    try {
      await runBatch(env.DB,[
        quotaStatement(env.DB,'bytes-global:'+day,storageBytes,cfg.bytesGlobal),
        quotaStatement(env.DB,'bytes-total',storageBytes,cfg.bytesTotal)
      ]);
    }catch(error){if(error instanceof ShareError&&error.code==='RATE_LIMIT')fail(429,'STORAGE_LIMIT','分享存储容量已达上限，已有分享仍可查看，请联系管理员调整');throw error;}
    for(const image of archived.assets.values()) {
      const key='shares/'+id+'/images/'+image.hash;createdKeys.push(key);
      await env.BUCKET.put(key,image.bytes,{httpMetadata:{contentType:image.type},customMetadata:{shareId:id}});
    }
    createdKeys.push(manifestKey);await env.BUCKET.put(manifestKey,manifest,{httpMetadata:{contentType:'application/json;charset=UTF-8'}});
    createdKeys.push(htmlKey);await env.BUCKET.put(htmlKey,html,{httpMetadata:{contentType:'text/html;charset=UTF-8'}});
    if(!await env.BUCKET.head(htmlKey))fail(503,'PERSISTENCE_FAILED','分享文件保存后无法读取，请重试');
    const commit=await env.DB.prepare('UPDATE shares SET status=\'ready\',html_key=?,images_archived=?,failures_json=? WHERE id=? AND status=\'pending\'').bind(htmlKey,archived.imagesArchived,JSON.stringify(archived.failures),id).run();
    if(commit.success===false||commit.meta?.changes!==1)fail(503,'PERSISTENCE_FAILED','分享记录没有提交完成，请重新生成');
    published=true;
    return json(request,env,{id,url:base+'/s/'+id,persisted:true,imagesArchived:archived.imagesArchived,imageFailures:archived.failures,productCount:products.length},201);
  }catch(error){
    if(!published&&reserved) {
      // A D1 write may have committed even when its acknowledgement was lost.
      // Never infer failed publication from a thrown promise and delete a ready snapshot.
      try{await env.DB.prepare('UPDATE shares SET status=\'failed\' WHERE id=? AND status=\'pending\'').bind(id).run();}catch{}
      let confirmed=null;try{confirmed=await env.DB.prepare('SELECT * FROM shares WHERE id=?').bind(id).first();}catch{}
      if(confirmed?.status==='ready')return existingResult(request,env,confirmed,payloadHash,base);
      if(confirmed?.status==='failed'&&confirmed.writer_id===writerId&&confirmed.request_id===body.requestId&&confirmed.payload_hash===payloadHash) {
        const cleanup=async()=>{for(const key of createdKeys){try{await env.BUCKET.delete(key);}catch{}}};
        if(ctx?.waitUntil)ctx.waitUntil(cleanup());else await cleanup();
      }
    }
    throw error;
  }
}
function htmlHeaders(request,env) {
  return headersFor(request,env,{
    'Content-Type':'text/html;charset=UTF-8','Cache-Control':'public,max-age=300',
    'Content-Security-Policy':"default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    'X-Robots-Tag':'noindex, nofollow, noarchive'
  });
}
async function readShare(request,env,id,imageHash) {
  requireBindings(env);
  const row=await env.DB.prepare('SELECT id,status,html_key FROM shares WHERE id=?').bind(id).first();
  if(!row||row.status!=='ready')fail(404,'SHARE_NOT_FOUND','找不到这个分享，请检查网址是否完整');
  const key=imageHash?'shares/'+id+'/images/'+imageHash:row.html_key;
  const object=await env.BUCKET.get(key);
  if(!object)fail(imageHash?404:503,'ARCHIVE_MISSING',imageHash?'这张图片暂时无法读取':'分享内容暂时无法读取，请稍后刷新');
  const headers=imageHash?headersFor(request,env,{'Content-Type':IMAGE_TYPES.has(object.httpMetadata?.contentType)?object.httpMetadata.contentType:'application/octet-stream','Cache-Control':'public,max-age=31536000,immutable'}):htmlHeaders(request,env);
  if(object.httpEtag)headers.set('ETag',object.httpEtag);
  return new Response(request.method==='HEAD'?null:object.body,{status:200,headers});
}
function errorPage(message) {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>分享暂时无法打开</title><body style="font:16px/1.6 system-ui;padding:24px;color:#203a2e"><h1>分享暂时无法打开</h1><p>'+escapeHtml(message)+'</p><p>请确认网址完整后重新打开，或联系分享者。</p></body></html>';
}
export default {
  async fetch(request,env,ctx) {
    const url=new URL(request.url);let path=url.pathname;
    try {
      if(env.PUBLIC_BASE_URL){const basePath=new URL(env.PUBLIC_BASE_URL).pathname.replace(/\/$/,'');if(basePath&&path.startsWith(basePath+'/'))path=path.slice(basePath.length);}
      if(request.method==='OPTIONS') {
        requireWriteOrigin(request,env);
        return new Response(null,{status:204,headers:headersFor(request,env,{'Access-Control-Allow-Methods':'GET,HEAD,POST,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type','Access-Control-Max-Age':'3600'})});
      }
      if(path==='/api/writers'&&request.method==='POST')return await issueWriter(request,env);
      if(path==='/api/shares'&&request.method==='POST')return await createShare(request,env,ctx);
      const match=/^\/s\/([A-Za-z0-9_-]{22})(?:\/images\/([a-f0-9]{64}))?$/.exec(path);
      if(match&&(request.method==='GET'||request.method==='HEAD'))return await readShare(request,env,match[1],match[2]);
      if(path==='/health'&&(request.method==='GET'||request.method==='HEAD')) {
        requireBindings(env);return json(request,env,{ok:true,storage:'configured'});
      }
      if(path==='/'&&request.method==='GET')return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>寻品产品分享</title><h1>寻品产品分享</h1><p>请打开买手提供的产品分享网址。</p></html>',{headers:htmlHeaders(request,env)});
      if(path.startsWith('/s/')&&(request.method==='GET'||request.method==='HEAD'))fail(404,'SHARE_NOT_FOUND','找不到这个分享，请检查网址是否完整');
      if(path==='/api/writers'||path==='/api/shares'||path.startsWith('/s/'))fail(405,'METHOD_NOT_ALLOWED','此请求方式不受支持');
      fail(404,'NOT_FOUND','找不到这个页面');
    }catch(error) {
      const known=error instanceof ShareError,status=known?error.status:503;
      const message=known?error.message:'分享服务暂时无法完成请求，请稍后重试';
      if(path.startsWith('/s/')&&!path.includes('/images/'))return new Response(request.method==='HEAD'?null:errorPage(message),{status,headers:headersFor(request,env,{'Content-Type':'text/html;charset=UTF-8'})});
      return json(request,env,{error:{code:known?error.code:'SERVICE_UNAVAILABLE',message}},status,status===429?{'Retry-After':'3600'}:{});
    }
  }
};
