# 日期观察与文本回退金额

预览版会提示未识别日期列，或统计所有已识别日期列均为空的行数。这只是需对照原 PDF 核查的事实，不证明交易遗漏或提取准确。支持 `Date`、`Transaction Date`、`Trans Date`、`Post Date`、`Posting Date`、`Posted Date`、`Value Date` 和常见中文日期表头；其他有效表头可能无法识别。修改日期并离开输入框后，计数会更新；导出仍可使用。

解析器的文本回退会先将金额转为数字，可能改变前置负号或精度。因此这一回退下保留日期和描述，金额留空，由用户从 PDF 填写。未知解析模式不改写内容，只提醒核对金额。打开已保存批次不会改写金额；未记录解析方式的旧批次会显示核对提醒。旧版软件能打开带新字段的批次，但不会显示新提示。

本机测试使用 [Bankstatemently 的 MIT 许可虚构账单](https://github.com/bankstatemently/bank-statement-parsing-benchmark/tree/2d8d31d68dcedbf9028b87f6c7df286f53a6c7de)。样本 001 第 2 页印有 12 笔交易，旧版源码返回 3 条账户汇总且未识别日期列；样本 002 的公开元数据标 15 笔交易，旧版返回 30 行，其中 15 行所有已识别日期列均为空。预览版展示这些观察，并未修复两种版式。两例不构成完整基准、准确率或排行榜，本仓库不包含这些 PDF。

## 两份外部虚构样本

我们检查了 [bank-statement-parsing-benchmark](https://github.com/bankstatemently/bank-statement-parsing-benchmark/tree/2d8d31d68dcedbf9028b87f6c7df286f53a6c7de) 固定提交中的两份公开虚构账单（MIT；[许可](https://github.com/bankstatemently/bank-statement-parsing-benchmark/blob/2d8d31d68dcedbf9028b87f6c7df286f53a6c7de/LICENSE)）。本仓库不包含这两份 PDF 或其交易行。

| 样本 | PDF SHA-256 | 元数据预期 | 实际提取 |
| --- | --- | --- | --- |
| [bsb-001](https://raw.githubusercontent.com/bankstatemently/bank-statement-parsing-benchmark/2d8d31d68dcedbf9028b87f6c7df286f53a6c7de/datasets/basic/bsb-001/bsb-001-statement.pdf) | `d3d5071b90a33272f31bab5c5660d78b2ae29d2c6e1720477f5e8b167f73e843` | 12 笔 | 3 行汇总信息 |
| [bsb-002](https://raw.githubusercontent.com/bankstatemently/bank-statement-parsing-benchmark/2d8d31d68dcedbf9028b87f6c7df286f53a6c7de/datasets/basic/bsb-002/bsb-002-statement.pdf) | `3700a073ac1262173cbabbd5667cd3a59e04cf0b14e3a865ae25ce21089ab97d` | 15 笔 | 30 行，包含无日期续行 |

日期观察提示只显示无日期这一症状，并未修复这两种版式，也不能证明交易完整。两个样本不能代表整体准确率或排名。

另一份虚构三列位置版式中，普通金额列的尾随负号、括号和零值文本得以保留，但一项极高精度金额被分配到描述列、金额单元为空。空金额提示只显示这一可见现象，不能修复版式，也不证明其他文件的精度。
