import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTableToTransactions, POSITION_RAW_CELLS } from '../src/vendor/parsers/position-parser.js';
import { mapTransactionRows, classifyParserMode, workbookSheets } from '../src/core.js';
import { writeWorkbook } from '../src/xlsx.js';
import { unzipSync, strFromU8 } from '../src/vendor/fflate.js';

for (const header of ['amount', 'Amount', 'balance', 'Balance']) {
  for (const input of ['25.20-', '(25.20)', '0.00', '1234567890123456.78']) {
    test(`position ${header}: retain ${input} as source text`, () => {
      const columns = ['Date', 'Description', header].map((name, index) => ({ name, index }));
      const cells = ['01/01/2026', 'Synthetic', input].map(text => [{ text }]);
      const transactions = parseTableToTransactions([{ cells }], columns);
      assert.equal(transactions.length, 1);
      const parsed = { headers: columns.map(x => x.name), transactions, metadata: { parserType: 'position-based' } };
      const mapped = mapTransactionRows(parsed);
      assert.equal(mapped[0][header], input);
      assert.equal(classifyParserMode(parsed), 'other');
      assert.equal(typeof transactions[0][header.toLowerCase()], 'number');
      assert.equal(JSON.stringify(transactions[0]).includes('position-raw-cells'), false);
      assert.equal(Object.keys(transactions[0]).includes('POSITION_RAW_CELLS'), false);
      const file = { id:1, name:'fictional.pdf', status:'parsed', headers:parsed.headers, rows:mapped, currency:'USD', reviewed:false };
      const xml = strFromU8(unzipSync(writeWorkbook(workbookSheets([file])))['xl/worksheets/sheet1.xml']);
      assert(xml.includes(input), 'workbook must preserve original text or exact numeric representation');
    });
  }
}

test('a missing raw provenance cannot silently export an already-rounded alias', () => {
  const p = { headers:['amount'], transactions:[{amount:1234567890123456.8}], metadata:{parserType:'position-based'} };
  assert.equal(mapTransactionRows(p)[0].amount, '');
  assert.equal(classifyParserMode(p), 'unknown');
  assert.equal(POSITION_RAW_CELLS.description, 'position-raw-cells');
});

test('empty amount observations do not judge the source or treat zero as empty', async () => {
  const { emptyAmountObservations } = await import('../src/core.js');
  assert.equal(emptyAmountObservations(['$ Amount'], [{'$ Amount':''},{'$ Amount':'0.00'},{'$ Amount':'25.20-'}]), 1);
  assert.equal(emptyAmountObservations(['Debit','Credit'], [{Debit:'',Credit:'10.00'}, {Debit:'0',Credit:''}, {Debit:'',Credit:''}]), 1);
  assert.equal(emptyAmountObservations(['Balance'], [{Balance:''}]), 0);
  assert.equal(emptyAmountObservations(['Description'], [{Description:''}]), 0);
});

test('lowercase date and description retain extracted cell text without changing standardized aliases', () => {
  const columns = ['date','description','amount','balance'].map((name,index)=>({name,index}));
  const cells = ['01/01/2026','Synthetic   Detail','25.20-','1234567890123456.78'].map(text=>[{text}]);
  const transactions = parseTableToTransactions([{cells}],columns);
  assert.equal(transactions[0].description,'Synthetic Detail');
  assert.equal(typeof transactions[0].amount,'number');
  const result=mapTransactionRows({headers:columns.map(x=>x.name),transactions,metadata:{parserType:'position-based'}});
  assert.deepEqual(result[0],{date:'01/01/2026',description:'Synthetic   Detail',amount:'25.20-',balance:'1234567890123456.78'});
  assert.equal(Object.getOwnPropertySymbols(transactions[0]).length,1);
  assert.equal(Object.keys(transactions[0]).length,4);
});
