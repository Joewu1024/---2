'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const functionStart = html.search(/async function regroup\(\)\s*\{/);
const functionEnd = html.indexOf('async function prepareImageHashes(', functionStart);
const helperStart = html.indexOf('function textTokens('), helperEnd = html.indexOf('function escapeRe(', helperStart);
assert.ok(functionStart >= 0 && functionEnd > functionStart, 'Find the actual regroup function in index.html');
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'Find the actual similarity helpers in index.html');
const implementation = html.slice(functionStart, functionEnd);
const helpers = html.slice(helperStart, helperEnd);
const nameHelpers = html.slice(html.indexOf('// product-group-names:start'), html.indexOf('// product-group-names:end'));
// Fabricated local records only. This evaluates the shipped index.html function,
// not a parallel implementation. No browser, network, images or account data.
globalThis.fetch = () => { throw new Error('Network access is forbidden in grouping checks'); };
function make(records, overrides = {}) {
  const context = {
    rows: records, activeHashRun: 1, threshold: 90, groupingEnabled: true,
    location: { href: 'https://fictional.invalid/' }, URL,
    $: () => ({ textContent: '' }),
    number: value => Number.isFinite(Number(value)) ? Number(value) : null,
    calc: record => record.price,
    getRaw: (record, names) => { for (const name of names) if (record.raw && record.raw[name] !== undefined) return record.raw[name]; return ''; },
    setTimeout, ...overrides
  };
  vm.createContext(context);
  vm.runInContext(helpers + '\n' + nameHelpers + '\n' + implementation, context);
  if (overrides.similarProduct) context.similarProduct = overrides.similarProduct;
  return context;
}
const row = (id, title = 'Portable audio model', image = 'https://fictional.invalid/' + id + '.jpg') => ({ uid: id, price: 100000 - Number(id.replace(/\D/g, '') || 0), main: image, hash: '', group: 'OLD-' + id, raw: { item_name: title } });

