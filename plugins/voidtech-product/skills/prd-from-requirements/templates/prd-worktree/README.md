# PRD 工作树模板

将 `{system-slug}` 替换为系统英文标识，将 `{module-slug}` 替换为模块英文标识。slug 必须使用 English kebab-case，例如 `order-center`、`member-level`；不要使用中文、拼音或空格。

```text
prd/
├── README.md
├── _source/
│   ├── original/                    # 原始需求文件副本（权威源）
│   └── {需求文件名}/                 # xlsx 等格式的转换产物
├── 00-global/
│   ├── product-overview.md
│   ├── glossary.md
│   ├── cross-system-dependencies.md
│   ├── cross-system-flows.md
│   ├── global-open-questions.md
│   ├── requirement-traceability-matrix.md
│   ├── feature-gating-matrix.md     # 多租户/多版本/套餐制产品必须
│   ├── deepening-backlog.md         # 分期交付时必须
│   ├── status-dashboard.md          # 生成物：状态看板（脚本生成，勿手改）
│   ├── status-dashboard.html        # 同数据可视版
│   └── domain-specs/                # 对象被 2 个以上端引用时必须
│       ├── README.md
│       └── {domain-slug}.md
└── 01-{system-slug}/
    ├── README.md
    ├── 00-overview/
    │   └── prd.md
    └── 01-{module-slug}/
        └── prd.md
```

要求：

- 每个系统一个目录。
- 每个模块一个独立文件夹。
- 每个模块至少有 `prd.md`。
- 系统和模块 slug 必须使用 English kebab-case。
- 模块 `prd.md` 是唯一主本。
- 每份文档头部声明深度（骨架级/验收级）；分期交付时 `deepening-backlog.md` 是深化进度的唯一主本。
- 跨端复用的对象、状态机、字段规则在 `domain-specs/` 只定义一次，模块 PRD 引用不复制。
- 期次口径以 `requirement-traceability-matrix.md` 为唯一权威。
- `status-dashboard.md`/`.html` 是生成物，由 `generate-dashboard.py` 汇总深度声明与机械检查结果；禁止手改，深化或修订后重新生成。
- 不产出把模块正文拼接起来的汇总文档（`full-prd.md`、`{system-slug}-full-prd.md`）。整树导航由本 README 的索引表和 `status-dashboard.md` 承担，正文只存在于模块 `prd.md`。
- 变更记录固定四列：`日期 | 版本 | 主题 | commit`。不写数量、不写「某某已修完」、不写「更正上一版」——修改历史由 git 回答。
- 单系统产品允许省略 `01-{system-slug}/` 系统层，直接在根目录下放置模块目录。
