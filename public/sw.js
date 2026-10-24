const CACHE = 'pdf-statement-batch-preview-1';
const base = new URL('./', self.location.href);
const assets = ['./', './app.js', './style.css', './core.js', './xlsx.js', './i18n.js', './worker.js', './vendor/fflate.js', './vendor/extract_text.py', './vendor/pdfminer_six-20260107-py3-none-any.whl', './vendor/source.json', './vendor/LICENSE-localbankstatementconverter.txt', './vendor/LICENSE-fflate.txt', './vendor/parsers/base-parser.js', './vendor/parsers/generic-parser.js', './vendor/parsers/position-parser.js', './vendor/parsers/rectangle-parser.js', './samples/synthetic-ruled.pdf', './samples/synthetic-borderless.pdf'];
self.addEventListener('install', event => event.waitUntil((async () => {
  await (await caches.open(CACHE)).addAll(assets.map(path => new URL(path, base).href));
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('pdf-statement-batch-preview-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const local = url.origin === base.origin && url.pathname.startsWith(base.pathname);
  const runtime = url.origin === 'https://cdn.jsdelivr.net' && url.pathname.startsWith('/pyodide/v0.29.3/full/');
  if (event.request.method !== 'GET' || (!local && !runtime)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const request = event.request.mode === 'navigate' ? new Request(base.href) : event.request;
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok || response.type === 'opaque') await cache.put(request, response.clone());
    return response;
  })());
});
