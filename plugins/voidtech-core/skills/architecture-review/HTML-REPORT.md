# HTML 报告格式

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

架构评审被渲染为操作系统临时目录中的一个自包含 HTML 文件。文件必须完全离线可读：样式全部内联，图表只使用语义化 HTML、CSS 和内联 SVG，不加载任何远程脚本、样式、字体或图片。

所有来自仓库的动态值都视为不可信文本。插入元素内容时转义 `&`、`<`、`>`；插入属性时还要转义引号。不要把代码、注释、路径或 issue 内容当成 HTML 片段，也不要生成 `innerHTML`、事件属性或 `javascript:` URL。

## 基础 HTML 模板

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Architecture review — {{repo name}}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
        color: #0f172a;
        background: #fafaf9;
      }
      * { box-sizing: border-box; }
      body { margin: 0; }
      main { width: min(1100px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0; }
      header, section { margin-bottom: 40px; }
      .candidate { margin: 24px 0; padding: 24px; border: 1px solid #e2e8f0; border-radius: 14px; background: #fff; }
      .badge { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 12px; background: #e2e8f0; }
      .strong { color: #065f46; background: #d1fae5; }
      .warning { color: #92400e; background: #fef3c7; }
      .compare { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
      .diagram { min-height: 280px; padding: 16px; border: 1px solid #e2e8f0; border-radius: 10px; overflow: auto; }
      .files { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; }
      .seam { stroke-dasharray: 4 4; }
      .leak { stroke: #dc2626; stroke-width: 2; }
      .deep { color: #f8fafc; background: linear-gradient(135deg, #0f172a, #1e293b); }
      @media (max-width: 760px) { .compare { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <header>...</header>
      <section id="candidates">...</section>
      <section id="top-recommendation">...</section>
    </main>
  </body>
</html>
```

## 页头

显示仓库名、日期和简短图例：实心方框表示 module，虚线表示 seam，红色箭头表示内部细节泄漏，粗暗色方框表示 deep module。省略引言，直接列出候选项。

## 候选项卡片

以图表为主，只保留理解建议所需的简短说明。架构术语来自 `voidtech-core:codebase-design` 技能，并保持用词一致。

每个候选项是一个 `<article>`：

- **Title（标题）** — 简短说明模块深化内容，例如 "Collapse the Order intake pipeline"。
- **Badge row（徽标行）** — 显示推荐程度（`Strong` = emerald，`Worth exploring` = amber，`Speculative` = slate），再显示一个依赖类别标签（`in-process`、`local-substitutable`、`ports & adapters`、`mock`）。
- **Files（文件）** — 使用 `.files` 样式的等宽列表。
- **Before / After diagram（改动前后图）** — 作为卡片主体，分两栏并排展示。
- **Problem（问题）** — 用一句话说明当前结构带来的具体困难。
- **Solution（方案）** — 用一句话说明要做的改动。
- **Wins（收益）** — 使用列表，每条不超过 6 个英文单词。例如 "Tests hit one interface"、"Pricing logic stops leaking"、"Delete 4 shallow wrappers"。
- **ADR callout（ADR 提示）**（若适用）— 在琥珀色提示框中用一行说明冲突。

不要成段的解释。如果图表需要一段话才能看懂，就重画图表。

## 图表模式

根据候选项要表达的关系选择图表，不必让所有候选项使用同一种布局。

### 内联 SVG 图（适合依赖和调用关系）

当要点是“X 调 Y 调 Z，看看这一团乱”时，用内联 SVG 明确画出模块、箭头、seam 与 leakage。为箭头定义本地 `<marker>`，为每个节点提供文字标签；不要用需要脚本渲染的图表语法。时序关系可用从左到右的编号箭头表达“before：6 次往返；after：1 次”。

```html
<div class="diagram" aria-label="Order intake dependency graph">
  <svg viewBox="0 0 720 240" role="img" aria-labelledby="graph-title">
    <title id="graph-title">Order intake dependency graph</title>
    <defs>
      <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
        <path d="M0,0 L8,4 L0,8 Z" fill="currentColor" />
      </marker>
    </defs>
    <rect x="24" y="80" width="150" height="56" rx="8" fill="#fff" stroke="#64748b" />
    <text x="99" y="112" text-anchor="middle">OrderHandler</text>
    <path d="M174 108 H270" stroke="#64748b" marker-end="url(#arrow)" />
    <!-- Continue with locally drawn nodes and edges. -->
  </svg>
</div>
```

### 自绘方框与箭头（适合需要精确控制布局时）

把模块画成带边框和标签的 `<div>`。箭头用内联 SVG `<line>` 或 `<path>` 元素，绝对定位在一个相对定位的容器之上。当你想让 "after" 图感觉像一个粗边框的 deep module、内部细节被灰掉时，就用它。

### 分层剖面图

堆叠水平条带（`h-12 border-l-4`）来展示一次调用穿过的各层。Before：6 个什么都不做的薄层。After：1 个标注了合并后职责的厚条带。

### 接口与实现比例图

每个模块两个矩形——一个表示接口表面积，一个表示实现。Before：接口矩形几乎和实现矩形一样高（浅）。After：接口矩形短，实现矩形高（深）。

### 调用图收拢

Before：一棵渲染为嵌套方框的函数调用树。After：同一棵树坍缩成一个方框，现已内部化的调用以淡化样式显示在其中。

## 样式指引

- 使用接近技术文章的排版，不使用企业仪表盘样式。保留充足留白；标题可以使用衬线字体。
- 用色克制：一个强调色（emerald 或 indigo），外加红色用于 leakage、amber 用于 warning。
- 把图表保持在约 320px 高，这样 before/after 能舒适地并排而无需滚动。
- 图表内的模块标签使用约 12px 的大写字母与适度字距——它们应当读起来像示意图，而非 UI。
- 不包含任何脚本。报告是纯静态文件，断网并禁用 JavaScript 后仍须完整呈现。

## 首选建议

一张更大的卡片。候选项名、一句为什么、指向其卡片的锚点链接。仅此而已。

## 语气

报告正文使用简单、简洁的英语。架构名词和动词直接采用 `voidtech-core:codebase-design` 技能中的定义，不要为追求简短而改变术语含义。

**精确使用：** module、interface、implementation、depth、deep、shallow、seam、adapter、leverage、locality。

**绝不替换：** component、service、unit（替 module）· API、signature（替 interface）· boundary（替 seam）· layer、wrapper（当你指的是 module 时，替 module）。

**契合这种风格的措辞：**

- "Order intake module is shallow — interface nearly matches the implementation."
- "Pricing leaks across the seam."
- "Deepen: one interface, one place to test."
- "Two adapters justify the seam: HTTP in prod, in-memory in tests."

**Wins 列表项**使用术语表中的词说明具体收益，例如 *"locality: bugs concentrate in one module"*、*"leverage: one interface, N call sites"*、*"interface shrinks; implementation absorbs the wrappers"*。不要只写 *"easier to maintain"* 或 *"cleaner code"*，因为它们没有说明结构具体改善在哪里。

直接陈述问题和建议，不要加入“值得注意的是”等铺垫。如果一句话可以写成列表项，就保持简短；没有信息价值的列表项直接删除。优先使用 `voidtech-core:codebase-design` 已定义的术语，不要随意新增近义词。
