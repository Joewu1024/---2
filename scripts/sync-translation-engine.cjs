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
let count=0;for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(match[1],{filename:'index-script-'+(++count)});
fs.writeFileSync(file,html);
console.log('Translation engine synchronized; '+count+' script blocks parsed');
