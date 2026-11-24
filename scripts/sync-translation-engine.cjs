const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),file=path.join(root,'index.html');
let html=fs.readFileSync(file,'utf8');
const engine=fs.readFileSync(path.join(root,'translation-engine.js'),'utf8');
const pattern=/<script data-buyer-translation-engine="v3">[\s\S]*?<\/script>/;
if(!pattern.test(html))throw Error('Embedded translation engine missing');
html=html.replace(pattern,()=>'<script data-buyer-translation-engine="v3">\n'+engine+'\n</script>');
const provider=fs.readFileSync(path.join(root,'translation-google-provider.js'),'utf8');
const providerPattern=/<script data-buyer-google-provider="v4">[\s\S]*?<\/script>/;
const providerScript='<script data-buyer-google-provider="v4">\n'+provider+'\n</script>\n';
if(providerPattern.test(html))html=html.replace(providerPattern,()=>providerScript.trimEnd());
else {
  const app=/<script>\s*\(function\(\)\{/;
  if(!app.test(html))throw Error('Workbench script missing');
  html=html.replace(app,match=>providerScript+match);
}
for(const [marker,name] of [['buyer-workspace','workbench-workspace.js'],['workbench-import','workbench-import.js'],['workbench-xlsx','workbench-xlsx.js'],['workbench-export','workbench-export.js'],['buyer-chrome-translation','translation-chrome-provider.js'],['workbench-translation-tasks','workbench-translation-tasks.js'],['buyer-reference-translation','translation-reference-provider.js'],['buyer-category-translations','category-translations.js']]){
  const body=fs.readFileSync(path.join(root,name),'utf8');
  const re=new RegExp('<script data-'+marker+'="v1">[\\s\\S]*?<\\/script>');
  const block='<script data-'+marker+'="v1">\n'+body+'\n</script>\n';
  if(re.test(html))html=html.replace(re,()=>block.trimEnd());
  else html=html.replace(/<script>\s*\(function\(\)\{/,match=>block+match);
}
const viewerFile=path.join(root,'share.html');
let viewer=fs.readFileSync(viewerFile,'utf8');
const githubShareTag=/<script data-buyer-github-share="v1">[\s\S]*?<\/script>/;
const gzipTag=/<script data-buyer-share-gzip="fflate-0\.8\.3">[\s\S]*?<\/script>/;
const codecTag=/<script data-buyer-share-codec="v1">[\s\S]*?<\/script>/;
const githubShare='<script data-buyer-github-share="v1">\n'+fs.readFileSync(path.join(root,'github-share.js'),'utf8')+'</script>';
const codec='<script data-buyer-share-codec="v1">\n'+fs.readFileSync(path.join(root,'product-share-codec.js'),'utf8')+'</script>';
const gzip=viewer.match(gzipTag)?.[0];
if(!gzip||!githubShareTag.test(viewer))throw Error('Embedded share reader missing');
viewer=viewer.replace(githubShareTag,()=>githubShare);
if(codecTag.test(viewer))viewer=viewer.replace(codecTag,()=>codec);
else viewer=viewer.replace(githubShareTag,match=>match+'\n'+codec);
for(const tag of [githubShareTag,gzipTag,codecTag])html=html.replace(new RegExp(tag.source+'\\r?\\n?'),'');
html=html.replace(/<script>\s*\(function\(\)\{/,match=>gzip+'\n'+codec+'\n'+match);
for(const match of viewer.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(match[1],{filename:'share-viewer'});
let count=0;for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(match[1],{filename:'index-script-'+(++count)});
fs.writeFileSync(file,html);
fs.writeFileSync(viewerFile,viewer);
console.log('Translation engine synchronized; '+count+' script blocks parsed');
