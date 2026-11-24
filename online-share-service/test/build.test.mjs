import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildFunctions} from '../scripts/build.mjs';

test('bundled functions load with route metadata when deployed without node_modules', async () => {
  const metadata = await buildFunctions();
  assert.equal(Object.keys(metadata.outputs).length, 2);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'buyer-share-build-'));
  for (const [name, route] of [['publish-share', '/api/shares'], ['read-share', '/api/shares/:id']]) {
    const source = new URL('../dist/functions/' + name + '.mjs', import.meta.url);
    const target = path.join(directory, name + '.mjs');
    await fs.copyFile(source, target);
    const module = await import(pathToFileURL(target).href);
    assert.equal(typeof module.default, 'function');
    assert.equal(module.config.path, route);
    assert.ok(module.config.rateLimit.windowLimit > 0);
    const response = await module.default(new Request('https://example.netlify.app/api/shares/invalid'));
    assert.ok(response.status === 404 || response.status === 405);
    await fs.unlink(target);
  }
  await fs.rmdir(directory);
});
