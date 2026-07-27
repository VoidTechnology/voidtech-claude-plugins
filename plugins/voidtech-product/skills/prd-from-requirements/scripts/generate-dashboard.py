#!/usr/bin/env python3
"""生成 PRD 工作树状态看板(生成物,禁止手改)。

用法:
    python3 generate-dashboard.py <输出目录>

从已有的机器可读信号自动汇总,不需要任何人再填一遍状态:
- 各模块/领域规格头部的「深度」声明与「引用领域规格」列表
- 追溯矩阵的「需求 ID 区间 → 归属模块」映射
- cross-system-flows.md 的流程步骤需求编号(推导端到端路径视图)
- global-open-questions.md 的 OQ 摘要与状态
- deepening-backlog.md 的建议深化顺序
- check-prd-tree.py 的机械检查结果(同目录,子进程调用)

就绪判定(模块可交开发的定义,自报深度与机械信号分离展示):
    可交开发   = 自身验收级 + 引用的领域规格全部验收级
                 + 自身与依赖无机械错误、无可疑信号
    存疑       = 深度声明达标但机械信号与之矛盾(含「样例」、追溯区间行、
                 疑似未定义状态、机械错误)
    被依赖阻塞 = 自身验收级,但引用的领域规格还是骨架级
    待深化     = 自身还是骨架级

输出(同源生成,信息层级不同):
    <输出目录>/00-global/status-dashboard.md   审计账本:权威版,进 git、可 diff,
                                               保留全量编号与依赖,供评审引用与反查
    <输出目录>/00-global/status-dashboard.html 作战面板:给人看的视图——汇总卡、
                                               下一步建议、按系统分组、中文标题、
                                               短板置顶、OQ 摘要化、可展开详情

只使用 Python 标准库。HTML 自包含(内联 CSS + 原生 JS),离线双击可开。
"""

import html
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

DEPTH_RE = re.compile(r"^\s*-\s*\*{0,2}深度\*{0,2}\s*[:：]\s*([^\n|]+)", re.M)
# 「引用领域规格」头部行,兼容纯 slug(course-teaching、payment-order)与
# 完整路径(`../../00-global/domain-specs/payment-order.md`)两种写法
SPEC_LINE_RE = re.compile(r"^\s*-\s*\*{0,2}引用领域规格\*{0,2}\s*[:：](.+)$", re.M)
SLUG_TOKEN_RE = re.compile(r"[a-z][a-z0-9-]{2,}")
SPEC_PATH_RE = re.compile(r"domain-specs/([a-z0-9][a-z0-9-]*)\.md")
SPEC_PATH_STRIP_RE = re.compile(r"[^\s、,，;；]*domain-specs/[a-z0-9-]+\.md")
# 路径式引用剥离后仍可能残留的非 slug 词,不作为领域规格引用
SPEC_NOISE_TOKENS = {"md", "prd", "readme", "domain-specs", "global", "templates", "references"}


def parse_spec_refs(line):
    """从「引用领域规格」行提取全部引用 slug——包括指向不存在文件的引用。

    先精确提取路径式引用(domain-specs/xxx.md),再把路径从行内剥离,
    对剩余文本抓裸 slug(course-teaching、payment-order 写法)。
    不按「文件是否存在」过滤:缺失的引用必须交给 verdict() 判「存疑」,
    静默吞掉会让模块被误判为可交开发。
    """
    path_refs = SPEC_PATH_RE.findall(line)
    remainder = SPEC_PATH_STRIP_RE.sub("", line)
    bare = SLUG_TOKEN_RE.findall(remainder)
    return sorted({t for t in path_refs + bare if t not in SPEC_NOISE_TOKENS})
TITLE_RE = re.compile(r"^#\s+(.+)$", re.M)
OQ_ID_RE = re.compile(r"OQ-[A-Za-z0-9][A-Za-z0-9_-]*")
REQ_RANGE_RE = re.compile(r"([A-Z]{2,6})-(\d{1,4})(?:\s*~\s*(?:[A-Z]{2,6}-)?(\d{1,4}))?")
MODULE_SLUG_RE = re.compile(r"\b(\d{2}-[a-z][a-z0-9-]+)\b")
TRACE_INTERVAL_RE = re.compile(r"\|\s*[A-Z]{2,6}-\d+\s*~")

