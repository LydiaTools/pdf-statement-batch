// PDF extraction runs in a disposable worker. User PDF bytes never leave it.
const CDN = 'https://cdn.jsdelivr.net/pyodide/v0.29.3/full/';
let runtime;
let initialization;
async function initialize() {
  if (!initialization) initialization = (async () => {
    postMessage({ progress: 'runtime' });
    importScripts(CDN + 'pyodide.js');
    runtime = await loadPyodide({ indexURL: CDN });
    postMessage({ progress: 'libraries' });
    await runtime.loadPackage(['micropip', 'cryptography', 'charset-normalizer']);
    const wheel = new URL('./vendor/pdfminer_six-20260107-py3-none-any.whl', self.location.href).href;
    runtime.globals.set('wheel_url', wheel);
    await runtime.runPythonAsync('import micropip\nawait micropip.install(wheel_url, deps=False)\ndel wheel_url');
    const response = await fetch('./vendor/extract_text.py');
    if (!response.ok) throw new Error('Extraction library could not be loaded');
    await runtime.runPythonAsync(await response.text());
    postMessage({ progress: 'ready' });
  })();
  return initialization;
}
self.onmessage = async ({ data }) => {
  const { id, bytes } = data;
  try {
    await initialize();
    if (!bytes) { postMessage({ id, ready: true }); return; }
    runtime.globals.set('_statement_bytes', new Uint8Array(bytes));
    const encoded = await runtime.runPythonAsync(`
import json
_raw = bytes(_statement_bytes)
from pdfminer.pdfdocument import PDFDocument
from pdfminer.pdfparser import PDFParser
try:
    PDFDocument(PDFParser(io.BytesIO(_raw)))
    _result = extract_with_positions(_raw)
except Exception as _failure:
    _result = {'success': False, 'error': type(_failure).__name__ + ': ' + str(_failure)}
if _result['success']:
    _graphics = extract_rectangles_and_lines(_raw)
    _result.update({k: _graphics[k] for k in ['rectangles', 'horizontal_lines', 'vertical_lines']})
    _result['graphics_error'] = _graphics['error']
_encoded = json.dumps(_result)
del _raw, _result, _statement_bytes
_encoded
`);
    // json avoids retaining PyProxy references for each PDF in a large queue.
    runtime.runPython("globals().pop('_graphics', None); globals().pop('_encoded', None)");
    postMessage({ id, result: JSON.parse(encoded) });
  } catch (error) {
    postMessage({ id, error: String(error.message || error) });
  }
};
