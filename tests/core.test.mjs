import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numericValue, explicitCurrency, workbookSheets, groups, inputError } from '../src/core.js';
import { writeWorkbook } from '../src/xlsx.js';
import { unzipSync, strFromU8 } from '../src/vendor/fflate.js';
test('the same file boundary applies before initial extraction and retries', () => {
  assert.equal(inputError({name:'statement.pdf',size:50*1024*1024}), '');
  assert.equal(inputError({name:'statement.pdf',size:50*1024*1024+1}), 'fileLimit');
  assert.equal(inputError({name:'statement.txt',size:3}), 'unsupported');
});
test('ambiguous dates, locales and high precision remain text', () => {
  for (const value of ['1.234,56', '12,34', '000123', '1234567890123456.78', '=HYPERLINK("x")', '12 USD']) assert.equal(numericValue(value), null);
  assert.equal(numericValue('1,234.56'), '1234.56'); assert.equal(numericValue('0.09'), '0.09'); assert.equal(numericValue('-12.30'), '-12.30');
  assert.equal(explicitCurrency('Currency: USD'), 'USD'); assert.equal(explicitCurrency('$ 123.45'), ''); assert.equal(explicitCurrency('Currency: USD Currency: EUR'), '');
});
const file = (id, currency, headers = ['Date','Description','Debit']) => ({ id, name: `source-${id}.pdf`, currency, headers, status:'parsed', reviewed:false, rows:[{Date:'01/02/2026',Description:'=1+1',Debit:'0.09'}] });
test('schemas and currencies separate, unknown currency files never merge', () => {
  assert.equal(groups([file(1,'USD'),file(2,'USD')]).length, 1);
  assert.equal(groups([file(1,'USD'),file(2,'EUR'),file(3,''),file(4,'')]).length, 4);
  assert.equal(groups([file(1,'USD'),file(2,'USD',['Date','Amount'])]).length, 2);
});
test('actual workbook keeps literal formulas, raw dates and every file status', () => {
  const cases = [file(1,'USD'), ...['failed','canceled','duplicate','queued'].map((status, i) => ({...file(i+2,''),status,rows:[]}))];
  const sheets = workbookSheets(cases);
  assert.equal(sheets.find(s=>s.name==='Files').rows.length, 6);
  const zip = unzipSync(writeWorkbook(sheets));
  const xml = strFromU8(zip['xl/worksheets/sheet1.xml']);
  assert.match(xml, /t="inlineStr"><is><t xml:space="preserve">=1\+1<\/t>/);
  assert.match(xml, /t="inlineStr"><is><t xml:space="preserve">01\/02\/2026<\/t>/);
  assert.match(xml, /<c r="G2" s="1"><v>0\.09<\/v>/); assert(!xml.includes('<f>'));
});

test('failure diagnostics use a fixed allowlist and never serialize file data', async () => {
  const { failureDiagnostic } = await import('../src/core.js');
  const secret = 'PRIVATE_SENTINEL_8791';
  const file = {status:'failed', errorKey:'invalid', name:secret, hash:secret, error:secret, rows:[{account:secret}], headers:[secret], size:123456, pages:7};
  const result = failureDiagnostic(file, [file,{status:'failed',errorKey:secret},{status:'parsed',name:secret}]);
  assert.deepEqual(result, {schema:'pdf-statement-batch-diagnostic-v1',app_version:'0.2.1',category:'invalid',failed_count:2});
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL|123456|account|pages|name|hash/);
  assert.equal(failureDiagnostic({ ...file, errorKey:secret }, [file]).category, 'unknown');
  assert.equal(failureDiagnostic({status:'queued'}, []), null);
  assert.equal(failureDiagnostic({status:'parsed'}, []), null);
  assert.equal(failureDiagnostic(null, []), null);
});
