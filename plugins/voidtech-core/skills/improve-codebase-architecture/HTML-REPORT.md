# HTML Report Format

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

架构评审被渲染为操作系统临时目录中的一个自包含 HTML 文件。Tailwind 和 Mermaid 都来自 CDN。Mermaid 可靠地处理图状图表；手搭的 div 和内联 SVG 处理更具编辑感的视觉元素（质量图、剖面图）。两者混用——不要事事都靠 Mermaid，那样会开始显得千篇一律。

## 脚手架

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Architecture review — {{repo name}}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
      mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "loose" });
    </script>
    <style>
      /* small custom layer for things Tailwind doesn't cover cleanly:
         dashed seam lines, hand-drawn-feeling arrow heads, etc. */
      .seam { stroke-dasharray: 4 4; }
      .leak { stroke: #dc2626; }
      .deep { background: linear-gradient(135deg, #0f172a, #1e293b); }
    </style>
  </head>
  <body class="bg-stone-50 text-slate-900 font-sans">
    <main class="max-w-5xl mx-auto px-6 py-12 space-y-12">
      <header>...</header>
      <section id="candidates" class="space-y-10">...</section>
      <section id="top-recommendation">...</section>
    </main>
  </body>
</html>
```

## Header

仓库名、日期，以及一个紧凑的图例：实心方框 = module，虚线 = seam，红色箭头 = leakage，粗暗色方框 = deep module。不要引言段落——直接进入候选项。

## 候选项卡片

图表承担主要分量。散文稀疏、平白，并不加修饰地使用术语表术语（来自 `/codebase-design` 技能）。

每个候选项是一个 `<article>`：

- **Title** — 简短，点出该次加深（例如 "Collapse the Order intake pipeline"）。
- **Badge row** — 推荐强度（`Strong` = emerald，`Worth exploring` = amber，`Speculative` = slate），外加一个标明依赖类别的 tag（`in-process`、`local-substitutable`、`ports & adapters`、`mock`）。
- **Files** — 等宽列表，`font-mono text-sm`。
- **Before / After diagram** — 核心。两栏并排。模式见下文。
- **Problem** — 一句话。哪里痛。
- **Solution** — 一句话。改了什么。
- **Wins** — bullet，每条 ≤6 个词。例如 "Tests hit one interface"、"Pricing logic stops leaking"、"Delete 4 shallow wrappers"。
- **ADR callout**（若适用）— amber 色调框里的一行。

不要成段的解释。如果图表需要一段话才能看懂，就重画图表。

## 图表模式

挑选适合候选项的模式。混用它们。不要让每张图都长一个样——多样性也是要点之一。

### Mermaid graph（依赖/调用流的主力）

当要点是“X 调 Y 调 Z，看看这一团乱”时用 Mermaid `flowchart` 或 `graph`。把它包进一张 Tailwind 风格的卡片，免得显得像空降进来的。用 classDef 给 leakage 边上红色、给 deep module 上暗色。时序图很适合“before：6 次往返；after：1 次”。

```html
<div class="rounded-lg border border-slate-200 bg-white p-4">
  <pre class="mermaid">
    flowchart LR
      A[OrderHandler] --> B[OrderValidator]
      B --> C[OrderRepo]
      C -.leak.-> D[PricingClient]
      classDef leak stroke:#dc2626,stroke-width:2px;
      class C,D leak
  </pre>
</div>
```

### 手搭的方框与箭头（当 Mermaid 的布局跟你较劲时）

把模块画成带边框和标签的 `<div>`。箭头用内联 SVG `<line>` 或 `<path>` 元素，绝对定位在一个相对定位的容器之上。当你想让 "after" 图感觉像一个粗边框的 deep module、内部细节被灰掉时，就用它——Mermaid 渲染不出那种应有的分量。

### Cross-section（适合分层的浅）

堆叠水平条带（`h-12 border-l-4`）来展示一次调用穿过的各层。Before：6 个什么都不做的薄层。After：1 个标注了合并后职责的厚条带。

### Mass diagram（适合“接口和实现一样宽”）

每个模块两个矩形——一个表示接口表面积，一个表示实现。Before：接口矩形几乎和实现矩形一样高（浅）。After：接口矩形短，实现矩形高（深）。

### Call-graph collapse

Before：一棵渲染为嵌套方框的函数调用树。After：同一棵树坍缩成一个方框，现已内部化的调用以淡化样式显示在其中。

## 样式指引

- 偏编辑感，不要企业仪表盘感。慷慨的留白。标题可选用衬线（`font-serif` 与 stone/slate 搭配很好）。
- 用色克制：一个强调色（emerald 或 indigo），外加红色用于 leakage、amber 用于 warning。
- 把图表保持在约 320px 高，这样 before/after 能舒适地并排而无需滚动。
- 图表内的模块标签用 `text-xs uppercase tracking-wider`——它们应当读起来像示意图，而非 UI。
- 唯一的脚本是 Tailwind CDN 和 Mermaid ESM import。报告在其余方面是静态的——没有应用代码，除 Mermaid 自身渲染外没有交互。

## Top recommendation 段落

一张更大的卡片。候选项名、一句为什么、指向其卡片的锚点链接。仅此而已。

## 语气

平白英语、简洁——但架构上的名词和动词直接取自 `/codebase-design` 技能。简洁不是漂移的借口。

**精确使用：** module、interface、implementation、depth、deep、shallow、seam、adapter、leverage、locality。

**绝不替换：** component、service、unit（替 module）· API、signature（替 interface）· boundary（替 seam）· layer、wrapper（当你指的是 module 时，替 module）。

**契合这种风格的措辞：**

- "Order intake module is shallow — interface nearly matches the implementation."
- "Pricing leaks across the seam."
- "Deepen: one interface, one place to test."
- "Two adapters justify the seam: HTTP in prod, in-memory in tests."

**Wins bullet** 用术语表术语点出收益：*"locality: bugs concentrate in one module"*、*"leverage: one interface, N call sites"*、*"interface shrinks; implementation absorbs the wrappers"*。不要写 *"easier to maintain"* 或 *"cleaner code"*——那些词不在术语表里，不配占位置。

不要含糊其辞，不要清嗓子式的开场，不要 "it's worth noting that…"。如果一句话能当 bullet，就把它做成 bullet。如果一个 bullet 能砍，就砍掉。如果某个术语不在 `/codebase-design` 术语表里，先去找一个在表里的，再去发明新的。