(async () => {
  const basic = [row('1'), row('2'), row('3', 'Unrelated garden shovel', 'https://fictional.invalid/1.jpg'), row('4'), row('5')];
  basic[1].main = basic[0].main;
  basic[3].manualGroup = 'MANUAL';
  basic[4].main = basic[3].main;
  const context = make(basic);
  assert.equal(await context.regroup(), true);
  assert.equal(basic[0].group, basic[1].group);
  assert.notEqual(basic[0].group, basic[2].group);
  assert.equal(basic[3].group, 'MANUAL');
  assert.notEqual(basic[4].group, 'MANUAL');

  // Positive near-hash recall: different image URLs, one flipped hash bit and
  // identical product titles must still group through rare hash bands.
  const nearHash = [row('101', 'Portable wireless headphone charging case'), row('102', 'Portable wireless headphone charging case'), row('103', 'Garden shovel steel spade')];
  const center = '10100101'.repeat(8), full = '11001010'.repeat(8);
  nearHash[0].hash = center + '|' + full;
  nearHash[1].hash = (center[0] === '1' ? '0' : '1') + center.slice(1) + '|' + full;
  nearHash[2].hash = nearHash[0].hash;
  const hashContext = make(nearHash);
  assert.equal(hashContext.similarProduct(nearHash[0], nearHash[1]), true);
  assert.equal(hashContext.similarProduct(nearHash[0], nearHash[2]), false);
  assert.equal(await hashContext.regroup(), true);
  assert.equal(nearHash[0].group, nearHash[1].group);
  assert.notEqual(nearHash[0].group, nearHash[2].group);

  // Positive small-token-bucket recall at the existing permissive threshold.
  const titleOnly = [row('201', 'Portable cotton canvas travel bag'), row('202', 'Cotton canvas travel bag shoulder strap'), row('203', 'Digital kitchen thermometer probe')];
  const tokenContext = make(titleOnly, { threshold: 30 });
  assert.equal(tokenContext.similarProduct(titleOnly[0], titleOnly[1]), true);
  assert.equal(await tokenContext.regroup(), true);
  assert.equal(titleOnly[0].group, titleOnly[1].group);
  assert.notEqual(titleOnly[0].group, titleOnly[2].group);
  const strictTitleOnly = [row('301', 'Portable cotton canvas travel bag'), row('302', 'Cotton canvas travel bag shoulder strap')];
  const strictContext = make(strictTitleOnly, { threshold: 90 });
  assert.equal(await strictContext.regroup(), true);
  assert.notEqual(strictTitleOnly[0].group, strictTitleOnly[1].group);

  const chain = [row('a'), row('b'), row('c')];
  chain.forEach(record => { record.main = 'https://fictional.invalid/placeholder.jpg'; });
  const chainContext = make(chain, { similarProduct: (a, b) => a.uid + b.uid === 'ab' || a.uid + b.uid === 'bc' });
  await chainContext.regroup();
  assert.equal(chain[0].group, chain[1].group);
  assert.notEqual(chain[0].group, chain[2].group);

  let maximum = 0;
  const comparisons = new Map();
  const crowded = Array.from({ length: 500 }, (_, index) => row(String(index)));
  crowded.forEach(record => { record.main = 'https://fictional.invalid/same-placeholder.jpg'; });
  const bounded = make(crowded, { similarProduct: (a, b) => { const count = (comparisons.get(b.uid) || 0) + 1; comparisons.set(b.uid, count); maximum = Math.max(maximum, count); return false; } });
  assert.equal(await bounded.regroup(), true);
  assert.equal(maximum, 128);
  assert.equal(new Set(crowded.map(record => record.group)).size, 500);

  // Cancel in the first preparation yield and in the first grouping yield.
  for (const cancelAt of [1, 3]) {
    const records = Array.from({ length: 200 }, (_, index) => row(String(index)));
    let yields = 0, cancellationContext;
    cancellationContext = make(records, { setTimeout: resolve => setTimeout(() => { if (++yields === cancelAt) cancellationContext.activeHashRun++; resolve(); }, 0) });
    assert.equal(await cancellationContext.regroup(), false);
    records.forEach(record => assert.equal(record.group, 'OLD-' + record.uid));
  }
  const changing = Array.from({ length: 200 }, (_, index) => row(String(index)));
  let changed = false;
  const manualContext = make(changing, { setTimeout: resolve => setTimeout(() => { if (!changed) { changing[0].manualGroup = 'NEW-MANUAL'; changed = true; } resolve(); }, 0) });
  assert.equal(await manualContext.regroup(), false);
  changing.forEach(record => assert.equal(record.group, 'OLD-' + record.uid));
  assert.equal(changing[0].manualGroup, 'NEW-MANUAL');

  const flat = [row('1'), row('2')]; flat[1].manualGroup = 'MANUAL';
  const flatContext = make(flat, { groupingEnabled: false });
  assert.equal(await flatContext.regroup(), true);
  assert.equal(flat[0].group, 'UNGROUPED-1');
  assert.equal(flat[1].group, 'MANUAL');

  // Pathological shared image hashes and generic tokens must not create a
  // quadratic candidate set. Unique URLs prevent the exact-image fast path.
  const large = Array.from({ length: 20000 }, (_, index) => row(String(index), 'Portable Bluetooth audio product'));
  large.forEach(record => { record.hash = '0'.repeat(64) + '|' + '0'.repeat(64); });
  let checks = 0, ticks = 0;
  const largeContext = make(large, { similarProduct: () => { checks++; return false; } });
  const timer = setInterval(() => ticks++, 10), started = performance.now();
  try { assert.equal(await largeContext.regroup(), true); } finally { clearInterval(timer); }
  assert.equal(checks, 0);
  assert.equal(new Set(large.map(record => record.group)).size, 20000);
  assert.ok(ticks > 0);
  const report = {
    generatedAt: new Date().toISOString(), runtime: process.version, platform: process.platform + '/' + process.arch,
    cpu: os.cpus()[0].model, synthetic: true, networkRequests: 0,
    source: { file: 'index.html', function: 'regroup', sha256: crypto.createHash('sha256').update(implementation).digest('hex') },
    rows: large.length, milliseconds: +(performance.now() - started).toFixed(1),
    comparisonsForCommonHashAndTokenFixture: checks, maximumComparisonsPerRowInCrowdedExactImageFixture: maximum,
    heartbeatTicks: ticks, cancellationAtomicity: true, manualGroupPreserved: true, chainMergeRejected: true,
    positiveMerges: { exactImage: true, nearHashAndSameTitle: true, smallTokenBucketAt30Percent: true },
    negativeCases: { unrelatedTitleAt90Percent: true, titleOnlyAt90Percent: true, chainedSimilarity: true },
    scope: 'Node execution of the actual regroup function and similarity helpers extracted from index.html. Normal positive/negative grouping uses the shipped similarity logic; controlled similarProduct stubs measure worst-case candidate bounds. Not browser FPS, DOM rendering, image preparation, or end-to-end grouping measurements.'
  };
  const destination = path.join(__dirname, '../artifacts/large-grouping-node-report.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
