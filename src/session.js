import { zipSync, unzipSync, strToU8, strFromU8 } from './vendor/fflate.js';
import { STATUSES } from './core.js';

export const MAX_BATCH_BYTES = 100 * 1024 * 1024;
const MAX_METADATA_BYTES = 10 * 1024 * 1024;
const invalid = () => { throw new Error('invalidBatch'); };
const tooLarge = () => { throw new Error('batchTooLarge'); };
const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');

export async function saveBatch(files, options) {
  if (!files.length) invalid();
  if (files.length > 1000) tooLarge();
  if (files.reduce((sum, file) => sum + file.file.size, 0) > MAX_BATCH_BYTES) tooLarge();
  const entries = {}, records = [];
  const snapshot = files.map(file => ({ ...file, headers: [...file.headers], rows: structuredClone(file.rows) }));
  for (const file of snapshot) {
    const bytes = new Uint8Array(await file.file.arrayBuffer());
    const hash = await sha256(bytes);
    const source = `files/${file.id}.bin`;
    entries[source] = bytes;
    records.push({ id: file.id, name: file.name, status: file.status === 'processing' ? 'queued' : file.status,
      headers: file.headers, rows: file.rows, currency: file.currency, reviewed: file.reviewed,
      edits: file.edits, hash: file.hash || '', duplicateOf: file.duplicateOf || null,
      pages: file.pages || 0, errorKey: file.errorKey || '', error: file.error || '', source, sourceSha256: hash });
  }
  const metadata = strToU8(JSON.stringify({ format: 'pdf-statement-batch', version: 1, savedAt: new Date().toISOString(), options, files: records }));
  if (metadata.length > MAX_METADATA_BYTES) tooLarge();
  entries['batch.json'] = metadata;
  entries['batch.sha256'] = strToU8(await sha256(metadata));
  return zipSync(entries, { level: 6 });
}

export async function openBatch(bytes) {
  if (bytes.length > MAX_BATCH_BYTES + MAX_METADATA_BYTES) tooLarge();
  let entries, count = 0, expandedBytes = 0;
  const seen = new Set();
  try {
    entries = unzipSync(bytes, { filter: item => {
      if (seen.has(item.name) || !/^(batch\.(json|sha256)|files\/[1-9]\d*\.bin)$/.test(item.name)) invalid();
      seen.add(item.name);
      expandedBytes += item.originalSize;
      if (++count > 1002 || !Number.isSafeInteger(item.originalSize) || item.originalSize < 0 || expandedBytes > MAX_BATCH_BYTES + MAX_METADATA_BYTES) tooLarge();
      if (item.name === 'batch.json' && item.originalSize > MAX_METADATA_BYTES) tooLarge();
      if (item.name.startsWith('files/') && item.originalSize > 50 * 1024 * 1024) tooLarge();
      if (item.name === 'batch.sha256' && item.originalSize !== 64) invalid();
      return true;
    } });
  } catch (error) { throw new Error(error.message === 'batchTooLarge' ? 'batchTooLarge' : 'invalidBatch'); }
  let metadata;
  if (!entries['batch.json'] || !entries['batch.sha256']) invalid();
  if (strFromU8(entries['batch.sha256']) !== await sha256(entries['batch.json'])) throw new Error('batchCorrupt');
  try { metadata = JSON.parse(strFromU8(entries['batch.json'])); } catch { invalid(); }
  if (metadata?.format !== 'pdf-statement-batch' || metadata.version !== 1 || !Array.isArray(metadata.files) || !metadata.files.length || metadata.files.length > 1000) invalid();
  const settings = metadata.options;
  if (!settings || !['en','zh'].includes(settings.language) || !['light','dark'].includes(settings.theme) || typeof settings.numeric !== 'boolean' || typeof settings.deduplicate !== 'boolean') invalid();
  if (Object.keys(entries).length !== metadata.files.length + 2) invalid();
  const ids = new Set(), files = [];
  let sourceBytes = 0;
  for (const record of metadata.files) {
    if (!Number.isSafeInteger(record.id) || record.id < 1 || record.id > 1000000 || ids.has(record.id)) invalid();
    ids.add(record.id);
    if (typeof record.name !== 'string' || !record.name || record.name.length > 1024 || !STATUSES.includes(record.status)) invalid();
    if (!Array.isArray(record.headers) || record.headers.some(h => typeof h !== 'string' || !h) || new Set(record.headers).size !== record.headers.length) invalid();
    if (!Array.isArray(record.rows) || typeof record.currency !== 'string' || !/^(|[A-Z]{3})$/.test(record.currency) || typeof record.reviewed !== 'boolean') invalid();
    if (!Number.isSafeInteger(record.edits) || record.edits < 0 || !Number.isSafeInteger(record.pages) || record.pages < 0) invalid();
    if (typeof record.errorKey !== 'string' || typeof record.error !== 'string' || typeof record.hash !== 'string' || !/^(|[0-9a-f]{64})$/.test(record.hash)) invalid();
    if (record.status === 'parsed' ? !record.headers.length || !record.rows.length : record.rows.length > 0) invalid();
    for (const row of record.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== record.headers.length || record.headers.some(h => !Object.hasOwn(row, h) || typeof row[h] !== 'string')) invalid();
    }
    const source = `files/${record.id}.bin`;
    if (record.source !== source || !entries[source] || !/^[0-9a-f]{64}$/.test(record.sourceSha256)) invalid();
    const actualHash = await sha256(entries[source]);
    if (record.sourceSha256 !== actualHash || record.hash && record.hash !== actualHash) throw new Error('batchCorrupt');
    sourceBytes += entries[source].length;
    if (sourceBytes > MAX_BATCH_BYTES) tooLarge();
    files.push({ id: record.id, name: record.name, status: record.status === 'processing' ? 'queued' : record.status,
      headers: [...record.headers], rows: record.rows.map(row => Object.fromEntries(record.headers.map(h => [h, row[h]]))),
      currency: record.currency, reviewed: record.reviewed, edits: record.edits, hash: record.hash,
      duplicateOf: record.duplicateOf, pages: record.pages, errorKey: record.errorKey, error: record.error,
      file: new File([entries[source]], record.name, { type: /\.pdf$/i.test(record.name) ? 'application/pdf' : 'application/octet-stream' }),
      sourceSha256: actualHash });
  }
  for (const file of files) if (file.status === 'duplicate') {
    const original = files.find(f => f.id === file.duplicateOf);
    if (!original || original.id === file.id || original.status !== 'parsed' || original.sourceSha256 !== file.sourceSha256) invalid();
  }
  const selected = settings.selected === null || ids.has(settings.selected) ? settings.selected : files[0].id;
  return { files, options: { language: settings.language, theme: settings.theme, numeric: settings.numeric, deduplicate: settings.deduplicate, selected } };
}
