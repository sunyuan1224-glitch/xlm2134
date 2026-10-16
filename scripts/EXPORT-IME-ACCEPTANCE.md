# 导出与输入法验收（开发记录，不修改作品）

> **说明：** 本文是精简之前那一版的验收记录（当时还有表格 / 公式 / 图表 / 打印导出）。
> 公式、图表、表格、任务框渲染与 HTML / PDF 导出已于本次精简中移除，下文提到它们的条目只作为历史，
> 当前实现与限制请以 `README.md` 与应用内「关于 MyNovel」为准。
> 输入法部分（组合态避让、候选窗、提交不丢字）与本次精简无关，结论仍然有效。

## 环境盘点

本轮检查环境为 Wayland，`fcitx5-remote -n` 返回 `rime`、状态为 `2`。
GTK3 为 3.24.52，WebKitGTK 4.1 为 2.52.6，fcitx5-gtk 为 5.1.7。
`GTK_IM_MODULE` 未显式设置；GTK 探针实际选择 `wayland`，系统也已安装 fcitx GTK3 模块。
这不等于输入法故障：Wayland text-input 路径可能正常工作。没有改写环境变量或用户输入法配置。

自动 Unicode 文本事务、合成 composition 事件只能检查编辑器状态与 DOM 稳定性，
不能证明真实 Rime 预编辑串、候选窗定位、选词提交均正常。必须完成下列真人验收后再宣称 IME 完整通过。

## 真人 IME 验收清单

只在新建的临时测试工作区中进行，不使用真实小说：

1. 即时预览和源码模式各输入一段中文，连续选词、翻页选词、数字键选词、Enter 提交和 Escape 取消。
2. 在标题、表格、任务列表、嵌套引用、代码围栏边界输入；候选窗应跟随真实光标，不能跳到页面左上角。
3. 在打字机模式中开始组合后等待一拍，确认没有滚动把候选窗移走；提交后继续输入。
4. 组合中切换源码模式、选区、打开/关闭菜单和沉浸模式；不得重复提交、丢字或覆盖新输入。
5. 提交后撤销/重做、移动光标再输入；检查源文是否逐字保持正确。
6. 切换中英文与窗口焦点后重复检查。记录所用桌面合成器、输入法、实际 GTK frontend。

如果 Wayland 路径失败，可由用户决定在**单独隔离测试进程**尝试 `GTK_IM_MODULE=fcitx`；
不得直接改写用户全局环境、重启现有应用或输入法来掩盖问题。

## DOCX / EPUB 依赖审查（已实施，2026-10-06 更新）

> 本节此前写的是「当前项目没有 DOCX / EPUB / ZIP 写出依赖」——那是安装前的状态，已过时。
> 现在是**实际安装并已落地实现**的记录，含来源、版本、许可、生命周期脚本与漏洞状态。

已安装（用户授权后执行，`npm install --save --ignore-scripts docx fflate`）：

| 包 | 版本 | 许可 | 来源 | 生命周期脚本 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `docx` | 9.8.1（`^9.8.1`） | MIT | registry.npmmirror.com（本机 npm registry） | 无 `preinstall`/`install`/`postinstall`；仅有 `build`/`test`/`demo` 等开发脚本，且已用 `--ignore-scripts` 保证不执行 | 生成真实 Office Open XML（`word/document.xml` 等）DOCX 容器 |
| `fflate` | 0.8.3（`^0.8.3`） | MIT | 同上 | 无安装钩子（仅 `prepack` 打包脚本），同样未执行 | EPUB 的 ZIP/OCF 容器打包与解包（测试用） |

传递依赖（`docx` 引入，npm 已锁定在 `package-lock.json`）：`xml@1.0.1`、`jszip@3.10.1`、
`nanoid@6.x`、`xml-js`、`hash.js`、`@types/node`（后者是 `docx` 的运行时依赖声明，
本机 TypeScript 已确认无类型冲突）。均为通用工具库；`fflate` **零依赖**。

漏洞扫描：

- `npm audit` 打在默认镜像（npmmirror）上不受支持：`[NOT_IMPLEMENTED] /-/npm/v1/security/*`。
  改用官方公告源复核：`npm audit --registry=https://registry.npmjs.org`。
- 结果：**本次新增的 `docx` / `fflate` 本身没有任何告警**；全树只有 2 条 low，
  来自 mermaid 内置的旧版 katex（`GHSA-238p-pmpm-9mq7`，原型污染绕过 `trust` 限制），
  与本轮导出实现无关，且 `npm audit` 给出的修复方式是降级 mermaid（破坏性变更），本轮不动。

系统里没有 Pandoc / LibreOffice / wkhtmltopdf / epubcheck；因此**没有**用第三方转换器生成或验证产物。
验证手段是：`zipfile`（ZIP 结构与 all-XML 可解析）、`xmllint`（libxml2 独立解析）、
自写的容器结构断言（见下）。HTML 改扩展名伪装格式的做法已被彻底排除：
DOCX 走 OOXML 部件，EPUB 走 OCF（`mimetype` 首项 + 不压缩 + `META-INF/container.xml` + OPF）。

已知限制（不隐瞒）：

1. 公式在 DOCX 里降级为 TeX 原文（`［公式：…］`），不生成 OMML；EPUB 里同样保留 TeX 源码。
2. mermaid 图表在 EPUB 里以 SVG 资源嵌入；DOCX 里先用 canvas 转 PNG，
   转不了（例如无 DOM 环境、画布被污染）则降级为文字并给警告。
3. 复杂块源码回退（`div.md-source-fallback`）在两种格式里都**原样保留源码**并附中文提示与警告。
4. DOCX 未在真实 Word/WPS 里做人工打开验收（本机无 Office/LibreOffice）；
   结构正确性由 OOXML 部件检查 + XML 解析保证，最终观感需人工确认。
5. Python/xmllint 只能证明「文件能被独立解析器读出来」，不等于「Word 排版一定如预期」。

测试入口：

```
node scripts/test-docx-epub.mjs          # 中间层 + DOCX + EPUB 结构与行为测试
node scripts/test-export-external.mjs    # 用 python3 zipfile + xmllint 做外部合规性体检
npm run test:vault   # 含 write_binary_abs / base64 严格解码（原 Rust 侧 cargo test 的对应物）
```

覆盖范围：ZIP/OOXML/OCF 结构、mimetype 位置与压缩方式、XML 合法性与转义、
图片内嵌与超大图缩放、远程图不下载、缺失图片明确报错、复杂块与 mermaid 源码保留、
恶意输入（`<script>`、`javascript:`、事件属性、控制字符、路径穿越、伪装图片）、
目标路径防覆盖手稿、取消/失败不谎报成功、输出可复现性。

导出实现不得修改原 Markdown：整个链路只读 `content`，写盘只走
`write_binary_abs`（Rust 侧拒绝覆盖 `.md/.markdown/.mdx/.txt`、拒绝符号链接、拒绝相对路径），
前端 `validateExportTarget` 再做一次目标校验。

现有 HTML 是离线中间产物：本地图片只读内嵌，远程图片不下载，公式及图表失败必须可见。
任何导出不得修改原 Markdown；PDF 的系统打印对话框打开也不等于用户已经成功保存 PDF。