CHECK_SCRIPT = Path(__file__).resolve().parent / "check-prd-tree.py"

STATUS_ORDER = {"可交开发": 0, "被依赖阻塞": 1, "待深化": 2, "存疑": 3}
STATUS_CSS = {"可交开发": "ok", "被依赖阻塞": "blocked", "待深化": "wip", "存疑": "warn"}
BADGE = {"可交开发": "✅", "被依赖阻塞": "⛔", "待深化": "🚧", "存疑": "⚠️"}


def status_label(verdict_full):
    for label in STATUS_ORDER:
        if verdict_full.startswith(label):
            return label
    return "存疑"


def norm_depth(raw):
    raw = raw.strip()
    if raw.startswith("验收级"):
        return "验收级"
    if raw.startswith("骨架级"):
        return "骨架级"
    return raw or "未声明"


def read(path):
    return path.read_text(encoding="utf-8", errors="replace")


def parse_matrix_ranges(root):
    """从追溯矩阵提取 (前缀, 起, 止, 模块 slug) 映射。"""
    matrix = root / "00-global" / "requirement-traceability-matrix.md"
    ranges = []
    if not matrix.exists():
        return ranges
    for line in read(matrix).splitlines():
        if not line.strip().startswith("|"):
            continue
        id_m = REQ_RANGE_RE.search(line)
        slug_m = MODULE_SLUG_RE.search(line)
        if id_m and slug_m:
            lo = int(id_m.group(2))
            hi = int(id_m.group(3)) if id_m.group(3) else lo
            ranges.append((id_m.group(1), lo, hi, slug_m.group(1)))
    return ranges


def parse_oq_catalog(root):
    """OQ 编号 → (摘要, 是否已定案)。从全局开放问题表逐行解析。"""
    path = root / "00-global" / "global-open-questions.md"
    catalog = {}
    if not path.exists():
        return catalog
    for line in read(path).splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 2:
            continue
        m = OQ_ID_RE.fullmatch(cells[0])
        if not m:
            continue
        summary = re.sub(r"\*+", "", cells[1])
        summary = summary if len(summary) <= 32 else summary[:31] + "…"
        resolved = any("已确认" in c or "已定案" in c or "已关闭" in c for c in cells)
        catalog[cells[0]] = (summary, resolved)
    return catalog


def parse_backlog_order(root):
    """从深化任务清单提取 名称 → 建议顺序(整数)。best-effort。"""
    path = root / "00-global" / "deepening-backlog.md"
    order = {}
    if not path.exists():
        return order
    for line in read(path).splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 4 or cells[0] in ("模块", "领域规格", "文档", "---"):
            continue
        ints = [c for c in cells[1:] if re.fullmatch(r"\d{1,3}", c)]
        if ints:
            order[cells[0]] = int(ints[-1])
    return order


def system_title(system_dir):
    readme = system_dir / "README.md"
    if readme.exists():
        m = TITLE_RE.search(read(readme))
        if m:
            return re.sub(r"\s*(README|说明)\s*$", "", m.group(1)).strip()
    return system_dir.name


def collect_modules(root):
    """收集模块 prd.md 与领域规格。返回 (modules, specs, system_names)。

    兼容两种合法结构:
    - 多系统: NN-{system}/NN-{module}/prd.md,key 为 "system/module"
    - 单系统(省略系统层): NN-{module}/prd.md 直接在根下,key 为 "module",
      归入虚拟系统 ""(显示名取根 README 的 H1,退化为「单系统」)
    """
    modules = {}
    system_names = {}
    for entry in sorted(root.glob("[0-9][0-9]-*")):
        if not entry.is_dir():
            continue
        direct_prd = entry / "prd.md"
        sub_prds = sorted(entry.glob("[0-9]*/prd.md"))
        if direct_prd.exists() and not sub_prds:
            modules[entry.name] = parse_doc(direct_prd, kind="module")
            continue
        if not sub_prds:
            continue
        system_names[entry.name] = system_title(entry)
        for prd in sub_prds:
            key = f"{entry.name}/{prd.parent.name}"
            modules[key] = parse_doc(prd, kind="module")
    if any("/" not in key for key in modules):
        root_readme = root / "README.md"
        product = "单系统"
        if root_readme.exists():
            m = TITLE_RE.search(read(root_readme))
            if m:
                product = m.group(1).strip()
        system_names[""] = product
    specs = {}
    spec_dir = root / "00-global" / "domain-specs"
    if spec_dir.is_dir():
        for spec in sorted(spec_dir.glob("*.md")):
            if spec.name == "README.md":
                continue
            specs[spec.stem] = parse_doc(spec, kind="spec")
    return modules, specs, system_names


