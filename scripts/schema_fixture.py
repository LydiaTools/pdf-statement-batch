from pathlib import Path
from reportlab.pdfgen import canvas

out = Path(__file__).resolve().parents[1]/'work/failure-fixtures/amount-only.pdf'
doc = canvas.Canvas(str(out), invariant=1)
doc.setFont('Helvetica', 11)
doc.drawString(45, 750, 'SYNTHETIC DIFFERENT COLUMN TEST')
doc.drawString(45, 720, 'Currency: EUR | Dates: MM/DD/YYYY')
doc.drawString(45, 680, 'Date')
doc.drawString(180, 680, 'Description')
doc.drawRightString(520, 680, 'Amount')
doc.drawString(45, 645, '10/09/2026')
doc.drawString(180, 645, 'SYNTHETIC FEE')
doc.drawRightString(520, 645, '2.50')
doc.save()
print(str(out))
