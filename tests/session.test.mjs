import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveBatch, openBatch } from '../src/session.js';
import { zipSync, unzipSync, strFromU8, strToU8 } from '../src/vendor/fflate.js';

const options = { language: 'zh', theme: 'dark', numeric: false, deduplicate: true, selected: 1 };
const sample = (id, status = 'parsed') => ({ id, name: `sample-${id}.pdf`, status,
  file: new File(['%PDF-1.7\nOriginal synthetic bytes\n'], `sample-${id}.pdf`, { type: 'text/html' }),
  headers: status === 'parsed' ? ['Date','Description','Amount'] : [],
  rows: status === 'parsed' ? [{ Date:'01/02/2026', Description:'=1+1 <literal>', Amount:'0.09' }] : [],
  reviewed: status === 'parsed', currency:'USD', edits:1 });
const digest = async b => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(x=>x.toString(16).padStart(2,'0')).join('');
async function altered(bytes, mutate) {
  const entries=unzipSync(bytes), metadata=JSON.parse(strFromU8(entries['batch.json']));
  mutate(metadata,entries); entries['batch.json']=strToU8(JSON.stringify(metadata));
  entries['batch.sha256']=strToU8(await digest(entries['batch.json']));return zipSync(entries);
}
test('self-contained source bytes, edits, review and preferences survive a saved batch', async()=>{
  const original=[sample(1),sample(2,'canceled')];
  const bytes=await saveBatch(original,options);const restored=await openBatch(bytes);
  assert.deepEqual(restored.options,options);assert.deepEqual(restored.files[0].rows,original[0].rows);
  assert.equal(restored.files[0].reviewed,true);assert.equal(restored.files[1].status,'canceled');
  assert.equal(await restored.files[0].file.text(),await original[0].file.text());
  assert.equal(restored.files[0].file.type,'application/pdf');
});
test('pending work remains pending, exact duplicates keep their references',async()=>{
  const list=[sample(1),sample(2,'duplicate'),sample(3,'processing')];list[1].duplicateOf=1;
  const restored=await openBatch(await saveBatch(list,options));
  assert.equal(restored.files[1].duplicateOf,1);assert.equal(restored.files[2].status,'queued');
});
test('changed sources or metadata fail integrity checks instead of restoring partial data',async()=>{
  const bytes=await saveBatch([sample(1)],options), entries=unzipSync(bytes);
  entries['files/1.bin'][0]^=1;
  await assert.rejects(openBatch(zipSync(entries)),/batchCorrupt/);
  const modified=unzipSync(bytes);modified['batch.json']=strToU8(strFromU8(modified['batch.json']).replace('0.09','0.08'));
  await assert.rejects(openBatch(zipSync(modified)),/batchCorrupt/);
});
test('invalid schema, duplicate IDs, unknown entries and expansion bombs are rejected',async()=>{
  const bytes=await saveBatch([sample(1),sample(2,'queued')],options);
  for(const mutate of [m=>{m.version=999},m=>{m.files[1].id=1},m=>{m.files[0].rows[0].Amount=42},m=>{m.options.numeric='true'}]){
    await assert.rejects(openBatch(await altered(bytes,mutate)),/invalidBatch/);
  }
  const entries=unzipSync(bytes);entries['../unexpected']=strToU8('x');await assert.rejects(openBatch(zipSync(entries)),/invalidBatch/);
  const bomb=zipSync({'batch.json':strToU8('{}')});
  let offset=0;while(new DataView(bomb.buffer).getUint32(offset,true)!==0x02014b50)offset++;
  new DataView(bomb.buffer).setUint32(offset+24,200*1024*1024,true);
  await assert.rejects(openBatch(bomb),/batchTooLarge/);
});

test('fallback mode persists and older batches reopen without silently marking amounts safe', async()=>{
 const f=sample(1);f.parserMode='text-based';f.rows[0].Amount='-25.20';const bytes=await saveBatch([f],options);const round=await openBatch(bytes);assert.equal(round.files[0].parserMode,'text-based');assert.equal(round.files[0].rows[0].Amount,'-25.20');const legacy=await altered(bytes,m=>{delete m.files[0].parserMode});const restored=await openBatch(legacy);assert.equal(restored.files[0].parserMode,'unknown');assert.equal(restored.files[0].rows[0].Amount,'-25.20');const corrupt=await altered(bytes,m=>{m.files[0].parserMode='invented'});await assert.rejects(openBatch(corrupt),/invalidBatch/);
});
