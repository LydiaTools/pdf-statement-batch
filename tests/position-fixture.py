"""Create an original fictional three-column PDF; no personal data."""
from pathlib import Path
from reportlab.pdfgen import canvas
out=Path('test-results/position-fixture.pdf');out.parent.mkdir(parents=True,exist_ok=True)
c=canvas.Canvas(str(out),pagesize=(612,792));c.setFont('Helvetica',10)
for x,text in [(40,'Date'),(160,'Description'),(420,'amount')]:c.drawString(x,710,text)
for i,(date,desc,amount) in enumerate([('01/01/2026','Synthetic A','25.20-'),('02/01/2026','Synthetic B','(25.20)'),('03/01/2026','Synthetic C','0.00'),('04/01/2026','Synthetic D','1234567890123456.78')]):
 for x,text in [(40,date),(160,desc),(420,amount)]:c.drawString(x,680-i*22,text)
c.save()
