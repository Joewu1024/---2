#!/usr/bin/env node
'use strict';

// Archive an already-public product share without publishing its payload token.
// Usage: node scripts/archive-share.cjs --target-file PRIVATE_FILE --out p/ID --backup PRIVATE_HTML
const fs=require('node:fs');
const path=require('node:path');
const https=require('node:https');
const dns=require('node:dns').promises;
const net=require('node:net');
const zlib=require('node:zlib');
const vm=require('node:vm');

const MAX_IMAGE_BYTES=8*1024*1024;
const IMAGE_HOSTS=new Set(['cf.shopee.com.my','cf.shopee.vn','cf.shopee.com.br','cf.shopee.ph']);
const IMAGE_TYPES=new Map([['image/jpeg','jpg'],['image/png','png'],['image/webp','webp'],['image/gif','gif'],['image/avif','avif'],['image/bmp','bmp']]);

function publicAddress(address){
  if(net.isIP(address)===4){
    const [a,b,c]=address.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0))||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
  }
  return net.isIP(address)===6&&/^[23]/i.test(address)&&!/^2001:db8:/i.test(address);
}

function imageSignature(bytes,type){
  if(type==='image/jpeg')return bytes.subarray(0,3).equals(Buffer.from([255,216,255]));
  if(type==='image/png')return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(type==='image/webp')return bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  if(type==='image/gif')return /^GIF8[79]a$/.test(bytes.toString('ascii',0,6));
  if(type==='image/avif')return bytes.toString('ascii',4,8)==='ftyp'&&/avif|avis/.test(bytes.toString('ascii',8,32));
  return type==='image/bmp'&&bytes.toString('ascii',0,2)==='BM';
}

async function downloadImage(source,redirects=0){
  let url;
  try{url=new URL(source)}catch{throw new Error('Invalid image URL')}
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!IMAGE_HOSTS.has(url.hostname))throw new Error('Image host is not an allowed HTTPS CDN');
  const addresses=await dns.lookup(url.hostname,{all:true,verbatim:true});
  if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw new Error('Image host did not resolve exclusively to public addresses');
  const chosen=addresses.find(item=>item.family===4)||addresses[0];
  return new Promise((resolve,reject)=>{
    const request=https.get(url,{
      headers:{'User-Agent':'Mozilla/5.0','Accept':'image/avif,image/webp,image/png,image/jpeg,image/gif,image/bmp'},
      lookup:(_host,options,callback)=>options.all?callback(null,[chosen]):callback(null,chosen.address,chosen.family)
    },response=>{
      if([301,302,303,307,308].includes(response.statusCode)){
        response.resume();
        if(redirects>=4||!response.headers.location){reject(new Error('Image redirect limit or missing target'));return}
        let next;try{next=new URL(response.headers.location,url).href}catch{reject(new Error('Invalid image redirect'));return}
        downloadImage(next,redirects+1).then(resolve,reject);return;
      }
      if(response.statusCode!==200){response.resume();reject(new Error('Image HTTP '+response.statusCode));return}
      const type=String(response.headers['content-type']||'').split(';')[0].trim().toLowerCase();
      if(!IMAGE_TYPES.has(type)){request.destroy();reject(new Error('Image response has an unsupported content type'));return}
      const declared=Number(response.headers['content-length']);
      if(Number.isFinite(declared)&&declared>MAX_IMAGE_BYTES){request.destroy();reject(new Error('Image exceeds 8 MB'));return}
      const chunks=[];let length=0;
      response.on('data',chunk=>{length+=chunk.length;if(length>MAX_IMAGE_BYTES){request.destroy();reject(new Error('Image exceeds 8 MB'))}else chunks.push(chunk)});
      response.on('error',()=>reject(new Error('Image response stream failed')));
      response.on('end',()=>{
        const bytes=Buffer.concat(chunks);
        if(!bytes.length||!imageSignature(bytes,type)){reject(new Error('Image signature does not match its content type'));return}
        resolve({bytes,type,extension:IMAGE_TYPES.get(type)});
      });
    });
    request.setTimeout(20000,()=>request.destroy(new Error('Image request timed out')));
    request.on('error',error=>reject(new Error(error.message==='Image request timed out'?error.message:'Image network error '+(error.code||'unknown'))));
  });
}

function selectedProduct(product){
  const clean={};
  for(const key of ['id','itemChinese','modelChinese','target','category','invitation','shopee','shopeeUrl'])clean[key]=String(product[key]??'');
  clean.badges=Array.isArray(product.badges)?product.badges.map(item=>({kind:String(item.kind??''),icon:String(item.icon??''),text:String(item.text??'')})):[];
  return clean;
}