def split_key(key):
    """模块 key → (系统目录, 模块 slug)。单系统 key 无 "/",归入虚拟系统 ""。"""
    if "/" in key:
        sysdir, slug = key.split("/", 1)
        return sysdir, slug
    return "", key


def parse_doc(path, kind):
    text = read(path)
    head = "\n".join(text.splitlines()[:20])
    depth_m = DEPTH_RE.search(head)
    title_m = TITLE_RE.search(text)
    title = title_m.group(1).strip() if title_m else path.stem
    title = re.sub(r"^领域规格\s*[:：]\s*", "", title)
    title = re.sub(r"\s*PRD\s*$", "", title).strip()
    spec_line_m = SPEC_LINE_RE.search(head)
    info = {
        "path": path,
        "kind": kind,
        "title": title,
        "depth": norm_depth(depth_m.group(1)) if depth_m else "未声明",
        "spec_line": spec_line_m.group(1) if spec_line_m else "",
        "specs": [],  # 在 main() 中按已知领域规格集合解析
        "oq": sorted(set(OQ_ID_RE.findall(text))),
        "signals": [],
    }
    if "样例" in text:
        info["signals"].append("含「样例」字样")
    if kind == "module" and TRACE_INTERVAL_RE.search(text):
        info["signals"].append("追溯含区间行")
    return info


def run_check(root):
    """跑机械自检,按文件归组错误/警告。"""
    issues = {}
    try:
        proc = subprocess.run(
            [sys.executable, str(CHECK_SCRIPT), str(root)],
            capture_output=True, text=True, timeout=120,
        )
        output = proc.stdout
    except Exception as exc:  # noqa: BLE001 - 自检失败不阻塞看板生成
        return {}, f"机械自检未能运行: {exc}"
    for line in output.splitlines():
        m = re.match(r"(错误|警告): ([^:]+?)(?::\d+)?: (.*)", line)
        if not m:
            continue
        level, path, msg = m.groups()
        entry = issues.setdefault(path, {"错误": 0, "警告": 0, "ghost": 0})
        entry[level] += 1
        if "幽灵状态" in msg:
            entry["ghost"] += 1
    return issues, None


def issues_for(rel_str, issues):
    return issues.get(rel_str, {"错误": 0, "警告": 0, "ghost": 0})


def verdict(info, specs, issues, root):
    rel = str(info["path"].relative_to(root))
    own = issues_for(rel, issues)
    dep_missing = [s for s in info["specs"] if s not in specs]
    dep_skeleton = [s for s in info["specs"] if s in specs and specs[s]["depth"] != "验收级"]
    dep_issues = []
    for s in info["specs"]:
        if s in specs:
            srel = str(specs[s]["path"].relative_to(root))
            si = issues_for(srel, issues)
            if si["错误"] or si["ghost"] or specs[s]["signals"]:
                dep_issues.append(s)
    if info["depth"] != "验收级":
        return "待深化", dep_skeleton
    if dep_missing:
        return "存疑(引用的领域规格文件缺失)", dep_missing
    if dep_skeleton:
        return "被依赖阻塞", dep_skeleton
    if own["错误"] or own["ghost"] or info["signals"] or dep_issues:
        return "存疑", dep_issues
    return "可交开发", []


