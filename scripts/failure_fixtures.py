from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.pdfencrypt import StandardEncryption
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
out = root/'work/failure-fixtures'
out.mkdir(parents=True, exist_ok=True)
image = Image.new('RGB', (700, 400), 'white')
draw = ImageDraw.Draw(image)
draw.text((30, 40), 'SYNTHETIC IMAGE ONLY - NO TEXT LAYER', fill='black')
doc = canvas.Canvas(str(out/'scan.pdf'), invariant=1)
doc.drawImage(ImageReader(image), 30, 350, width=500, height=280)
doc.save()
doc = canvas.Canvas(str(out/'locked.pdf'), encrypt=StandardEncryption('synthetic-only'), invariant=1)
doc.drawString(50, 700, 'SYNTHETIC PASSWORD TEST')
doc.save()
(out/'broken.pdf').write_bytes(b'%PDF-1.7\nThis is a deliberately invalid synthetic input.\n')
(out/'wrong.txt').write_text('Not a PDF; synthetic input only.\n')
print('Created two original PDF failure fixtures and two invalid input files')
