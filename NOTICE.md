# Attribution

PDF Statement Batch's batch queue, bilingual interface, review controls, file accounting, workbook writer, cache behavior and original synthetic test materials are by LydiaTools.

The PDF layout extractor and four JavaScript parser modules are adapted from [PriyanshuDangi/localbankstatementconverter](https://github.com/PriyanshuDangi/localbankstatementconverter/tree/6a25c6fb1ec720bc8444e529fe004cc779ce1d5a), commit `6a25c6fb1ec720bc8444e529fe004cc779ce1d5a`, under the MIT license. Copyright (c) 2026 Priyanshu Dangi. The complete original license is in `src/vendor/LICENSE-localbankstatementconverter.txt`, and file hashes are in `src/vendor/source.json`. The position parser has a local modification to retain raw text for lower-case standardized columns; the remaining vendored parser and extractor files are unmodified. This project is not an upstream endorsement or a wholly original PDF parser.

ZIP compression uses fflate 0.8.3, MIT; the original license is in `src/vendor/LICENSE-fflate.txt`.

The included pdfminer.six 20260107 wheel comes from its PyPI release, SHA-256 `366585ba97e80dffa8f00cebe303d2f381884d8637af4ce422f1df3ef38111a9`. Its distribution includes its own MIT license and bundled third-party notices. We do not reuse upstream users' financial documents.

Pyodide 0.29.3 and its locked cryptography, charset-normalizer and supporting packages load from the version-pinned jsDelivr distribution at first use. They are not bundled in this repository. See [Pyodide licensing](https://pyodide.org/en/0.29.3/project/about.html#license). No AI provider or paid API is required for parsing.
