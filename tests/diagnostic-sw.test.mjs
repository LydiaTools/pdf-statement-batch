import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile('public/sw.js','utf8');
async function run(fail=false){
 const handlers={}, prior='pdf-statement-batch-preview-2', next='pdf-statement-batch-preview-4';
 const runtime='https://cdn.jsdelivr.net/pyodide/v0.29.3/full/example.js', missing='https://cdn.jsdelivr.net/pyodide/v0.29.3/full/missing.js', local='http://localhost/core.js';
 const stores=new Map([[prior,new Map([[runtime,'old runtime'],[missing,'old missing runtime'],[local,'old code']])],[next,new Map([[local,'new code'],[runtime,'new runtime']])]]);
 const caches={async keys(){return [...stores.keys()]},async delete(k){return stores.delete(k)},async open(k){const m=stores.get(k);return {async keys(){return [...m.keys()].map(url=>({url}))},async match(r){return m.get(typeof r==='string'?r:r.url)},async put(r,v){if(fail)throw Error('storage failure');m.set(r.url,v)}}}};
 const self={location:{href:'http://localhost/sw.js'},clients:{claim:async()=>{}},addEventListener:(name,fn)=>handlers[name]=fn};vm.runInNewContext(source,{caches,self,URL});let promise;handlers.activate({waitUntil(p){promise=p}});try { await promise; } catch(e) { e.stores=stores; throw e; } return {stores,prior,next,runtime,missing,local};
}
test('SW preserves cached runtime without replacing new application assets',async()=>{const {stores,prior,next,runtime,missing,local}=await run();assert(!stores.has(prior));assert.equal(stores.get(next).get(runtime),'new runtime');assert.equal(stores.get(next).get(missing),'old missing runtime');assert.equal(stores.get(next).get(local),'new code');});
test('SW leaves old cache intact if runtime migration fails',async()=>{await assert.rejects(run(true),e=>{assert.match(e.message,/storage failure/);assert(e.stores.has('pdf-statement-batch-preview-2'));return true;});});
