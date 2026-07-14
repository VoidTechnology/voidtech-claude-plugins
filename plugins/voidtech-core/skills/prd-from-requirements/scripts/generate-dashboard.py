#!/usr/bin/env python3
"""生成 PRD 工作树状态看板(生成物,禁止手改)。

用法:
    python3 generate-dashboard.py <输出目录>

从已有的机器可读信号自动汇总,不需要任何人再填一遍状态:
- 各模块/领域规格头部的「深度」声明与「引用领域规格」列表
- 追溯矩阵的「需求 ID 区间 → 归属模块」映射
- cross-system-flows.md 的流程步骤需求编号(推导端到端路径视图)
- check-prd-tree.py 的机械检查结果(同目录,子进程调用)

就绪判定(模块可交开发的定义,自报深度与机械信号分离展示):
    可交开发   = 自身验收级 + 引用的领域规格全部验收级
                 + 自身与依赖无机械错误、无可疑信号
    存疑       = 深度声明达标但机械信号与之矛盾(含「样例」、追溯区间行、
                 疑似未定义状态、机械错误)
    被依赖阻塞 = 自身验收级,但引用的领域规格还是骨架级
    待深化     = 自身还是骨架级

输出:
    <输出目录>/00-global/status-dashboard.md   权威版,进 git、可 diff
    <输出目录>/00-global/status-dashboard.html 可视版,自包含,浏览器直接打开

只使用 Python 标准库。
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
TITLE_RE = re.compile(r"^#\s+(.+)$", re.M)
OQ_ID_RE = re.compile(r"OQ-[A-Za-z0-9][A-Za-z0-9_-]*")
OQ_DEF_RE = re.compile(r"^\s*\|\s*(OQ-[A-Za-z0-9][A-Za-z0-9_-]*)\s*\|")
REQ_RANGE_RE = re.compile(r"([A-Z]{2,6})-(\d{1,4})(?:\s*~\s*(?:[A-Z]{2,6}-)?(\d{1,4}))?")
MODULE_SLUG_RE = re.compile(r"\b(\d{2}-[a-z][a-z0-9-]+)\b")
FLOW_HEAD_RE = re.compile(r"^##\s+(.+)$", re.M)
TRACE_INTERVAL_RE = re.compile(r"\|\s*[A-Z]{2,6}-\d+\s*~")

CHECK_SCRIPT = Path(__file__).resolve().parent / "check-prd-tree.py"


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


def collect_modules(root):
    """系统目录下的模块 prd.md 与领域规格。返回 {key: info}。"""
    modules = {}
    for system_dir in sorted(root.glob("[0-9][0-9]-*")):
        if not system_dir.is_dir():
            continue
        for prd in sorted(system_dir.glob("[0-9]*/prd.md")):
            key = f"{system_dir.name}/{prd.parent.name}"
            modules[key] = parse_doc(prd, kind="module")
    specs = {}
    for spec in sorted((root / "00-global" / "domain-specs").glob("*.md")):
        if spec.name == "README.md":
            continue
        specs[spec.stem] = parse_doc(spec, kind="spec")
    return modules, specs


def parse_doc(path, kind):
    text = read(path)
    head = "\n".join(text.splitlines()[:20])
    depth_m = DEPTH_RE.search(head)
    title_m = TITLE_RE.search(text)
    spec_line_m = SPEC_LINE_RE.search(head)
    info = {
        "path": path,
        "kind": kind,
        "title": title_m.group(1).strip() if title_m else path.stem,
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
        slug_to_key.setdefault(key.split("/", 1)[1], key)
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


BADGE = {
    "可交开发": ("✅", "ok"),
    "被依赖阻塞": ("⛔", "blocked"),
    "待深化": ("🚧", "wip"),
}


def badge(v):
    for k, (icon, css) in BADGE.items():
        if v.startswith(k):
            return icon, css
    return "⚠️", "warn"


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    root = Path(sys.argv[1]).resolve()
    if not root.is_dir():
        print(f"错误: 目录不存在: {root}")
        return 2

    modules, specs = collect_modules(root)
    for info in modules.values():
        tokens = SLUG_TOKEN_RE.findall(info["spec_line"])
        info["specs"] = sorted({t for t in tokens if t in specs})
    ranges = parse_matrix_ranges(root)
    issues, check_err = run_check(root)
    flows = parse_flows(root, ranges, modules)
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    rows = []  # (key, info, verdict, blockers)
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

    ready = sum(1 for _, _, v, _ in rows if v == "可交开发")

    def sig_text(info, rel):
        own = issues_for(rel, issues)
        parts = list(info["signals"])
        if own["错误"]:
            parts.append(f"机械错误 {own['错误']}")
        if own["ghost"]:
            parts.append(f"疑似未定义状态 {own['ghost']}")
        return "、".join(parts) if parts else "—"

    # ---------- Markdown ----------
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
        icon, _ = badge(v)
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
        icon, _ = badge(v)
        md.append(f"| {slug} | {info['depth']} | {sig_text(info, rel)} | {icon} {v} |")
    md.append("")
    md.append("## 端到端路径")
    md.append("")
    if flows:
        md.append("| 路径 | 涉及模块 | 最短板 | 路径就绪 |")
        md.append("|---|---|---|---|")
        vmap = {key: v for key, _, v, _ in rows}
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

    # ---------- HTML ----------
    css = (
        "body{font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;"
        "margin:2rem auto;max-width:72rem;padding:0 1rem;line-height:1.6;color:#1a1a1a;background:#fff}"
        "h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}"
        ".meta{color:#666;font-size:.85rem}"
        "table{border-collapse:collapse;width:100%;font-size:.85rem;margin:.5rem 0}"
        "th,td{border:1px solid #d8d8d8;padding:.4rem .6rem;text-align:left;vertical-align:top}"
        "th{background:#f2f2f2}"
        ".ok{background:#e6f4ea}.blocked{background:#fdecea}.wip{background:#fff4e5}.warn{background:#fef7e0}"
        "@media(prefers-color-scheme:dark){body{color:#e6e6e6;background:#161616}"
        "th{background:#242424}th,td{border-color:#3a3a3a}"
        ".ok{background:#123a1e}.blocked{background:#46201c}.wip{background:#403014}.warn{background:#3d3512}}"
    )

    def h(s):
        return html.escape(str(s))

    ht = [f"<title>PRD 状态看板</title><style>{css}</style>"]
    ht.append("<h1>PRD 状态看板</h1>")
    ht.append(
        f"<p class='meta'>生成物,请勿手改。生成时间 {h(now)} · 就绪 {ready}/{len(rows)} 个模块 · "
        "判定 = 自身验收级 + 依赖规格全验收级 + 无机械错误与可疑信号</p>"
    )
    ht.append("<h2>模块就绪</h2><table><tr><th>模块</th><th>自报深度</th><th>引用领域规格</th><th>关联 OQ</th><th>机械信号</th><th>就绪判定</th></tr>")
    for key, info, v, blockers in rows:
        rel = str(info["path"].relative_to(root))
        specs_cell = "、".join(
            f"{s}({specs[s]['depth'] if s in specs else '缺失'})" for s in info["specs"]
        ) or "无"
        icon, cls = badge(v)
        note = f"(短板:{'、'.join(blockers)})" if blockers else ""
        ht.append(
            f"<tr class='{cls}'><td>{h(key)}</td><td>{h(info['depth'])}</td>"
            f"<td>{h(specs_cell)}</td><td>{h('、'.join(info['oq']) or '—')}</td>"
            f"<td>{h(sig_text(info, rel))}</td><td>{icon} {h(v + note)}</td></tr>"
        )
    ht.append("</table>")
    ht.append("<h2>领域规格</h2><table><tr><th>领域规格</th><th>自报深度</th><th>机械信号</th><th>状态</th></tr>")
    for slug, info, v in spec_rows:
        rel = str(info["path"].relative_to(root))
        icon, cls = badge(v)
        ht.append(
            f"<tr class='{cls}'><td>{h(slug)}</td><td>{h(info['depth'])}</td>"
            f"<td>{h(sig_text(info, rel))}</td><td>{icon} {h(v)}</td></tr>"
        )
    ht.append("</table>")
    if flows:
        vmap = {key: v for key, _, v, _ in rows}
        ht.append("<h2>端到端路径</h2><table><tr><th>路径</th><th>涉及模块</th><th>最短板</th><th>路径就绪</th></tr>")
        for title, involved in flows:
            not_ready = [k for k in involved if vmap.get(k) != "可交开发"]
            cls = "ok" if not not_ready else "blocked"
            status = "✅ 就绪" if not not_ready else "❌ 未就绪"
            shortest = "、".join(f"{k}({vmap.get(k, '?')})" for k in not_ready) or "—"
            ht.append(
                f"<tr class='{cls}'><td>{h(title)}</td><td>{h('、'.join(involved))}</td>"
                f"<td>{h(shortest)}</td><td>{status}</td></tr>"
            )
        ht.append("</table>")
    html_text = "\n".join(ht) + "\n"

    out_md = root / "00-global" / "status-dashboard.md"
    out_html = root / "00-global" / "status-dashboard.html"
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text(md_text, encoding="utf-8")
    out_html.write_text(html_text, encoding="utf-8")
    print(f"已生成: {out_md}")
    print(f"已生成: {out_html}")
    print(f"模块就绪 {ready}/{len(rows)};路径就绪 "
          f"{sum(1 for t, inv in flows if all(dict((k, v) for k, _, v, _ in rows).get(m) == '可交开发' for m in inv))}/{len(flows)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
