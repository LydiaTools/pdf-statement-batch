import { parseWithPositions } from './vendor/parsers/generic-parser.js';
import { explicitCurrency, groups, moneyHeader, workbookSheets, inputError, failureDiagnostic, dateObservations, mapTransactionRows, classifyParserMode } from './core.js';
import { writeWorkbook } from './xlsx.js';
import { strings } from './i18n.js';
import { saveBatch, openBatch } from './session.js';

const $ = id => document.getElementById(id);
let language = new URLSearchParams(location.search).get('lang') === 'zh' ? 'zh' : 'en';
let files = [], nextId = 1, selected = null, running = false, stop = false;
let worker = null, ready = false, requestId = 0, pending = new Map(), runtimeState = 'notLoaded';
let sourceURL;
let sheetSignature = '';
let batchBusy = false;
const t = key => strings[language][key] || key;
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function message(key) { $('message').textContent = key ? t(key) : ''; $('message').hidden = !key; }
function localize() {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  document.title = language === 'zh' ? '对账单合表 · PDF Statement Batch' : 'PDF Statement Batch — PDF statements to Excel';
  document.querySelectorAll('[data-t]').forEach(el => { el.textContent = t(el.dataset.t); });
  $('language').textContent = language === 'en' ? '中文' : 'English';
  $('runtime').textContent = t(runtimeState);
  $('currency').setAttribute('aria-label', t('currency'));
  render();
}
function render() {
  const count = files.reduce((s, f) => s + (f.rows?.length || 0), 0);
  $('summary').textContent = files.length ? `${files.length} ${t('fileCount')} / ${count} ${t('rows')} / ${groups(files).length} ${t('groupCount')}` : t('noFiles');
  $('file-count').textContent = files.length;
  $('empty').hidden = files.length > 0;
  $('queue').innerHTML = files.map(f => `<li><button class="file${selected === f.id ? ' active' : ''}" data-id="${f.id}" aria-pressed="${selected === f.id}"><span class="file-content"><span class="filename">${escape(f.name)}</span><span class="file-status ${f.status}">${t(f.status)}${f.status === 'parsed' ? ` · ${f.rows.length} ${t('rows')}` : ''}${f.reviewed ? ` · ${t('reviewed')}` : ''}</span></span></button></li>`).join('');
  $('run').disabled = running || batchBusy || !files.some(f => f.status === 'queued');
  $('cancel').disabled = !running || stop;
  $('cancel').textContent = t(stop ? 'stopping' : 'cancel');
  $('resume').hidden = running || !files.some(f => f.status === 'canceled');
  $('clear').disabled = running || batchBusy || !files.length;
  $('sample').disabled = running || batchBusy;
  $('files').disabled = running || batchBusy;
  $('add-files').setAttribute('aria-disabled', String(running || batchBusy));
  document.querySelector('label[for=files]').style.opacity = running || batchBusy ? '.45' : '1';
  $('export').disabled = running || batchBusy || !files.length;
  $('save-batch').disabled = running || batchBusy || !files.length;
  $('open-batch').disabled = running || batchBusy;
  $('open-batch-label').setAttribute('aria-disabled', String(running || batchBusy));
  document.querySelector('.workbench').inert = batchBusy;
  renderSheet();
}
function renderDateObservation(file) {
  const el = $('date-observation');
  const amountEl = $('amount-observation');
  amountEl.hidden = !file || file.status !== 'parsed' || file.parserMode === 'other';
  amountEl.textContent = amountEl.hidden ? '' : t(file.parserMode === 'text-based' ? 'fallbackAmount' : 'unknownAmount');
  if (!file || file.status !== 'parsed') { el.hidden = true; el.textContent = ''; return; }
  const finding = dateObservations(file.headers, file.rows);
  el.hidden = finding.kind === 'none';
  el.textContent = finding.kind === 'no-date-column' ? t('noDateColumn') : finding.kind === 'empty-date-rows' ? `${finding.count} ${t(finding.count === 1 ? 'oneEmptyDateRow' : 'emptyDateRows')}` : '';
}
function renderSheet() {
  const f = files.find(f => f.id === selected);
  renderDateObservation(f);
  const signature = JSON.stringify([f?.id,f?.status,f?.currency,f?.reviewed,f?.edits,f?.error,language,running]);
  if (signature === sheetSignature) return;
  sheetSignature = signature;
  $('review-controls').hidden = f?.status !== 'parsed';
  $('review-note').hidden = f?.status !== 'parsed';
  $('source').textContent = f ? f.name : '';
  $('open-source').hidden = !f;
  if (sourceURL) URL.revokeObjectURL(sourceURL);
  sourceURL = f ? URL.createObjectURL(new Blob([f.file], { type: 'application/pdf' })) : null;
  if (sourceURL) $('open-source').href = sourceURL;
  if (!f) { $('table-wrap').innerHTML = `<p class="sheet-empty">${t('selectFile')}</p>`; return; }
  if (f.status !== 'parsed') {
    const detail = f.status === 'duplicate' ? `${t('duplicateOf')} #${f.duplicateOf}` : t(f.errorKey || 'unprocessed');
    $('table-wrap').innerHTML = `<div class="detail"><p class="${f.status === 'failed' ? 'error' : ''}">${escape(detail)}</p>${f.status === 'failed' ? `<button id="retry">${t('retry')}</button> <button id="diagnostic">${t('diagnostic')}</button><p>${t('diagnosticNote')}</p>` : ''}</div>`;
    const diagnostic = $('diagnostic');
    if (diagnostic) diagnostic.onclick = () => {
      const report = failureDiagnostic(f, files);
      if (!report) return;
      const bytes = new TextEncoder().encode(JSON.stringify(report, null, 2) + '\n');
      downloadFile(bytes, 'application/json', 'statement-diagnostic.json');
    };
    const retry = $('retry');
    if (retry) { retry.disabled = running; retry.onclick = () => { f.status = 'queued'; f.error = ''; f.errorKey = ''; render(); run(); }; }
    return;
  }
  if (f.currency && ![...$('currency').options].some(o => o.value === f.currency)) $('currency').add(new Option(f.currency, f.currency));
  $('currency').value = f.currency;
  $('review-state').textContent = t(f.reviewed ? 'reviewed' : f.edits ? 'changed' : 'notReviewed');
  $('reviewed').disabled = f.reviewed;
  $('table-wrap').innerHTML = `<table><thead><tr><th scope="col">#</th>${f.headers.map(h => `<th scope="col">${escape(h)}</th>`).join('')}</tr></thead><tbody>${f.rows.map((row, i) => `<tr><td class="row-number">${i+1}</td>${f.headers.map((h, c) => `<td class="${moneyHeader(h) ? 'money' : /description/i.test(h) ? 'description' : ''}"><textarea data-row="${i}" data-column="${c}" aria-label="${escape(h)} ${i+1}" spellcheck="false">${escape(row[h] || '')}</textarea></td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function addFiles(incoming) {
  for (const file of incoming) {
    const item = { id: nextId++, name: file.name, file, status: 'queued', rows: [], headers: [], currency: '', reviewed: false, edits: 0 };
    const errorKey = inputError(file);
    if (errorKey) Object.assign(item, { status: 'failed', errorKey, error: strings.en[errorKey] });
    files.push(item);
  }
  if (!selected) selected = files[0]?.id;
  message(''); render();
}
function destroyWorker() {
  worker?.terminate(); worker = null; ready = false;
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Worker stopped')); }
  pending.clear();
}
function ask(bytes) {
  if (!worker) {
    worker = new Worker('./worker.js');
    worker.onmessage = ({ data }) => {
      if (data.progress) { runtimeState = data.progress; $('runtime').textContent = t(runtimeState); return; }
      const item = pending.get(data.id);
      if (!item) return;
      pending.delete(data.id); clearTimeout(item.timer);
      if (data.error) item.reject(new Error(data.error)); else item.resolve(data);
    };
    worker.onerror = () => { destroyWorker(); runtimeState = 'runtimeFailed'; $('runtime').textContent = t(runtimeState); };
  }
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(bytes ? 'pdfTimeout' : 'runtimeFailed')); destroyWorker(); }, bytes ? 90000 : 180000);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, bytes }, bytes ? [bytes] : []);
  });
}
function fail(f, key, detail = '') {
  f.status = 'failed'; f.errorKey = key; f.error = detail || strings.en[key]; f.rows = []; f.headers = [];
}
async function run() {
  if (running) return;
  running = true; stop = false; message(''); render();
  try {
    if (!ready) {
      runtimeState = 'starting'; $('runtime').textContent = t(runtimeState);
      try { await ask(); ready = true; }
      catch (error) { runtimeState = 'runtimeFailed'; $('runtime').textContent = t(runtimeState); message('initFailed'); destroyWorker(); return; }
    }
    for (const f of files.filter(f => f.status === 'queued')) {
      if (stop) { f.status = 'canceled'; continue; }
      f.status = 'processing'; render();
      try {
        const errorKey = inputError(f.file);
        if (errorKey) { fail(f, errorKey); render(); continue; }
        const bytes = await f.file.arrayBuffer();
        f.hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
        const original = $('deduplicate').checked && files.find(x => x.id < f.id && x.hash === f.hash && x.status === 'parsed');
        if (original) { f.status = 'duplicate'; f.duplicateOf = original.id; render(); continue; }
        if (new TextDecoder('ascii').decode(bytes.slice(0, 1024)).indexOf('%PDF-') < 0) { fail(f, 'invalid'); render(); continue; }
        const { result } = await ask(bytes);
        if (!result.success) fail(f, /password|encrypt|decrypt/i.test(result.error || '') ? 'encrypted' : 'invalid', result.error || 'Invalid or encrypted PDF');
        else if (!result.text.trim()) fail(f, 'noText');
        else {
          const parsed = parseWithPositions(result.pages, result.text, result);
          if (!parsed.success || !parsed.transactions?.length) fail(f, 'noRows');
          else {
            f.status = 'parsed'; f.headers = parsed.headers;
            f.parserMode = classifyParserMode(parsed);
            f.rows = mapTransactionRows(parsed);
            f.currency = explicitCurrency(result.text);
            f.pages = result.page_count;
            f.error = result.graphics_error ? strings.en.partialGraphics : '';
          }
        }
      } catch (error) {
        fail(f, error.message === 'pdfTimeout' ? 'pdfTimeout' : 'invalid', error.message);
        if (!worker) break; // A stopped worker does not silently fail the rest of the queue.
      }
      render();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally { running = false; render(); }
}
$('files').onchange = event => { if (!running) addFiles(event.target.files); event.target.value = ''; };
$('add-files').onkeydown = event => { if (['Enter',' '].includes(event.key)) { event.preventDefault(); if (!running) $('files').click(); } };
$('sample').onclick = async () => {
  try {
    const sample = await Promise.all(['synthetic-ruled.pdf', 'synthetic-borderless.pdf'].map(async name => {
      const response = await fetch('./samples/' + name); if (!response.ok) throw new Error();
      return new File([await response.blob()], name, { type: 'application/pdf' });
    }));
    addFiles(sample);
  } catch { message('loadSampleFailed'); }
};
$('run').onclick = run;
$('cancel').onclick = () => { stop = true; render(); };
$('resume').onclick = () => { files.filter(f => f.status === 'canceled').forEach(f => { f.status = 'queued'; }); run(); };
$('queue').onclick = event => { const b = event.target.closest('[data-id]'); if (b) { selected = Number(b.dataset.id); render(); } };
$('table-wrap').onchange = event => {
  const cell = event.target.closest('textarea'); const f = files.find(f => f.id === selected);
  if (!cell || !f || f.status !== 'parsed') return;
  f.rows[Number(cell.dataset.row)][f.headers[Number(cell.dataset.column)]] = cell.value;
  f.reviewed = false; f.edits++; $('review-state').textContent = t('changed'); $('reviewed').disabled = false;
  renderDateObservation(f);
};
$('reviewed').onclick = () => { const f = files.find(f => f.id === selected); if (f) { f.reviewed = true; render(); } };
$('currency').onchange = () => { const f = files.find(f => f.id === selected); if (f) { f.currency = $('currency').value; f.reviewed = false; render(); } };
$('export').onclick = () => {
  try {
    const sheets = workbookSheets(files, language);
    if (!$('numeric').checked) for (const sheet of sheets.filter(s => s.name.startsWith('Transactions'))) {
      for (const row of sheet.rows.slice(1)) for (const cell of row.slice(4)) if (cell.number !== undefined) { cell.text = cell.number; delete cell.number; }
    }
    const bytes = writeWorkbook(sheets);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const link = document.createElement('a'); link.href = url; link.download = 'pdf-statement-batch.xlsx'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch { message('exportFailed'); }
};
$('clear').onclick = () => { if (confirm(t('clearConfirm'))) { files = []; selected = null; nextId = 1; message(''); render(); } };
$('language').onclick = () => { language = language === 'en' ? 'zh' : 'en'; const url = new URL(location.href); url.searchParams.set('lang', language); history.replaceState(null, '', url); localize(); };
$('settings').onclick = () => $('settings-dialog').showModal();
$('appearance').onclick = () => $('appearance-dialog').showModal();
$('theme').onchange = () => document.body.classList.toggle('dark', $('theme').value === 'dark');
$('workspace').onclick = () => $('files').focus();
function downloadFile(bytes, type, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
$('save-batch').onclick = async () => {
  if (running || batchBusy) return;
  batchBusy = true; message(''); render();
  try {
    const bytes = await saveBatch(files, { language, selected, theme: $('theme').value, numeric: $('numeric').checked, deduplicate: $('deduplicate').checked });
    downloadFile(bytes, 'application/zip', 'pdf-statement-batch.psb.zip');
    $('batch-menu').open = false;
  } catch (error) { message(error.message === 'batchTooLarge' ? 'batchTooLarge' : 'saveBatchFailed'); }
  finally { batchBusy = false; render(); }
};
$('open-batch-label').onkeydown = event => { if (['Enter',' '].includes(event.key)) { event.preventDefault(); if (!running && !batchBusy) $('open-batch').click(); } };
$('open-batch').onchange = async event => {
  const source = event.target.files[0]; event.target.value = '';
  if (!source || running || batchBusy) return;
  batchBusy = true; message(''); render();
  try {
    if (source.size > 110 * 1024 * 1024) throw new Error('batchTooLarge');
    const restored = await openBatch(new Uint8Array(await source.arrayBuffer()));
    if (files.length && !confirm(t('replaceBatch'))) return;
    files = restored.files; selected = restored.options.selected; nextId = Math.max(...files.map(f => f.id)) + 1;
    language = restored.options.language; $('theme').value = restored.options.theme;
    document.body.classList.toggle('dark', restored.options.theme === 'dark');
    $('numeric').checked = restored.options.numeric; $('deduplicate').checked = restored.options.deduplicate;
    sheetSignature = ''; localize(); $('batch-menu').open = false;
  } catch (error) { message(['batchTooLarge','batchCorrupt'].includes(error.message) ? error.message : 'invalidBatch'); }
  finally { batchBusy = false; render(); }
};
window.addEventListener('beforeunload', event => { if (files.length) { event.preventDefault(); event.returnValue = ''; } });
localize();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
