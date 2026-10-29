import {test} from 'node:test';import assert from 'node:assert/strict';import {dateObservations} from '../src/core.js';
test('Only recognized date headings and all-date-empty rows are counted',()=>{
 assert.deepEqual(dateObservations(['Account','Balance'],[{Account:'a'}]),{kind:'no-date-column',count:0});
 assert.deepEqual(dateObservations(['Post Date','Trans Date'],[{'Post Date':'','Trans Date':'09/01'},{'Post Date':' ','Trans Date':null},{'Post Date':0,'Trans Date':''}]),{kind:'empty-date-rows',count:1});
 assert.deepEqual(dateObservations(['交易日期'],[{'交易日期':'2026-01-01'}]),{kind:'none',count:0});
 assert.deepEqual(dateObservations(['Update','Updated At'],[{'Update':'date'}]),{kind:'no-date-column',count:0});
 const rows=[{Date:''}];assert.equal(dateObservations(['Date'],rows).count,1);rows[0].Date='01/01';assert.equal(dateObservations(['Date'],rows).kind,'none');
});
