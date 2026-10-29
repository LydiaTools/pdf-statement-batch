export const STATUSES = ['queued', 'processing', 'parsed', 'failed', 'canceled', 'duplicate'];

export function inputError(file) {
  if (!/\.pdf$/i.test(file.name)) return 'unsupported';
  return file.size > 50 * 1024 * 1024 ? 'fileLimit' : '';
}

export function explicitCurrency(text) {
  const found = [...String(text).matchAll(/\bCurrency\s*[:=]\s*([A-Z]{3})\b/g)].map(m => m[1]);
  return [...new Set(found)].length === 1 ? found[0] : '';
}

export function groupKey(file) {
  // Unconfirmed currencies stay separate, even when the column names match.
  return JSON.stringify([file.headers, file.currency || `unconfirmed:${file.id}`]);
}

export function groups(files) {
  const map = new Map();
  for (const file of files.filter(f => f.status === 'parsed')) {
    const key = groupKey(file);
    if (!map.has(key)) map.set(key, { headers: file.headers, currency: file.currency, files: [] });
    map.get(key).files.push(file);
  }
  return [...map.values()];
}

export function numericValue(value) {
  // Retain ambiguous formats, currency suffixes and >15-digit values as text.
  const s = String(value ?? '').trim();
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(s)) return null;
  const normalized = s.replaceAll(',', '');
  if (normalized.replace(/[-.]/g, '').replace(/^0+/, '').length > 15) return null;
  if (/^-?0\d/.test(normalized)) return null;
  return normalized;
}

export function moneyHeader(header) {
  return /^(debit|credit|balance|amount|withdrawals?|deposits?|paid in|paid out)$/i.test(header.trim());
}

export function tableCell(value, header) {
  const text = String(value ?? '');
  const n = moneyHeader(header) ? numericValue(text) : null;
  return n === null ? { text } : { number: n };
}

export function workbookSheets(files, language = 'en') {
  const zh = language === 'zh';
  const data = groups(files).map((group, i) => ({
    name: `Transactions ${i + 1}`,
    rows: [
      ['Source file', 'Source row', 'Currency', 'Reviewed', ...group.headers].map(text => ({ text })),
      ...group.files.flatMap(file => file.rows.map((row, index) => [
        { text: file.name }, { number: String(index + 1) }, { text: file.currency || 'Unconfirmed' },
        { text: file.reviewed ? 'Yes' : 'No' }, ...group.headers.map(h => tableCell(row[h], h))
      ]))
    ]
  }));
  const accounting = {
    name: 'Files', rows: [
      ['Queue ID', 'File', 'Status', 'Rows', 'Currency', 'Reviewed', 'Duplicate of', 'Detail', 'SHA-256'].map(text => ({ text })),
      ...files.map(f => [
        { number: String(f.id) }, { text: f.name }, { text: f.status }, { number: String(f.rows?.length || 0) },
        { text: f.currency || 'Unconfirmed' }, { text: f.reviewed ? 'Yes' : 'No' },
        { text: f.duplicateOf ? String(f.duplicateOf) : '' }, { text: f.error || '' }, { text: f.hash || '' }
      ])
    ]
  };
  const notes = {
    name: 'Read me', rows: [
      ['PDF Statement Batch', zh ? '对账单合表' : 'Batch statement review'].map(text => ({ text })),
      ...[
        ['Exported at (UTC)', new Date().toISOString()],
        ['Source precision', 'Source filename and extracted row order. Exact PDF page/coordinates are not supplied by this parser.'],
        ['Review', 'Extraction is not accounting verification. Review source PDFs and extracted rows.'],
        ['Dates', 'Original text; no date locale is inferred or converted.'],
        ['Numbers', 'Unambiguous amounts with at most 15 significant digits use numeric cells. Other values remain text.'],
        ['Text safety', 'All text cells are literal strings, including text beginning with =, +, - or @.'],
        ['Groups', 'One transaction sheet per header/currency group. Unconfirmed currency files remain separate.'],
        ['File accounting', 'Files contains every selected file, including failures, cancellations and exact duplicates.'],
        ['Parser attribution', 'PriyanshuDangi/localbankstatementconverter, MIT, commit 6a25c6fb1ec720bc8444e529fe004cc779ce1d5a'],
        ['Workflow', 'LydiaTools. No upload or AI provider is used to process these files.']
      ].map(row => row.map(text => ({ text })))
    ]
  };
  return [...data, accounting, notes];
}

// Only fixed diagnostic categories and counts may leave the tab through this export.
export function failureDiagnostic(file, files) {
  if (!file || file.status !== 'failed') return null;
  const allowed = new Set(['unsupported', 'fileLimit', 'invalid', 'encrypted', 'noText', 'noRows', 'pdfTimeout']);
  const category = allowed.has(file.errorKey) ? file.errorKey : 'unknown';
  const count = Array.isArray(files) ? files.filter(item => item?.status === 'failed').length : 0;
  return { schema: 'pdf-statement-batch-diagnostic-v1', app_version: '0.2.1', category, failed_count: count };
}

// These observations are not an accuracy or completeness check.
export function dateObservations(headers, rows) {
  const names = new Set(['date','transaction date','trans date','post date','posting date','posted date','value date','日期','交易日期','入账日期']);
  const dates = (Array.isArray(headers) ? headers : []).filter(h => typeof h === 'string' && names.has(h.trim().toLowerCase().replace(/[_\s]+/g, ' ')));
  if (!dates.length) return {kind:'no-date-column', count:0};
  const empty = (Array.isArray(rows) ? rows : []).filter(row => dates.every(h => String(row?.[h] ?? '').trim() === '')).length;
  return {kind:empty ? 'empty-date-rows' : 'none', count:empty};
}

// The text-based fallback uses lowercase object keys under these three display headers.
export function mapTransactionRows(parsed) {
  const headers = parsed.headers;
  const textFallback = parsed.metadata?.parserType === 'text-based';
  if (textFallback && !(headers.length === 3 && headers[0] === 'Date' && headers[1] === 'Description' && headers[2] === 'Amount')) {
    throw new Error('Unsupported text-based fallback schema');
  }
  const aliases = {Date:'date', Description:'description', Amount:'amount'};
  return parsed.transactions.map(row => Object.fromEntries(headers.map(h => {
    if (textFallback && h === 'Amount') return [h, ''];
    const hasExact = Object.prototype.hasOwnProperty.call(row, h);
    const value = hasExact ? row[h] : textFallback ? row[aliases[h]] : undefined;
    return [h, String(value ?? '')];
  })));
}

// Unknown parser metadata cannot establish how amounts were derived.
export function classifyParserMode(parsed) {
  const mode = parsed?.metadata?.parserType;
  return mode === 'text-based' ? 'text-based' : ['rectangle-based', 'position-based'].includes(mode) ? 'other' : 'unknown';
}
