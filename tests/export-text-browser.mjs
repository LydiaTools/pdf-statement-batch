import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');const dist=resolve('dist');
const server=createServer(async(req,res)=>{const u=new URL(req.url,'http://127.0.0.1').pathname;
 if(u==='/vendor/parsers/generic-parser.js'){res.setHeader('Content-Type','text/javascript');return res.end(`export function parseWithPositions(){return {success:true,headers:['Date','Description','Amount'],transactions:[{Date:'01/01/2026',Description:'=1+1',Amount:'1,234.56'},{Date:'02/01/2026',Description:'Synthetic B',Amount:' -12.30 '},{Date:'03/01/2026',Description:'Synthetic C',Amount:'0.00'},{Date:'04/01/2026',Description:'Synthetic D',Amount:'1234567890123456.78'}],metadata:{parserType:'position-based'}}}`)}
 if(u==='/worker.js'){res.setHeader('Content-Type','text/javascript');return res.end(`self.onmessage=({data})=>postMessage({id:data.id,...(!data.bytes?{ready:true}:{result:{success:true,text:'synthetic',pages:[],page_count:1}})})`)}
 const file=resolve(dist,u==='/'?'index.html':'.'+u);if(!file.startsWith(dist+'/')){res.writeHead(403);return res.end()}try{res.setHeader('Content-Type',{'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(file)]||'application/octet-stream');res.end(await readFile(file))}catch{res.writeHead(404);res.end()}});
await mkdir('test-results',{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const executablePath=process.env.CHROME_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);const b=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
try{const c=await b.newContext({acceptDownloads:true});const p=await c.newPage();await p.goto(`http://127.0.0.1:${server.address().port}/`);await p.locator('#files').setInputFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.0\nfictional')});await p.locator('#run').click();await p.waitForFunction(()=>document.querySelector('.file-status.parsed'));
await p.locator('#settings').click();await p.locator('#numeric').uncheck();await p.locator('#settings-dialog button[value="close"]').first().click();
await p.locator('textarea[data-row="0"][data-column="2"]').fill(' 1,234.56 ');
let d=p.waitForEvent('download');await p.locator('#export').click();await (await d).saveAs('test-results/export-text.xlsx');
assert.equal(await p.locator('textarea[data-row="0"][data-column="2"]').inputValue(),' 1,234.56 ');
await p.locator('#settings').click();await p.locator('#numeric').check();await p.locator('#settings-dialog button[value="close"]').first().click();d=p.waitForEvent('download');await p.locator('#export').click();await (await d).saveAs('test-results/export-numeric.xlsx');
console.log('Downloaded both modes after editing a focused cell.');await c.close()}finally{await b.close();await new Promise(r=>server.close(r))}
