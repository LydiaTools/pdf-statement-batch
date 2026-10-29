# 失败诊断

选择失败的文件后，点击「下载诊断」。JSON 只包含固定格式标识、`0.2.1` 版本标识、固定错误类别和当前失败项数量。它不包含文件名、文件哈希、原始 PDF、交易内容、自由异常信息、精确文件大小、页数或时间。未知类别统一显示 `unknown`。

下载不会发送数据。此文件不是脱敏账单，不含可复现布局；排查解析问题仍可能需要用户自行制作虚构样例。v0.2.1 预览版包含此功能，固定发行版 v0.2.0 不包含。

如果解析环境初始化失败，文件仍处于待处理状态，不会显示此单文件按钮。请先重试初始化；此预览不导出初始化失败的诊断。

## 复现浏览器检查

运行 `npm test`、`node scripts/build.mjs` 和 `node tests/diagnostic-browser.mjs`。浏览器检查使用合成 worker 和文件，截图写入 Git 忽略的 `test-results/`。设置 `REAL_PARSER=1` 可改用真实解析器；首次下载固定版本的 Pyodide 需要联网。`node tests/diagnostic-init-failure.mjs` 模拟初始化失败后用真实 worker 重试，同样需要联网。

如需复现可选的缓存升级实验，请在单独检出中构建提交 `2ea221e404aadd8669a3b64786d2b4ba813ea91d`，将 `OLD_DIST` 设置为该检出的 `dist` 绝对路径，再构建当前检出并运行 `node tests/diagnostic-sw-browser.cjs`。实验先联网预热旧运行时，再更新 service worker、断网重载并解析两份虚构 PDF；预热缓存成功不代表冷启动可离线。按环境需要设置 `CHROME_PATH`、`PLAYWRIGHT_MODULE` 或 `BROWSER_PROXY`。