function pageFor(products,assets,shareHtml,offline){
  const renderer=[...shareHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].find(match=>match[1].includes('function card(p,i)'))?.[1];
  const script=renderer?.split('async function load()')[0];
  if(!script)throw new Error('Could not locate the existing share card renderer');
  const context={URL};vm.runInNewContext(script,context,{timeout:1000});
  const images=assets.map(asset=>asset.ok?(offline?'data:'+asset.type+';base64,'+asset.bytes.toString('base64'):asset.file):'');
  const permitted=new Set(images.filter(Boolean));context.imageUrl=value=>permitted.has(String(value))?String(value):'';
  const escape=context.e;
  const cards=products.map((product,index)=>context.card({...selectedProduct(product),model:images[index]},index)+(assets[index].ok?'':'<p class="archive-warning">产品 '+(index+1)+' 的型号图片未能归档：'+escape(assets[index].error)+'。其他已分享字段完整保留。</p>')).join('');
  const styles=[...shareHtml.matchAll(/<style>([\s\S]*?)<\/style>/gi)].map(match=>match[1]).join('\n');
  const saved=assets.filter(asset=>asset.ok).length;
  const download=offline?'':'<a class="archive-download" href="offline.html" download>下载离线备份</a>';
  return '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow,noarchive"><title>寻品产品静态分享 · '+products.length+' 个产品</title><style>'+styles+'\n.archive-warning{padding:12px;background:#fff2da;border:1px solid #e5c68c;border-radius:8px;color:#81501c}.archive-status{font-size:12px;color:#607269}.archive-download{flex:none;border:1px solid #cbded2;border-radius:8px;background:#fff;padding:8px 12px;color:#285844;font-size:12px;font-weight:650;text-decoration:none}</style></head><body><main class="page"><header class="head"><div><h1>寻品产品信息</h1><p>'+products.length+' 个产品 · 已分享内容静态快照</p><p class="archive-status">型号图片已归档 '+saved+' / '+products.length+' 张 · 无需登录或 JavaScript · 可使用浏览器打印 / 保存 PDF</p></div>'+download+'</header><div id="cards">'+cards+'</div><div class="footer">产品信息来自买手工作看板 · 本页只保留此次已选产品的分享字段</div></main></body></html>\n';
}

async function main(){
  const options={};for(let i=2;i<process.argv.length;i+=2)options[process.argv[i]]=process.argv[i+1];
  if(!options['--target-file']||!options['--out']||!options['--backup'])throw new Error('Required arguments: --target-file PRIVATE_FILE --out DIRECTORY --backup PRIVATE_HTML');
  const url=new URL(fs.readFileSync(options['--target-file'],'utf8').trim());
  if(url.origin!=='https://joewu1024.github.io'||url.pathname!=='/---2/share.html')throw new Error('Input is not an expected public share viewer URL');
  const token=url.searchParams.get('v')||(url.hash.startsWith('#d=')?url.hash.slice(3):'');
  if(!/^[zj][A-Za-z0-9_-]+$/.test(token))throw new Error('Unsupported share token');
  const encoded=Buffer.from(token.slice(1),'base64url');
  const decoded=token[0]==='z'?zlib.gunzipSync(encoded,{maxOutputLength:16*1024*1024}):encoded;
  const data=JSON.parse(decoded.toString('utf8')),products=Array.isArray(data.products)?data.products:[];
  if(products.length!==8)throw new Error('This recovery archive must contain exactly the eight already-shared products');
  const output=path.resolve(options['--out']),backup=path.resolve(options['--backup']);
  fs.mkdirSync(path.join(output,'assets'),{recursive:true});
  const assets=Array(products.length);let next=0;
  await Promise.all(Array.from({length:3},async()=>{
    while(next<products.length){
      const index=next++;
      try{
        const asset=await downloadImage(String(products[index].model||''));
        asset.ok=true;asset.file='assets/model-'+String(index+1).padStart(2,'0')+'.'+asset.extension;
        fs.writeFileSync(path.join(output,asset.file),asset.bytes);assets[index]=asset;
      }catch(error){assets[index]={ok:false,error:error.message}}
    }
  }));
  const shareHtml=fs.readFileSync(path.join(__dirname,'..','share.html'),'utf8');
  const html=pageFor(products,assets,shareHtml,false),standalone=pageFor(products,assets,shareHtml,true);
  if(/<script\b|\son[a-z]+\s*=/i.test(html+standalone))throw new Error('The archive must not contain JavaScript');
  fs.writeFileSync(path.join(output,'index.html'),html,'utf8');
  fs.writeFileSync(path.join(output,'offline.html'),standalone,'utf8');
  fs.mkdirSync(path.dirname(backup),{recursive:true});fs.writeFileSync(backup,standalone,'utf8');
  const status={productCount:products.length,imageCount:assets.filter(asset=>asset.ok).length,failedImageCount:assets.filter(asset=>!asset.ok).length,imageBytes:assets.reduce((sum,asset)=>sum+(asset.bytes?.length||0),0),htmlBytes:Buffer.byteLength(html),offlineHtmlBytes:Buffer.byteLength(standalone),assets:assets.map((asset,index)=>asset.ok?{index:index+1,file:asset.file,bytes:asset.bytes.length,type:asset.type}:{index:index+1,error:asset.error})};
  fs.writeFileSync(path.join(output,'archive-status.json'),JSON.stringify(status,null,2)+'\n');
  console.log(JSON.stringify(status));
}

if(require.main===module)main().catch(error=>{console.error(JSON.stringify({error:error.message}));process.exitCode=1});
module.exports={publicAddress,imageSignature,downloadImage,selectedProduct,pageFor};
