"""Check the actual browser-generated synthetic workbook."""
from openpyxl import load_workbook
sheet=load_workbook('test-results/position-fixture.xlsx',data_only=False)['Transactions 1']
rows=list(sheet.values)
assert rows[0][-1]=='amount'
values=[r[-1] for r in rows[1:]]
assert values[:3]==['25.20-','(25.20)',0]
assert values[3] in ('',None)
assert '1234567890123456.78' in rows[4][-2]
print('Independent workbook read: exact two signed text amounts, numeric zero, and one flagged empty amount.')