def parse_flows(root, ranges, modules):
    """流程标题 + 步骤里的需求编号 → 涉及模块。"""
    flows_file = root / "00-global" / "cross-system-flows.md"
    if not flows_file.exists():
        return []
    text = read(flows_file)
    sections = re.split(r"^##\s+", text, flags=re.M)[1:]
    slug_to_key = {}
    for key in modules:
        slug_to_key.setdefault(split_key(key)[1], key)
    flows = []
    for sec in sections:
        title, _, body = sec.partition("\n")
        involved = set()
        for prefix, lo, hi in (
            (m.group(1), int(m.group(2)), int(m.group(3) or m.group(2)))
            for m in REQ_RANGE_RE.finditer(body)
        ):
            for rp, rlo, rhi, slug in ranges:
                if rp == prefix and not (hi < rlo or lo > rhi) and slug in slug_to_key:
                    involved.add(slug_to_key[slug])
        if involved:
            flows.append((title.strip(), sorted(involved)))
    return flows


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    root = Path(sys.argv[1]).resolve()
    if not root.is_dir():
        print(f"错误: 目录不存在: {root}")
        return 2

    modules, specs, system_names = collect_modules(root)
    for info in modules.values():
        info["specs"] = parse_spec_refs(info["spec_line"])
    ranges = parse_matrix_ranges(root)
    oq_catalog = parse_oq_catalog(root)
    backlog_order = parse_backlog_order(root)
    issues, check_err = run_check(root)
    flows = parse_flows(root, ranges, modules)
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    rows = []  # (key, info, verdict_full, blockers)
    for key, info in modules.items():
        v, blockers = verdict(info, specs, issues, root)
        rows.append((key, info, v, blockers))
    spec_rows = []
    for slug, info in specs.items():
        rel = str(info["path"].relative_to(root))
        own = issues_for(rel, issues)
        if info["depth"] != "验收级":
            v = "待深化"
        elif own["错误"] or own["ghost"] or info["signals"]:
            v = "存疑"
        else:
            v = "可交开发"
        spec_rows.append((slug, info, v))

    vmap = {key: v for key, _, v, _ in rows}
    ready = sum(1 for _, _, v, _ in rows if v == "可交开发")
    flow_ready = sum(
        1 for _, involved in flows if all(vmap.get(m) == "可交开发" for m in involved)
    )

    def sig_text(info, rel):
        own = issues_for(rel, issues)
        parts = list(info["signals"])
        if own["错误"]:
            parts.append(f"机械错误 {own['错误']}")
        if own["ghost"]:
            parts.append(f"疑似未定义状态 {own['ghost']}")
        return "、".join(parts) if parts else "—"

    # ---------- Markdown(审计账本,保持全量编号与依赖) ----------
    md = []
    md.append("# PRD 状态看板")
    md.append("")
    md.append("> ⚠️ 本文件为**生成物**,由 generate-dashboard.py 从各文档头部声明、追溯矩阵与机械检查结果汇总。请勿手改;深化或修订后重新生成。")
    md.append(f"> 生成时间:{now}。就绪 {ready}/{len(rows)} 个模块。")
    md.append("")
    md.append("判定规则:可交开发 = 自身验收级 + 引用领域规格全部验收级 + 无机械错误与可疑信号。「自报深度」来自文档头部声明,「机械信号」来自脚本检查,两列分开看:绿灯 + 有信号 = 该绿灯可疑。")
    md.append("")
    md.append("## 模块就绪")
    md.append("")
    md.append("| 模块 | 自报深度 | 引用领域规格(深度) | 关联 OQ | 机械信号 | 就绪判定 |")
    md.append("|---|---|---|---|---|---|")
    for key, info, v, blockers in rows:
        rel = str(info["path"].relative_to(root))
        specs_cell = "、".join(
            f"{s}({specs[s]['depth'] if s in specs else '缺失'})" for s in info["specs"]
        ) or "无"
        oq_cell = "、".join(info["oq"]) or "—"
        icon = BADGE.get(status_label(v), "⚠️")
        note = f"(短板:{'、'.join(blockers)})" if blockers else ""
        md.append(
            f"| {key} | {info['depth']} | {specs_cell} | {oq_cell} "
            f"| {sig_text(info, rel)} | {icon} {v}{note} |"
        )
    md.append("")
    md.append("## 领域规格")
    md.append("")
    md.append("| 领域规格 | 自报深度 | 机械信号 | 状态 |")
    md.append("|---|---|---|---|")
    for slug, info, v in spec_rows:
        rel = str(info["path"].relative_to(root))
        icon = BADGE.get(status_label(v), "⚠️")
        md.append(f"| {slug} | {info['depth']} | {sig_text(info, rel)} | {icon} {v} |")
    md.append("")
    md.append("## 端到端路径")
    md.append("")
    if flows:
        md.append("| 路径 | 涉及模块 | 最短板 | 路径就绪 |")
        md.append("|---|---|---|---|")
        for title, involved in flows:
            not_ready = [k for k in involved if vmap.get(k) != "可交开发"]
            status = "✅ 就绪" if not not_ready else "❌ 未就绪"
            shortest = "、".join(f"{k}({vmap.get(k, '?')})" for k in not_ready) or "—"
            md.append(f"| {title} | {'、'.join(involved)} | {shortest} | {status} |")
    else:
        md.append("(未能从 cross-system-flows.md 推导路径:流程步骤需带需求编号,且追溯矩阵含「ID 区间 → 归属模块」行。)")
    if check_err:
        md.append("")
        md.append(f"> 注意:{check_err},机械信号列可能不完整。")
    md_text = "\n".join(md) + "\n"

    # ---------- HTML view model(作战面板) ----------
    def h(s):
        return html.escape(str(s), quote=True)

    def spec_name(slug):
        return specs[slug]["title"] if slug in specs else slug

    def oq_view(ids):
        items = []
        open_count = 0
        for oid in ids:
            summary, resolved = oq_catalog.get(oid, ("未在全局清单登记", False))
            if not resolved:
                open_count += 1
            items.append((oid, summary, resolved))
        return open_count, items

    vm = []
    for key, info, v, blockers in rows:
        sysdir, slug = split_key(key)
        label = status_label(v)
        open_oq, oq_items = oq_view(info["oq"])
        shortboard = [
            f"差 {spec_name(s)}({s}):{specs[s]['depth'] if s in specs else '文件缺失'}"
            for s in blockers
        ]
        rel = str(info["path"].relative_to(root))
        vm.append({
            "key": key, "sysdir": sysdir, "slug": slug,
            "title": info["title"], "depth": info["depth"],
            "label": label, "css": STATUS_CSS[label], "verdict": v,
            "shortboard": shortboard,
            "deps": [(s, spec_name(s), specs[s]["depth"] if s in specs else "缺失")
                     for s in info["specs"]],
            "open_oq": open_oq, "oq_items": oq_items,
            "signals": sig_text(info, rel),
            "order": backlog_order.get(slug, backlog_order.get(info["title"], 999)),
        })

    # 下一步建议:优先推荐阻塞面最大的骨架级领域规格;
    # 没有规格级阻塞时,退化为按深化清单顺序推荐待深化模块
    suggestion = None
    skeleton_specs = [s for s, info, v in spec_rows if info["depth"] != "验收级"]
    if skeleton_specs:
        impact = []
        for s in skeleton_specs:
            blocked_modules = [m for m in vm if any(s == b[0] for b in m["deps"])
                               and m["label"] in ("被依赖阻塞", "待深化")
                               and s in [d[0] for d in m["deps"]
                                         if d[2] != "验收级"]]
            blocked_keys = {m["key"] for m in blocked_modules}
            blocked_flows = sum(
                1 for _, involved in flows if blocked_keys & set(involved)
            )
            impact.append((blocked_flows, len(blocked_modules), s))
        impact.sort(reverse=True)
        bf, bm, top = impact[0]
        if bm:
            _, oq_items = oq_view(sorted(set(specs[top]["oq"])))
            pending = [f"{oid} {summary}" for oid, summary, resolved in oq_items
                       if not resolved][:2]
            suggestion = {
                "name": spec_name(top), "slug": top,
                "reason": f"解除 {bm} 个模块的依赖阻塞,涉及 {bf} 条端到端链路",
                "pending": pending,
            }
    if suggestion is None:
        wip = [m for m in vm if m["label"] == "待深化"]
        if wip:
            flows_of = {
                m["key"]: sum(1 for _, involved in flows if m["key"] in involved)
                for m in wip
            }
            wip.sort(key=lambda m: (m["order"], -flows_of[m["key"]],
                                    m["signals"] != "—", m["slug"]))
            top = wip[0]
            reason_parts = []
            if top["order"] != 999:
                reason_parts.append(f"深化清单建议顺序第 {top['order']} 位")
            if flows_of[top["key"]]:
                reason_parts.append(f"涉及 {flows_of[top['key']]} 条端到端链路")
            if not reason_parts:
                reason_parts.append("当前待深化模块中排序最前")
            pending = [f"{oid} {summary}" for oid, summary, resolved in top["oq_items"]
                       if not resolved][:2]
            suggestion = {
                "name": top["title"], "slug": top["key"],
                "reason": ",".join(reason_parts),
                "pending": pending,
            }

    open_oq_total = sum(1 for _, (_, resolved) in oq_catalog.items() if not resolved)
    counts = {label: sum(1 for m in vm if m["label"] == label) for label in STATUS_ORDER}

    # ---------- HTML 渲染 ----------
    css = """
:root{--fg:#1a1a1a;--bg:#fff;--muted:#6b6b6b;--line:#e2e2e2;--card:#f7f7f7;
--ok:#0a7d33;--ok-bg:#e6f4ea;--blocked:#b3261e;--blocked-bg:#fdecea;
--wip:#8a5300;--wip-bg:#fff4e5;--warn:#7a6400;--warn-bg:#fef7e0}
@media(prefers-color-scheme:dark){:root{--fg:#e6e6e6;--bg:#151515;--muted:#9a9a9a;
--line:#3a3a3a;--card:#212121;--ok:#7ad39a;--ok-bg:#12331d;--blocked:#f2a49e;
--blocked-bg:#3d1d1a;--wip:#e8bd7c;--wip-bg:#382c13;--warn:#e0d080;--warn-bg:#35300f}}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;
margin:0 auto;max-width:76rem;padding:2rem 1.2rem 4rem;line-height:1.6;
color:var(--fg);background:var(--bg)}
h1{font-size:1.35rem;margin:0 0 .2rem}
h2{font-size:1.05rem;margin:2.2rem 0 .6rem;border-bottom:1px solid var(--line);
padding-bottom:.3rem}
.meta{color:var(--muted);font-size:.82rem;margin-bottom:1.2rem}
.cards{display:flex;flex-wrap:wrap;gap:.6rem;margin:1rem 0}
.card{flex:1 1 8.5rem;min-width:8.5rem;background:var(--card);border:1px solid var(--line);
border-radius:.6rem;padding:.7rem .9rem}
.card b{display:block;font-size:1.5rem;line-height:1.2}
.card span{color:var(--muted);font-size:.8rem}
.card.ok b{color:var(--ok)}.card.blocked b{color:var(--blocked)}
.card.wip b{color:var(--wip)}.card.warn b{color:var(--warn)}
.next{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--wip);
border-radius:.5rem;padding:.8rem 1rem;margin:1rem 0}
.next b{font-size:.95rem}
.next ul{margin:.3rem 0 0 1.1rem;padding:0}
.fbar{margin:.8rem 0 .4rem}
.fbtn{border:1px solid var(--line);background:var(--card);color:var(--fg);
border-radius:1rem;padding:.2rem .8rem;margin-right:.4rem;cursor:pointer;font-size:.82rem}
.fbtn.on{border-color:var(--fg);font-weight:600}
table{border-collapse:collapse;width:100%;font-size:.85rem;margin:.4rem 0 1rem}
th,td{border:1px solid var(--line);padding:.45rem .6rem;text-align:left;vertical-align:top}
th{background:var(--card);font-weight:600}
.mod b{font-size:.92rem}
.mod .slug{display:block;color:var(--muted);font-size:.75rem;font-family:ui-monospace,monospace}
.tag{display:inline-block;border-radius:.8rem;padding:.05rem .6rem;font-size:.78rem;
white-space:nowrap}
.tag.ok{background:var(--ok-bg);color:var(--ok)}
.tag.blocked{background:var(--blocked-bg);color:var(--blocked)}
.tag.wip{background:var(--wip-bg);color:var(--wip)}
.tag.warn{background:var(--warn-bg);color:var(--warn)}
.short li{margin:.1rem 0}
.short ul{margin:0;padding-left:1.1rem}
details{margin-top:.25rem}
summary{cursor:pointer;color:var(--muted);font-size:.78rem}
details ul{margin:.2rem 0 0 1.1rem;padding:0;font-size:.8rem}
.oq-done{color:var(--muted);text-decoration:line-through}
.muted{color:var(--muted)}
.bar{background:var(--card);border:1px solid var(--line);border-radius:.4rem;
height:.55rem;overflow:hidden;min-width:7rem}
.bar i{display:block;height:100%;background:var(--ok)}
.flow td{vertical-align:middle}
code{font-family:ui-monospace,monospace;font-size:.82em}
"""
    js = """
document.querySelectorAll('.fbtn').forEach(function(btn){
  btn.addEventListener('click',function(){
    document.querySelectorAll('.fbtn').forEach(function(b){b.classList.remove('on')});
    btn.classList.add('on');
    var want=btn.dataset.f;
    document.querySelectorAll('tr[data-status]').forEach(function(tr){
      tr.style.display=(want==='all'||tr.dataset.status===want)?'':'none';
    });
  });
});
"""
    ht = [f"<title>PRD 状态看板</title><style>{css}</style>"]
    ht.append("<h1>PRD 状态看板</h1>")
    ht.append(
        f"<p class='meta'>生成物,请勿手改 · 生成时间 {h(now)} · "
        "判定 = 自身验收级 + 依赖规格全验收级 + 无机械错误与可疑信号 · "
        "审计账本见 <code>status-dashboard.md</code></p>"
    )
    ht.append("<div class='cards'>")
    ht.append(f"<div class='card ok'><b>{counts['可交开发']}</b><span>可交开发</span></div>")
    ht.append(f"<div class='card blocked'><b>{counts['被依赖阻塞']}</b><span>被依赖阻塞</span></div>")
    ht.append(f"<div class='card wip'><b>{counts['待深化']}</b><span>待深化</span></div>")
    ht.append(f"<div class='card warn'><b>{counts['存疑']}</b><span>存疑</span></div>")
    ht.append(f"<div class='card'><b>{open_oq_total}</b><span>未决 OQ</span></div>")
    ht.append(f"<div class='card'><b>{flow_ready}/{len(flows) or '—'}</b><span>端到端链路就绪</span></div>")
    ht.append("</div>")

    if suggestion:
        ht.append("<div class='next'><b>下一步建议:深化 "
                  f"{h(suggestion['name'])}</b> <span class='muted'>({h(suggestion['slug'])})</span>"
                  f"<ul><li>原因:{h(suggestion['reason'])}</li>")
        if suggestion["pending"]:
            ht.append("<li>需要先定案:" + "、".join(h(p) for p in suggestion["pending"]) + "</li>")
        ht.append("</ul></div>")

    ht.append("<div class='fbar'>"
              "<button class='fbtn on' data-f='all'>全部</button>"
              "<button class='fbtn' data-f='ok'>可交开发</button>"
              "<button class='fbtn' data-f='blocked'>被依赖阻塞</button>"
              "<button class='fbtn' data-f='wip'>待深化</button>"
              "<button class='fbtn' data-f='warn'>存疑</button></div>")

    def render_module_row(m):
        cells = [f"<td class='mod'><b>{h(m['title'])}</b>"
                 f"<span class='slug'>{h(m['key'])}</span></td>"]
        cells.append(f"<td><span class='tag {m['css']}'>{h(m['label'])}</span><br>"
                     f"<span class='muted' style='font-size:.75rem'>{h(m['depth'])}</span></td>")
        short = "<td class='short'>"
        if m["shortboard"]:
            short += "<ul>" + "".join(f"<li>{h(s)}</li>" for s in m["shortboard"]) + "</ul>"
        else:
            short += "<span class='muted'>—</span>"
        if m["deps"]:
            short += ("<details><summary>完整依赖 " + str(len(m["deps"])) + " 项</summary><ul>"
                      + "".join(f"<li>{h(name)} <code>{h(s)}</code>({h(d)})</li>"
                                for s, name, d in m["deps"]) + "</ul></details>")
        short += "</td>"
        cells.append(short)
        oq = "<td>"
        if m["open_oq"]:
            oq += f"{m['open_oq']} 个未决"
        elif m["oq_items"]:
            oq += "<span class='muted'>已全部定案</span>"
        else:
            oq += "<span class='muted'>—</span>"
        if m["oq_items"]:
            oq += ("<details><summary>展开 " + str(len(m["oq_items"])) + " 条</summary><ul>"
                   + "".join(
                       f"<li class='{'oq-done' if resolved else ''}'>"
                       f"<code>{h(oid)}</code> {h(summary)}</li>"
                       for oid, summary, resolved in m["oq_items"]) + "</ul></details>")
        oq += "</td>"
        cells.append(oq)
        cells.append(f"<td class='muted'>{h(m['signals'])}</td>")
        return f"<tr data-status='{m['css']}'>" + "".join(cells) + "</tr>"

    for sysdir in sorted({m["sysdir"] for m in vm}):
        group = [m for m in vm if m["sysdir"] == sysdir]
        group.sort(key=lambda m: (STATUS_ORDER[m["label"]], m["order"], m["slug"]))
        sys_suffix = (f" <span class='muted' style='font-size:.75rem'>({h(sysdir)})</span>"
                      if sysdir else "")
        ht.append(f"<h2>{h(system_names.get(sysdir, sysdir or '单系统'))}{sys_suffix}</h2>")
        ht.append("<table><tr><th style='width:26%'>模块</th><th style='width:11%'>状态</th>"
                  "<th style='width:30%'>短板</th><th style='width:18%'>开放问题</th>"
                  "<th>机械信号</th></tr>")
        ht.extend(render_module_row(m) for m in group)
        ht.append("</table>")

    ht.append("<h2>领域规格 <span class='muted' style='font-size:.75rem'>(00-global/domain-specs)</span></h2>")
    ht.append("<table><tr><th style='width:26%'>领域规格</th><th style='width:11%'>状态</th>"
              "<th style='width:30%'>被引用</th><th style='width:18%'>开放问题</th><th>机械信号</th></tr>")
    for slug, info, v in sorted(spec_rows, key=lambda r: (STATUS_ORDER[status_label(r[2])], r[0])):
        rel = str(info["path"].relative_to(root))
        label = status_label(v)
        users = [m["title"] for m in vm if slug in (d[0] for d in m["deps"])]
        open_oq, oq_items = oq_view(info["oq"])
        oq_cell = f"{open_oq} 个未决" if open_oq else "<span class='muted'>—</span>"
        if oq_items:
            oq_cell += ("<details><summary>展开</summary><ul>"
                        + "".join(f"<li class='{'oq-done' if r_ else ''}'>"
                                  f"<code>{h(oid)}</code> {h(sm)}</li>"
                                  for oid, sm, r_ in oq_items) + "</ul></details>")
        ht.append(
            f"<tr data-status='{STATUS_CSS[label]}'><td class='mod'><b>{h(info['title'])}</b>"
            f"<span class='slug'>{h(slug)}</span></td>"
            f"<td><span class='tag {STATUS_CSS[label]}'>{h(label)}</span><br>"
            f"<span class='muted' style='font-size:.75rem'>{h(info['depth'])}</span></td>"
            f"<td class='muted'>{h('、'.join(users) or '—')}</td>"
            f"<td>{oq_cell}</td><td class='muted'>{h(sig_text(info, rel))}</td></tr>"
        )
    ht.append("</table>")

    if flows:
        ht.append("<h2>端到端链路</h2>")
        ht.append("<table><tr><th style='width:24%'>链路</th><th style='width:16%'>进度</th>"
                  "<th style='width:34%'>最短板</th><th>涉及模块</th></tr>")
        title_of = {m["key"]: m["title"] for m in vm}
        for title, involved in flows:
            ok_n = sum(1 for k in involved if vmap.get(k) == "可交开发")
            pct = int(ok_n / len(involved) * 100) if involved else 0
            not_ready = [k for k in involved if vmap.get(k) != "可交开发"]
            shortest = "、".join(
                f"{title_of.get(k, k)}({status_label(vmap.get(k, '存疑'))})" for k in not_ready
            ) or "—"
            ht.append(
                f"<tr class='flow'><td>{h(title)}</td>"
                f"<td><div class='bar'><i style='width:{pct}%'></i></div>"
                f"<span class='muted' style='font-size:.75rem'>{ok_n}/{len(involved)}</span></td>"
                f"<td class='muted'>{h(shortest)}</td>"
                f"<td class='muted'>{h('、'.join(title_of.get(k, k) for k in involved))}</td></tr>"
            )
        ht.append("</table>")
    if check_err:
        ht.append(f"<p class='meta'>注意:{h(check_err)},机械信号列可能不完整。</p>")
    ht.append(f"<script>{js}</script>")
    html_text = "\n".join(ht) + "\n"

    out_md = root / "00-global" / "status-dashboard.md"
    out_html = root / "00-global" / "status-dashboard.html"
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text(md_text, encoding="utf-8")
    out_html.write_text(html_text, encoding="utf-8")
    print(f"已生成: {out_md}")
    print(f"已生成: {out_html}")
    print(f"模块就绪 {ready}/{len(rows)};路径就绪 {flow_ready}/{len(flows)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
