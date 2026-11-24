import {build} from 'esbuild';
import {builtinModules} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));

export async function buildFunctions() {
  const result = await build({
    absWorkingDir:root,
    entryPoints:[
      'netlify/functions/publish-share.mjs',
      'netlify/functions/read-share.mjs'
    ],
    outdir:'dist/functions',
    outExtension:{'.js':'.mjs'},
    bundle:true,
    packages:'bundle',
    platform:'node',
    format:'esm',
    target:'node22',
    metafile:true,
    sourcemap:false,
    legalComments:'inline',
    banner:{
      js:"import { createRequire as __buyerCreateRequire } from 'node:module';\nconst require = __buyerCreateRequire(import.meta.url);"
    },
    logLevel:'warning'
  });
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      const name = dependency.path.replace(/^node:/, '');
      if (dependency.external && !builtins.has(name)) {
        throw new Error('Function build left an external package: ' + dependency.path);
      }
    }
  }
  return result.metafile;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildFunctions().then(() => {
    console.log('Built two self-contained share functions');
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
