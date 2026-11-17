'use strict';

// Fabricated SKUs only. No customer data, network requests or image downloads.
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');

const headers = ['Model ID', 'Item Name', 'Model Name', 'Category', 'Target Price', 'Currency', 'Notes', 'Invitation ID', 'Image URL', 'Brand', 'Vietnamese Title', 'Thai Title', 'Source', 'Blank'];
const quote = value => /[",\r\n\t;]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;

function expectedRow(index) {
  const id = (900719925474099312345n + BigInt(index)).toString();
  const title = 'Synthetic SKU ' + index + ' · 便携式无线耳机与收纳盒 😀 𠀀 · ' +
    'Long fabricated product title with USB-C, 5V/2A, size 120 × 80 mm; quoted "edition A". '.repeat(5);
  return [id, title, 'MODEL-FAKE-' + String(index).padStart(6, '0'), 'Audio / 配件', '1,299.90', 'USD',
    index % 3 === 0 ? 'First line, "quoted"\r\n第二行\nThird line\tend' : 'Plain fabricated note ' + index,
    '0000' + String(index).padStart(8, '0'), 'https://fixture.invalid/image/' + index + '.png',
    'FICTIONAL', 'Tai nghe không dây mẫu thử ' + index, 'หูฟังตัวอย่าง ' + index, 'fixture-only', ''];
}

function* fixtureChunks(rowCount, delimiter = ',') {
  yield '\ufeff' + headers.map(quote).join(delimiter) + '\r\n';
  for (let i = 0; i < rowCount; i++) yield expectedRow(i).map(quote).join(delimiter) + '\r\n';
}

async function writeFixture(destination, rowCount) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const output = fs.createWriteStream(destination);
  for (const line of fixtureChunks(rowCount)) if (!output.write(line)) await once(output, 'drain');
  output.end();
  await once(output, 'finish');
  return fs.statSync(destination).size;
}

if (require.main === module) {
  const rowCount = Number(process.argv[2] || 20000);
  if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount > 1000000) throw new Error('Use a row count between 1 and 1000000');
  const destination = path.resolve(process.argv[3] || path.join(__dirname, '../artifacts/synthetic-' + rowCount + '-sku.csv'));
  writeFixture(destination, rowCount).then(bytes => console.log(JSON.stringify({ destination, rowCount, bytes, synthetic: true }))).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { headers, expectedRow, fixtureChunks, writeFixture };
