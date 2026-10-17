# dsh-latex-kit

给 DeepSeek Harness 的 LaTeX 工具集。七把 agent 工具，分三组，**Host 侧，无 UI**。

整合了两类东西的优点：Codex 官方 LaTeX 插件的**编译闭环**（自带运行时、环境自检、装完即编），
以及社区 `dsh-latex-guard` 的**文献质量**（去重、补字段、引文审计）。两家的空白这里都补上了：
Codex 那个不管 bib，latex-guard 那个要你自己装 TeX。

## 七把工具

### 编译闭环（不需要预装任何 TeX）

| 工具 | 作用 |
|---|---|
| `latex_runtime` | 管理托管的 Tectonic：`status` / `install` / `remove`。下载后按 GitHub Release API 的 `digest` 字段校验 sha256，不匹配就删掉且不留半文件 |
| `latex_doctor` | 报告这台机器能不能编译：托管 Tectonic、PATH 上的 tectonic、latexmk、pdflatex/xelatex/lualatex、biber/bibtex 逐个探测，再跑一次最小编译自检证明真能出 PDF |
| `latex_compile` | 编译项目，返回结构化报告：带**文件和行号**的错误、未定义引用、未定义文献、overfull 计数、页数、耗时 |

引擎选择是 `auto`：Tectonic 优先；项目需要 shell escape（minted/svg/pstricks/biber）且装了 latexmk 时回落 latexmk。

### 文献审计（不需要 TeX，纯文本 + HTTP）

| 工具 | 作用 |
|---|---|
| `bib_lint` | 重复 key、按类型查必需字段、字段顺序与空白规范化。`write: false` 时绝不落盘 |
| `bib_fill` | 按 DOI（退而求其次按标题）从 Crossref 补缺失字段，可选 Semantic Scholar 兜底。**绝不覆盖已有值**，解析失败整体拒写 |
| `cite_audit` | `.tex` 引用 vs `.bib` 条目：用了但库里没有 / 库里有但从没被引。`%` 注释、verbatim 环境里的引用不计入 |

### 公式渲染

| 工具 | 作用 |
|---|---|
| `latex_render` | TeX 公式 → **自包含 SVG**：字形转 path，不引用任何外部字体，矢量可无限缩放。离线，不碰 TeX 引擎 |

## 安装

**尚未发布到 npm**，从 GitHub 直接装。pnpm 会锁定到具体 commit 并校验 integrity：

```sh
dsh plugin --profile desktop add https://github.com/baimo923127-ops/dsh-latex-kit
```

也可以把这条写进 profile 的 `package.json`：

```json
"dsh-latex-kit": "github:baimo923127-ops/dsh-latex-kit"
```

本地开发时改用 `link:` 指向源码目录，改代码即时生效：

```json
"dsh-latex-kit": "link:/absolute/path/to/dsh-latex-kit"
```

装完重启 DSH。

## 第一次使用

```text
latex_runtime install     # 下载托管 Tectonic（约 21MB，本机实测 43KB/s 网速下约 5 分钟）
latex_doctor              # 确认 ready: true
```

Tectonic 首次编译会按需拉宏包（实测 42MB / 200 秒），之后同一项目 400ms 左右。

## 设计取舍

**为什么 Tectonic 是下载而不是打包进 npm 包？**
跨平台要发 12–22MB × 多平台，且 macOS 上已有先例（openai/codex #34567：bundled 资源权限 0600 导致反复 100 MiB staging 泄漏）。改成首次使用时下载，插件本体保持几十 KB。

**为什么不自动装 TeX Live？**
Codex 那个插件有 `texlive-runtime-installer`，这里**故意不做**。TeX Live 是 GB 级、耗时长、常要管理员权限。缺什么就精确报告缺什么、给出装法，绝不自己动手装。所有安装指引都带 `verified: false` 标记（本机没验证过那些命令）。

**为什么公式引擎不是硬依赖？**
`mathjax-full` 解包 33MB。写成顶层 `import` 且包没装，会让**整个插件加载失败，七把工具全废**。所以走运行时动态 `import()`，缺失时 `latex_render` 返回安装指引，其余六把不受影响——已实测。

**为什么不 vendor 裁剪版 MathJax？**
实测运行时只加载 248 文件 / 2.22MB（`es5/` + `ts/` 那 27MB 根本不加载），产物字节与全量安装完全一致。技术上可 vendor，但带 Apache-2.0 的 LICENSE/NOTICE 义务和升级维护成本，暂不做。

## 运行时数据

全部落在 `$DSH_HOME/latex-kit`，包目录保持只读：

```
$DSH_HOME/latex-kit/
├── runtime/     托管 Tectonic（tectonic.exe + manifest.json）
├── packages/    Tectonic 宏包缓存（靠 TECTONIC_CACHE_DIR 钉住）
├── build/       编译中间文件、渲染产物
├── staging/     下载暂存区（失败即清空）
└── latex-kit.log
```

注意：Tectonic 0.17 **没有** `--cache-dir` 参数，只有环境变量 `TECTONIC_CACHE_DIR`。

## 已知限制

- `latexmk` 分支未经真实编译验证（开发机无 TeX Live），只过了引擎选择的单测
- Windows 安装指引（`winget install MiKTeX.MiKTeX` 等）未在本机验证，输出里标 `verified: false`
- `cite_audit` 不跟进 `\input`/`\include`；不解析 biblatex 复数形式（`\parencites` 等）
- `bib_fill` 只补 `author/editor/title/journal/booktitle/year/volume/number/pages/publisher/doi/url/issn/isbn`，不碰 abstract
- `latex_render` 只出 SVG；不支持 `\ce`/siunitx 等重宏包
- 网速是风险：实测 43KB/s，慢网下 `latex_runtime install` 可能逼近 15 分钟超时

## 依赖

`package.json` **零新增依赖**。ZIP/TAR 解压用 `node:zlib` + 手写解析器（不依赖系统 `tar.exe`）；
BibTeX 解析器自写（可控性 + 体积）；Crossref 用内置 `fetch`。
`@deepseek-ai/dsh-tools` 由宿主运行时注入，不要自己装。
