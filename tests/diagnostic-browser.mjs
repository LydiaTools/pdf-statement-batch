import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dist=resolve('dist');
const server=createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://127.0.0.1').pathname;
  if(pathname==='/worker.js' && !process.env.REAL_PARSER) {res.setHeader('Content-Type','text/javascript');res.end(`self.onmessage=({data})=>{if(!data.bytes)postMessage({id:data.id,ready:true});else setTimeout(()=>postMessage({id:data.id,result:{success:true,text:'01/01/2026 Sample 10.00\\n02/01/2026 Test 12.00',pages:[],page_count:1}}),200)};`);return;}
  const path=resolve(dist,pathname==='/'?'index.html':'.'+pathname);
  if(!path.startsWith(dist+'/')){res.writeHead(403);res.end();return;}
  try {res.setHeader('Content-Type',{'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(path)]||'application/octet-stream');res.end(await readFile(path));} catch {res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
await mkdir('test-results',{recursive:true});
const executablePath=process.env.CHROME_PATH || (process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);
const browser=await chromium.launch({headless:true, ...(executablePath?{executablePath}:{}), ...(process.env.BROWSER_PROXY ? {proxy:{server:process.env.BROWSER_PROXY,bypass:'127.0.0.1,localhost'}} : {})});
try {
  const ctx=await browser.newContext({acceptDownloads:true});const page=await ctx.newPage();const methods=[];page.on('request',r=>methods.push(r.method()));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(await page.locator('#diagnostic').count(),0);
  await page.locator('#files').setInputFiles({name:'PRIVATE_SENTINEL_8791.pdf',mimeType:'application/pdf',buffer:process.env.REAL_PARSER ? await readFile('public/samples/synthetic-ruled.pdf') : Buffer.from('%PDF-1.0\nsynthetic')});
  assert.equal(await page.locator('#diagnostic').count(),0);
  await page.locator('#run').click();await page.waitForFunction(()=>document.querySelector('.file-status')?.textContent.includes('Extracted'), null, {timeout:180000});
  assert.equal(await page.locator('#diagnostic').count(),0);
  await page.locator('#files').setInputFiles({name:'PRIVATE_SENTINEL_8791.txt',mimeType:'text/plain',buffer:Buffer.from('PRIVATE_SENTINEL_8791')});
  await page.locator('.file').nth(1).click();assert.equal(await page.locator('#diagnostic').count(),1);
  const wait=page.waitForEvent('download');await page.locator('#diagnostic').click();const d=await wait;assert.equal(d.suggestedFilename(),'statement-diagnostic.json');const contents=await readFile(await d.path(),'utf8');const report=JSON.parse(contents);
  assert.deepEqual(report,{schema:'pdf-statement-batch-diagnostic-v1',app_version:'0.2.1',category:'unsupported',failed_count:1});assert(!contents.includes('PRIVATE_SENTINEL'));
  await page.screenshot({path:'test-results/diagnostic-desktop.png'});await page.setViewportSize({width:390,height:844});await page.locator('#diagnostic').scrollIntoViewIfNeeded();await page.screenshot({path:'test-results/diagnostic-mobile.png'});const mobileDownload=page.waitForEvent('download');await page.locator('#diagnostic').click();const mobileContents=await readFile(await (await mobileDownload).path(),'utf8');assert.equal(mobileContents,contents);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#language').click();assert.equal(await page.locator('#diagnostic').textContent(),'下载诊断');
  await page.locator('#retry').click();await page.waitForFunction(()=>document.querySelector('#cancel').disabled);
  await page.waitForFunction(()=>document.querySelectorAll('.file-status')[1]?.textContent.includes('需检查'));
  assert.equal(await page.locator('#diagnostic').count(),1);await page.locator('.file').first().click();assert.equal(await page.locator('#diagnostic').count(),0);
  if (!process.env.REAL_PARSER) {
    await page.locator('#files').setInputFiles({name:'synthetic-queued.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.0\nnew synthetic')});
    await page.locator('.file').nth(1).click();
    await page.locator('#run').click();
    assert.equal(await page.locator('#retry').isDisabled(),true,'retry must remain disabled while another file is processed');
    await page.locator('.file').first().click();
    const editing=page.locator('#table-wrap tbody tr').first().locator('textarea').nth(1);
    await editing.fill('UNBLURRED_SENTINEL');
    await page.waitForFunction(()=>document.querySelector('#cancel').disabled && document.querySelectorAll('.file-status')[2]?.textContent.includes('已提取'),null,{timeout:10000});
    assert.equal(await editing.inputValue(),'UNBLURRED_SENTINEL','unblurred edit must survive queue completion');
    assert.equal(await editing.evaluate(el=>document.activeElement===el),true,'focused editor must not be replaced');
    await editing.blur();
    await page.locator('.file').nth(1).click();
    assert.equal(await page.locator('#retry').isEnabled(),true,'retry must re-enable after another file finishes');
    await page.locator('.file').first().click();
    assert.equal(await page.locator('#table-wrap tbody tr').first().locator('textarea').nth(1).inputValue(),'UNBLURRED_SENTINEL','blurred edit must persist when revisiting');
    const workbook=page.waitForEvent('download'); await page.locator('#export').click(); await (await workbook).saveAs('test-results/unblurred-check.xlsx');
    assert.match(await page.locator('.file-status').first().textContent(),/已提取/);
  }
  if (process.env.REAL_PARSER) {
    await page.locator('#files').setInputFiles({name:'synthetic-corrupt.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\nnot-a-valid-pdf\n%%EOF')});
    await page.locator('.file').last().click();
    await page.locator('#run').click();
    await page.waitForFunction(()=>document.querySelectorAll('.file-status')[2]?.textContent.includes('需检查'),null,{timeout:180000});
    await page.waitForFunction(()=>document.querySelector('#cancel').disabled,null,{timeout:180000});
    assert.equal(await page.locator('#retry').isEnabled(),true,'retry must re-enable after failed queue ends');
    await page.locator('#retry').click();
    await page.waitForFunction(()=>document.querySelector('#cancel').disabled && document.querySelectorAll('.file-status')[2]?.textContent.includes('需检查'),null,{timeout:180000});
    assert.equal(await page.locator('#retry').isEnabled(),true,'retry must re-enable after a second real failure');
  }
  assert(methods.every(m=>m==='GET'));console.log(`Real Chrome, ${process.env.REAL_PARSER ? 'real parser with original synthetic PDF' : 'mocked parser'}: initial, queued, parsed, failed, download, bilingual, retry and preserved parsed item passed; observed page requests were GET (worker traffic not separately audited).`);
} finally {await browser.close();await new Promise(r=>server.close(r));}
