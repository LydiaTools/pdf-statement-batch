# Failure diagnostic

Select a failed file and choose **Download diagnostic**. The JSON contains only a fixed format ID, the `0.2.2` version, a fixed error category, and the failed-file count. It does not include names, hashes, PDFs, transactions, free-form exceptions, exact sizes, page counts or timestamps. Unknown categories become `unknown`.

Downloading does not send data. This is not a redacted statement and contains no reproducible layout. A user-created fictional sample may still be needed to debug parsing. The v0.2.2 preview includes this feature; the fixed v0.2.0 package does not.

If the parser runtime fails to initialize, files remain queued and this per-file button is not shown. Retry initialization first; this preview does not export a runtime-initialization diagnostic.

## Reproduce the browser checks

Run `npm test`, `node scripts/build.mjs`, then `node tests/diagnostic-browser.mjs`. The latter uses a synthetic worker and files; it writes screenshots to ignored `test-results/`. To exercise the real parser instead, set `REAL_PARSER=1`; downloading its pinned Pyodide runtime needs network access. `node tests/diagnostic-init-failure.mjs` simulates an initialization failure, then retries with the real worker and also needs network access.

For the optional cache-upgrade experiment, build commit `2ea221e404aadd8669a3b64786d2b4ba813ea91d` in a separate checkout. Set `OLD_DIST` to its absolute `dist` directory and run `node tests/diagnostic-sw-browser.cjs` after building the current checkout. It warms the old runtime online, updates the service worker, then disconnects and parses two fictional PDFs. A successful warm-cache experiment does not establish cold-offline support. Set `CHROME_PATH`, `PLAYWRIGHT_MODULE` or `BROWSER_PROXY` only if needed by your environment.
