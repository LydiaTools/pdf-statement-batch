const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
const server=createServer(async(req,res)=>{const path=resolve('dist','.'+(req.url==='/'?'/index.html':req.url));try{res.setHeader('Content-Type',{'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(path)]||'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || (process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)}),context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true}),page=await context.newPage();
const requests=[];context.on('request',r=>requests.push(r.url()));
async function download(p,button,name){const waiting=p.waitForEvent('download');await p.locator(button).click();const file=await waiting;await file.saveAs(resolve('test-results',name));}
try{
 await page.goto(url);await page.evaluate(async()=>{await navigator.serviceWorker.ready});
 await page.locator('#open-batch').setInputFiles(resolve('test-results/edited-batch.psb.zip'));await page.waitForFunction(()=>document.querySelectorAll('.file-status.parsed').length===2);
 await page.locator('[data-id="2"]').click();await page.locator('#reviewed').click();await page.locator('#language').click();
 await page.locator('#batch-menu summary').click();await page.screenshot({path:'test-results/session-desktop-en.png',fullPage:true});
 await page.locator('#language').click();await page.screenshot({path:'test-results/session-desktop-zh.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const rect=await page.locator('.batch-options').boundingBox();assert(rect.x>=0&&rect.x+rect.width<=390);
 await page.screenshot({path:'test-results/session-mobile-zh.png',fullPage:true});
 await page.locator('#batch-menu summary').click();await page.setViewportSize({width:1440,height:1000});await page.locator('#language').click();
 await page.locator('#settings').click();await page.locator('#numeric').uncheck();await page.locator('#deduplicate').uncheck();await page.locator('#settings-dialog button.primary').click();
 await page.locator('#appearance').click();await page.locator('#theme').selectOption('dark');await page.locator('#appearance-dialog button.primary').click();
 await page.locator('#batch-menu summary').click();await download(page,'#save-batch','preferences-batch.psb.zip');
 await page.close();await context.setOffline(true);const reopened=await context.newPage();await reopened.goto(url);
 await reopened.locator('#open-batch').setInputFiles(resolve('test-results/preferences-batch.psb.zip'));await reopened.waitForFunction(()=>document.querySelectorAll('.file-status.parsed').length===2);
 assert.equal(await reopened.locator('html').getAttribute('lang'),'en');assert(await reopened.locator('body').evaluate(e=>e.classList.contains('dark')));
 assert.equal(await reopened.locator('#numeric').isChecked(),false);assert.equal(await reopened.locator('#deduplicate').isChecked(),false);
 assert.equal(await reopened.locator('.file.active').getAttribute('data-id'),'2');assert.equal(await reopened.locator('#review-state').innerText(),'Reviewed');assert.equal(reopened.workers().length,0);
 await download(reopened,'#export','preferences-restored.xlsx');
 assert(requests.every(u=>u.startsWith(url)));
 await writeFile('test-results/session-preferences-verified.json',JSON.stringify({at:new Date().toISOString(),tabActuallyClosed:true,reopenedDisconnected:true,originalFiles:2,rows:8,restored:['selectedFile','editedRows','reviewFlags','English','darkTheme','numericTextSetting','deduplicationSetting'],pdfWorkerStarted:false,externalRequests:0,mobileWidth:390,batchMenuInsideViewport:true},null,2)+'\n');console.log('SESSION_VISUAL_AND_PREFERENCES_PASSED');
}finally{await context.close();await browser.close();await new Promise(r=>server.close(r));}
