import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname,resolve,sep} from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root=resolve('dist');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.pdf':'application/pdf','.py':'text/plain'};
const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/audit-canary'||path==='/audit-sw-canary'){res.end('ok');return;}
  if(path==='/audit-worker.js'){res.setHeader('Content-Type','text/javascript');res.end("fetch('/audit-canary',{method:'POST',body:'canary'}).then(r=>r.text()).then(x=>postMessage(x)).catch(e=>postMessage('error:'+e))");return;}
  const file=resolve(root,'.'+(path==='/'?'/index.html':path));
  if(!file.startsWith(root+sep)){res.writeHead(403).end();return;}
  try{res.setHeader('Content-Type',mime[extname(file)]||'application/octet-stream');res.end(await readFile(file));}
  catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const address=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:(process.platform==='darwin'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})),...(process.env.BROWSER_PROXY?{proxy:{server:process.env.BROWSER_PROXY,bypass:'127.0.0.1,localhost'}}:{})});
const context=await browser.newContext({serviceWorkers:'allow',acceptDownloads:true});
const events=[], websockets=[];
context.on('request',r=>events.push({url:r.url(),method:r.method(),type:r.resourceType(),body:!!r.postDataBuffer(),owner:r.serviceWorker()?'service-worker':'page-or-dedicated-worker'}));
const page=await context.newPage();
page.on('websocket',ws=>websockets.push(ws.url()));
page.on('pageerror',e=>console.error('pageerror:',e.message));
try{
  const workerEvent=context.waitForEvent('serviceworker');
  await page.goto(address);
  const serviceWorker=await workerEvent;
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  assert.equal(await page.evaluate(()=>navigator.serviceWorker.controller.scriptURL),address+'/sw.js');
  const serviceWorkerCanary=context.waitForEvent('request',r=>r.url()===address+'/audit-sw-canary'&&r.method()==='POST');
  assert.equal(await serviceWorker.evaluate(async()=>{const r=await fetch('/audit-sw-canary',{method:'POST',body:'synthetic-canary'});return r.text();}),'ok');
  const canary=await serviceWorkerCanary;
  assert(canary.serviceWorker(),'service worker POST was not attributed to service worker');
  assert(canary.postDataBuffer(),'service worker POST body was not observed');
  console.log('Service worker is active and its synthetic POST/body canary was observed.');
  await page.evaluate(()=>new Promise((resolve,reject)=>{
    const w=new Worker('/audit-worker.js');w.onmessage=e=>{w.terminate();e.data==='ok'?resolve():reject(Error(e.data))};
    w.onerror=reject;
  }));
  assert(events.some(e=>e.url===address+'/audit-canary'&&e.method==='POST'&&e.body),'network listener did not observe dedicated worker POST canary');
  console.log('Dedicated worker POST/body canary observed.');
  events.length=0;
  await page.locator('#sample').click();
  await page.waitForFunction(()=>document.querySelectorAll('#queue li').length===2);
  await page.locator('#run').click();
  await page.waitForFunction(()=>document.querySelectorAll('.file-status.parsed').length===2,null,{timeout:240000});
  assert.match(await page.locator('#summary').innerText(),/8 rows/);
  const download=page.waitForEvent('download');await page.locator('#export').click();await download;
  const bad=events.filter(e=>e.method!=='GET'||e.body);
  assert.deepEqual(bad,[],'non-GET or request body observed');
  assert.deepEqual(websockets,[],'page websocket observed');
  const hosts=[...new Set(events.map(e=>new URL(e.url).host))];
  assert(hosts.every(host=>host===new URL(address).host||host==='cdn.jsdelivr.net'),'unexpected request host');
  assert(events.every(e=>!new URL(e.url).search&&!new URL(e.url).hash),'unexpected URL query or fragment');
  assert(events.filter(e=>new URL(e.url).host==='cdn.jsdelivr.net').every(e=>new URL(e.url).pathname.startsWith('/pyodide/v0.29.3/full/')),'unexpected CDN path');
  assert(events.some(e=>e.owner==='service-worker'),'no service-worker-owned application request observed');
  console.log(JSON.stringify({result:'passed',browser:browser.version(),fixture:'two original synthetic PDFs',parsed:2,rows:8,requestCount:events.length,hosts,methods:[...new Set(events.map(e=>e.method))],requestBodies:bad.length,pageWebSockets:websockets.length,dedicatedWorkerCanary:true,serviceWorkerCanary:true,serviceWorkers:'active and controlling page',serviceWorkerRequests:events.filter(e=>e.owner==='service-worker').length,scope:'observed requests for this synthetic run; not proof for all paths, browsers, service-worker changes, or data encodings'},null,2));
}finally{await context.close();await browser.close();await new Promise(r=>server.close(r));}
