# Date observations and text-fallback amounts

The preview flags a missing recognized date column or counts rows whose recognized date columns are all empty. These are observations to compare with the original PDF, not proof of missing transactions or extraction accuracy. Supported headings are `Date`, `Transaction Date`, `Trans Date`, `Post Date`, `Posting Date`, `Posted Date`, `Value Date` and common Chinese date headings. Other valid headings may not be recognized. Editing a date and leaving the cell updates the count; export remains available.

The parser's text-based fallback converts amounts to numbers and can alter leading minus signs or precision. On this fallback, the preview retains dates and descriptions but leaves amounts blank for the user to enter from the PDF. Unknown parser modes are not changed, and show a reminder to check amounts. Existing saved batches are never rewritten on open; batches without a recorded parser mode show the reminder. Older app versions can open the added metadata but do not show this new warning.

Two locally tested fictional statements are supplied by [Bankstatemently's MIT-licensed dataset](https://github.com/bankstatemently/bank-statement-parsing-benchmark/tree/2d8d31d68dcedbf9028b87f6c7df286f53a6c7de). Sample 001 printed 12 transactions on page 2 while the previous source returned 3 account-summary rows and no recognized date column. Sample 002's metadata says 15 transactions; the previous source returned 30 rows, 15 without a value in either recognized date column. The preview reports these observations; it does not fix either layout. These two cases are not a full benchmark, accuracy rate or leaderboard entry. The statement PDFs are not included here.

## Two external synthetic samples

Two publicly available fictional statements were inspected from [bank-statement-parsing-benchmark](https://github.com/bankstatemently/bank-statement-parsing-benchmark/tree/2d8d31d68dcedbf9028b87f6c7df286f53a6c7de) (MIT; [license](https://github.com/bankstatemently/bank-statement-parsing-benchmark/blob/2d8d31d68dcedbf9028b87f6c7df286f53a6c7de/LICENSE)). Their PDFs and transaction rows are not included here.

| Sample | PDF SHA-256 | Metadata expectation | Observed extraction |
| --- | --- | --- | --- |
| [bsb-001](https://raw.githubusercontent.com/bankstatemently/bank-statement-parsing-benchmark/2d8d31d68dcedbf9028b87f6c7df286f53a6c7de/datasets/basic/bsb-001/bsb-001-statement.pdf) | `d3d5071b90a33272f31bab5c5660d78b2ae29d2c6e1720477f5e8b167f73e843` | 12 transactions | 3 extracted rows, representing summary information |
| [bsb-002](https://raw.githubusercontent.com/bankstatemently/bank-statement-parsing-benchmark/2d8d31d68dcedbf9028b87f6c7df286f53a6c7de/datasets/basic/bsb-002/bsb-002-statement.pdf) | `3700a073ac1262173cbabbd5667cd3a59e04cf0b14e3a865ae25ce21089ab97d` | 15 transactions | 30 extracted rows, including continuation rows without dates |

The date observation makes a missing-date symptom visible; it does not repair either layout or verify that all transactions were found. These two cases are neither an overall accuracy benchmark nor a ranking.

An additional fictional three-column position-layout test retained the text in the ordinary amount column for a trailing minus, parentheses and zero, but assigned an extreme-precision amount to the description and left its amount cell empty. The empty-amount observation reports this visible symptom; it does not repair the layout or prove precision for other files.
