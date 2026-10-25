import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve('.'), out = resolve('test-results'); await mkdir(out, {recursive:true});
const server = createServer(async (req,res) => {
  const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const path = resolve(root,'dist',pathname === '/' ? 'index.html' : '.'+pathname);
  if (!path.startsWith(resolve(root,'dist')+'/')) {res.writeHead(403);res.end();return;}
  try {
    res.setHeader('Content-Type', {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.pdf':'application/pdf'}[extname(path)] || 'application/octet-stream');
    res.end(await readFile(path));
  } catch {res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const address = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || (process.platform==='darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),proxy:process.env.BROWSER_PROXY ? {server:process.env.BROWSER_PROXY,bypass:'127.0.0.1,localhost'} : undefined});
const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
const page=await context.newPage();
const errors=[], requests=[], checks=[];
page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE_ERROR',e.message)});
page.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',m.text().slice(0,300))});
context.on('request',r=>requests.push({url:r.url(),method:r.method()}));
page.on('worker',worker=>console.log('WORKER',worker.url()));
async function download(name) {const wait=page.waitForEvent('download');await page.locator('#export').click();const d=await wait;await d.saveAs(resolve(out,name));return name;}
async function finished(timeout=240000){await page.waitForFunction(()=>document.getElementById('cancel').disabled && !document.getElementById('clear').disabled,{},{timeout});}
async function clear(){page.once('dialog',d=>d.accept());await page.locator('#clear').click();}
async function saveSession(name){await page.locator('#batch-menu summary').click();const wait=page.waitForEvent('download');await page.locator('#save-batch').click();const d=await wait;assert.equal(d.suggestedFilename(),'pdf-statement-batch.psb.zip');await d.saveAs(resolve(out,name));}
async function reload(){page.once('dialog',d=>d.accept());await page.reload();}
try {
  await page.goto(address);
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));});
  await page.locator('#sample').click();await page.waitForFunction(()=>document.querySelectorAll('#queue li').length===2);
  const started=Date.now();await page.locator('#run').click();
  const progress=setInterval(async()=>{try{console.log('PROGRESS',await page.locator('#runtime').innerText(),await page.locator('#summary').innerText())}catch{}},15000);
  try { await finished(); } finally {clearInterval(progress);}
  assert.equal(await page.locator('.file-status.parsed').count(),2,await page.locator('#message').innerText());
  assert.match(await page.locator('#summary').innerText(),/8 rows/);
  await download('sample-batch.xlsx');
  checks.push({name:'real browser two-PDF extraction and actual workbook download',files:2,rows:8,elapsedMs:Date.now()-started});
  await page.screenshot({path:resolve(out,'pdf-statement-batch-desktop-en.png'),fullPage:true});
  await page.locator('#language').click();
  await page.screenshot({path:resolve(out,'pdf-statement-batch-desktop-zh.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:resolve(out,'pdf-statement-batch-mobile-zh.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});await page.locator('#language').click();
  await page.locator('textarea[data-row="0"][data-column="1"]').fill('=HYPERLINK("https://example.invalid", "literal text")');
  await page.locator('#reviewed').click();
  await page.locator('#language').click();assert.equal(await page.locator('#review-state').innerText(),'已核对');
  await download('edited-zh.xlsx');
  await saveSession('edited-batch.psb.zip');
  checks.push({name:'editable literal text, review state, EN/Chinese and 390px layout'});
  await page.setViewportSize({width:1440,height:1000});
  const beforeOffline=requests.length;
  await context.setOffline(true);await reload();
  assert.equal(await page.locator('#queue li').count(),0);
  await page.locator('#open-batch').setInputFiles(resolve(out,'edited-batch.psb.zip'));
  await page.waitForFunction(()=>document.querySelectorAll('.file-status.parsed').length===2);
  assert.equal(await page.locator('textarea[data-row="0"][data-column="1"]').inputValue(),'=HYPERLINK("https://example.invalid", "literal text")');
  assert.equal(await page.locator('#review-state').innerText(),'已核对');assert.equal(page.workers().length,0);
  await download('restored-zh.xlsx');
  await page.locator('#open-batch').setInputFiles({name:'invalid.zip',mimeType:'application/zip',buffer:Buffer.from('invalid saved batch')});
  await page.waitForFunction(()=>!document.getElementById('message').hidden);
  assert.equal(await page.locator('#queue li').count(),2);assert.equal(await page.locator('#review-state').innerText(),'已核对');
  checks.push({name:'saved batch restores original PDFs, corrected cells and review state after disconnected reload without parsing; invalid input leaves work intact',files:2,rows:8});
  await clear();
  await page.locator('#sample').click();await page.waitForFunction(()=>document.querySelectorAll('#queue li').length===2);await page.locator('#run').click();await finished();
  assert.equal(await page.locator('.file-status.parsed').count(),2);
  await download('cached-offline.xlsx');
  checks.push({name:'warm-cache disconnected reload, extraction and workbook download',coldOffline:false,requests:requests.slice(beforeOffline)});
  await context.setOffline(false);
  await clear();
  const fixture=resolve(root,'work/failure-fixtures');
  const payloads=[{name:'original.pdf',mimeType:'application/pdf',buffer:await readFile(resolve(root,'public/samples/synthetic-ruled.pdf'))},{name:'duplicate.pdf',mimeType:'application/pdf',buffer:await readFile(resolve(root,'public/samples/synthetic-ruled.pdf'))}];
  for(const name of ['scan.pdf','locked.pdf','broken.pdf','wrong.txt','amount-only.pdf'])payloads.push({name,mimeType:name.endsWith('.pdf')?'application/pdf':'text/plain',buffer:await readFile(resolve(fixture,name))});
  await page.locator('#files').setInputFiles(payloads);await page.locator('#run').click();await finished();
  assert.equal(await page.locator('.file-status.parsed').count(),2);
  assert.equal(await page.locator('.file-status.duplicate').count(),1);
  assert.equal(await page.locator('.file-status.failed').count(),4);
  await page.locator('[data-id="4"]').click();assert.match(await page.locator('#table-wrap').innerText(),/加密|password/i);
  await download('file-accounting.xlsx');
  await page.locator('[data-id="1"]').click();await page.locator('#currency').selectOption('');
  await download('unconfirmed-currency.xlsx');await page.locator('#currency').selectOption('USD');
  await page.locator('[data-id="5"]').click();await page.locator('#retry').click();await finished();
  assert.equal(await page.locator('#queue li').count(),7);assert.equal(await page.locator('.file-status.failed').count(),4);
  checks.push({name:'scan, encrypted, broken, wrong type, explicit duplicate, incompatible columns/currency and failed-file retry',selected:7,parsed:2,duplicates:1,failed:4});
  await clear();
  const inputNames=(await readdir(resolve(root,'work/large-fixtures'))).filter(n=>n.endsWith('.pdf')).sort();
  assert.equal(inputNames.length,500);
  await page.locator('#files').setInputFiles(inputNames.map(n=>resolve(root,'work/large-fixtures',n)));
  const largeStart=Date.now();await page.locator('#run').click();
  await page.waitForFunction(()=>document.querySelectorAll('.file-status.parsed').length>=1);
  await page.locator('#cancel').click();await finished();
  const paused={parsed:await page.locator('.file-status.parsed').count(),canceled:await page.locator('.file-status.canceled').count()};
  assert.equal(paused.parsed+paused.canceled,500);assert(paused.canceled>0);
  await download('canceled-batch.xlsx');
  await saveSession('canceled-batch.psb.zip');
  await context.setOffline(true);await reload();
  await page.locator('#open-batch').setInputFiles(resolve(out,'canceled-batch.psb.zip'));
  await page.waitForFunction(()=>document.querySelectorAll('#queue li').length===500);
  assert.equal(await page.locator('.file-status.canceled').count(),paused.canceled);
  const cdp=await browser.newBrowserCDPSession();let peakRssKiB=0,samples=0;
  async function memory(){try {const info=await cdp.send('SystemInfo.getProcessInfo');const ids=info.processInfo.map(x=>x.id);const raw=execFileSync('/bin/ps',['-o','rss=','-p',ids.join(',')],{encoding:'utf8'});peakRssKiB=Math.max(peakRssKiB,raw.trim().split(/\s+/).map(Number).reduce((s,n)=>s+n,0));samples++;}catch{}}
  const interval=setInterval(async()=>{await memory();console.log('LARGE',await page.locator('#summary').innerText())},5000);
  await memory();
  try {await page.locator('#resume').click();await finished(600000);}finally{clearInterval(interval);await memory();}
  assert.equal(await page.locator('.file-status.parsed').count(),500);assert.equal(await page.locator('.file-status.duplicate').count(),0);
  assert.equal(await page.locator('.file-status.failed').count(),0);assert.match(await page.locator('#summary').innerText(),/2000/);
  await download('large-batch.xlsx');
  checks.push({name:'500 byte-distinct PDFs; stop, save, disconnected reload, reopen and resume pending original files',layouts:2,files:500,rows:2000,skippedDuplicates:0,paused,elapsedMs:Date.now()-largeStart,sampledBrowserPeakRssKiB:peakRssKiB,memorySamples:samples,memoryScope:'RSS sum of this test browser process tree sampled every 5 seconds; not a continuous peak or general hardware benchmark'});
  await writeFile(resolve(out,'browser-verified.json'),JSON.stringify({completedAt:new Date().toISOString(),browser:browser.version(),checks,errors,requests},null,2)+'\n');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks:checks.length,output:out}));
} catch(error) {
  await page.screenshot({path:resolve(out,'failure.png'),fullPage:true}).catch(()=>{});
  await writeFile(resolve(out,'browser-failure.json'),JSON.stringify({at:new Date().toISOString(),error:String(error.stack||error),errors,requests,runtime:await page.locator('#runtime').innerText().catch(()=>''),queue:await page.locator('#queue').innerText().catch(()=>'')},null,2)+'\n');
  throw error;
} finally {await context.close();await browser.close();await new Promise(r=>server.close(r));}
