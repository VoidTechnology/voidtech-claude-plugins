#!/usr/bin/env python3
"""PRD 工作树机械自检。

用法:
    python3 check-prd-tree.py <输出目录>

只使用 Python 标准库。检查项与 SKILL.md「机械自检」一节一一对应:

1. 模板占位符 `{...}` 残留(围栏代码块与行内代码不计),
   含文件名与目录名中的 `{`/`}`。
2. 相对路径断链: 正文引用的 .md 路径必须能从所在文件位置解析到。
3. 工作树外绝对路径引用(权威源必须在 _source/ 内)。
4. 汇总 PRD(full-prd.md / *-full-prd.md)缺「生成物」声明头。
5. 空文件与 TODO/TBD/FIXME 残留。
6. 推断标记审计: 方括号 [推断]/[推荐默认] 之外的裸用法,
   以及「派生」「(默认」「推荐/默认…待确认」等变体标记。
7. 开放问题登记一致性: 被引用的 OQ 编号必须有定义行;
   「来源: 开放问题」必须带 OQ 编号;「开放问题 #n」式回指提示改用 OQ- 编号。
8. 核心文档头部深度声明缺失(模块与系统总览 prd.md、domain-specs、
   所有 *-matrix.md、两级汇总)。按文档角色匹配,改名不豁免。
9. 需求编号零填充一致性: 同一前缀混用 PTL-006 与 PTL-6 会导致
   grep 反查漏检。
10. 幽灵状态(启发式): 文件内含 mermaid stateDiagram 时,正文中
    「从 X 回到/转/进入 Y」式引用的状态必须在本文件某个状态机中定义。
    文件级并集判断,同名状态跨对象混用无法识别,人工复核仍不可省。
11. 验收级核验记录: 头部标「验收级」的文档,必须在
    00-global/deepening-backlog.md 的「验收级核验记录」小节有对应条目
    (做的人不能给自己认证)。缺条目报错误;整个 backlog 缺失时报警告。

退出码: 0 = 通过(可有警告), 1 = 存在错误, 2 = 用法错误。
"""

import re
import sys
from pathlib import Path

PLACEHOLDER_RE = re.compile(r"\{[^{}\n]+\}")
MD_LINK_RE = re.compile(r"\[[^\]]*\]\(([^)\s]+?)(?:#[^)]*)?\)")
TICK_PATH_RE = re.compile(r"`([^`\n]*/[^`\n]*?\.md)`")
ABS_PATH_RE = re.compile(r"(?<![\w./])(/(?:Users|home|root|var|opt|srv)/[^\s`\"')，。；]+)")
OQ_ID_RE = re.compile(r"OQ-[A-Za-z0-9][A-Za-z0-9_-]*")
OQ_DEF_RE = re.compile(r"^\s*\|\s*(OQ-[A-Za-z0-9][A-Za-z0-9_-]*)\s*\|")
TODO_RE = re.compile(r"\b(TODO|TBD|FIXME)\b")
BARE_MARK_RE = re.compile(r"(?<!\[)(推断|推荐默认)(?!\])")
INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
SOURCE_OQ_RE = re.compile(r"来源[:：][^|｜\n]*开放问题")

# 模板表头等合法出现「推断」的固定短语,不算裸标记
BARE_MARK_ALLOW = ("是否推断", "推断标记", "标注为推断")

# 被禁止的推断标记变体(SKILL.md「推断标记规范」),命中即警告
MARK_VARIANT_PATTERNS = (
    (re.compile(r"派生"), "「派生」"),
    (re.compile(r"推荐[，,、\s]*待确认"), "「推荐…待确认」"),
    (re.compile(r"默认[^\n。;；]{0,12}待确认"), "「默认…待确认」"),
    (re.compile(r"[（(]\s*默认"), "「(默认…)」"),
)

# 头部深度声明必须是列表行,如「- **深度**：验收级」或「- 深度:骨架级」
DEPTH_LINE_RE = re.compile(r"^\s*-\s*\*{0,2}深度\*{0,2}\s*[:：]", re.M)
DEPTH_VALUE_RE = re.compile(r"^\s*-\s*\*{0,2}深度\*{0,2}\s*[:：]\s*(\S+)", re.M)
DEPTH_HEAD_LINES = 15
REVIEW_SECTION_RE = re.compile(r"^#{2,3}\s*.*验收级核验记录.*$", re.M)

# 需求/开放问题编号,用于零填充一致性检查
REQ_ID_RE = re.compile(r"\b([A-Z]{2,6})-(\d{1,4})\b")
# 「开放问题 #n」式回指,应改用 OQ- 编号
HASH_OQ_RE = re.compile(r"(?:开放)?问题\s*#\d+")

# mermaid stateDiagram 的流转行,提取两端状态名
MERMAID_EDGE_RE = re.compile(r"^\s*(\S+)\s*-->\s*([^:\s]+)")
# 正文中的状态流转式引用,捕获疑似状态名
STATE_REF_RES = (
    re.compile(r"从\s*[「『\"']?([^「』\"'\s，,。;；()（）+/]{2,6})[」』\"']?\s*(?:回到|转|进入|变为)"),
    re.compile(r"(?:回到|流转到|进入|停在|变为|置为)\s*[「『\"']([^」』\"']{2,6})[」』\"']"),
)


def iter_lines(text):
    """产出 (行号, 原始行, 是否在围栏代码块内)。"""
    in_fence = False
    for lineno, line in enumerate(text.splitlines(), 1):
        stripped = line.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            yield lineno, line, True
            continue
        yield lineno, line, in_fence


def needs_depth_header(rel):
    """按文档角色匹配,而非精确文件名——改名(如 feature-permission-matrix)不豁免。"""
    name = rel.name
    if name == "prd.md" or name.endswith("full-prd.md"):
        return True
    if name.endswith("-matrix.md"):
        return True
    if rel.parent.name == "domain-specs" and name != "README.md":
        return True
    return False


def mermaid_states(text):
    """提取文件内所有 mermaid stateDiagram 定义的状态名(文件级并集)。"""
    states = set()
    in_fence = in_diagram = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("```"):
            if in_fence:
                in_fence = in_diagram = False
            else:
                in_fence = True
                in_diagram = "mermaid" in stripped
            continue
        if in_fence and in_diagram:
            if "stateDiagram" in stripped:
                continue
            m = MERMAID_EDGE_RE.match(line)
            if m:
                states.update(s for s in m.groups() if s != "[*]")
    return states


def state_defined(term, states):
    """允许包含关系,如正文「标记已退款」对状态「已退款标记」。"""
    return any(term in s or s in term for s in states)


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    root = Path(sys.argv[1]).resolve()
    if not root.is_dir():
        print(f"错误: 目录不存在: {root}")
        return 2

    errors = []
    warnings = []
    oq_defs = set()
    oq_refs = {}  # id -> 首次引用位置
    req_ids = {}  # prefix -> {numstr: 首次出现位置}
    acceptance_docs = []  # 头部标「验收级」的文档,需有核验记录

    # status-dashboard.* 是 generate-dashboard.py 的生成物,其信号列会复述
    # 被检词(如「样例」),不参与内容检查
    md_files = sorted(
        p for p in root.rglob("*.md")
        if "__pycache__" not in p.parts and p.name != "status-dashboard.md"
    )

    # 文件名与目录名中的占位符残留
    for path in sorted(root.rglob("*")):
        rel_str = str(path.relative_to(root))
        if "{" in rel_str or "}" in rel_str:
            errors.append(f"{rel_str}: 文件名或目录名残留模板占位符")

    # 第一遍: 收集 OQ 定义行
    for path in md_files:
        text = path.read_text(encoding="utf-8", errors="replace")
        for _, line, in_fence in iter_lines(text):
            if in_fence:
                continue
            m = OQ_DEF_RE.match(line)
            if m:
                oq_defs.add(m.group(1))

    # 第二遍: 逐文件检查
    for path in md_files:
        rel = path.relative_to(root)
        text = path.read_text(encoding="utf-8", errors="replace")

        if len(text.strip()) < 10:
            errors.append(f"{rel}: 空文件或内容不足 10 字符")
            continue

        head = "\n".join(text.splitlines()[:DEPTH_HEAD_LINES])
        if needs_depth_header(rel) and not DEPTH_LINE_RE.search(head):
            errors.append(f"{rel}: 头部缺少「深度」声明(骨架级/验收级)")
        depth_m = DEPTH_VALUE_RE.search(head)
        if depth_m and depth_m.group(1).startswith("验收级") and not rel.name.endswith("full-prd.md"):
            acceptance_docs.append(rel)
        if rel.name.endswith("full-prd.md") and "生成物" not in head:
            errors.append(f"{rel}: 汇总 PRD 头部缺少「生成物」声明")

        file_states = mermaid_states(text)

        for lineno, line, in_fence in iter_lines(text):
            if in_fence:
                continue
            plain = INLINE_CODE_RE.sub("", line)

            for m in PLACEHOLDER_RE.finditer(plain):
                errors.append(f"{rel}:{lineno}: 疑似模板占位符残留: {m.group(0)}")

            for m in ABS_PATH_RE.finditer(line):
                candidate = Path(m.group(1))
                try:
                    inside = candidate.resolve().is_relative_to(root)
                except (OSError, ValueError):
                    inside = False
                if not inside:
                    warnings.append(
                        f"{rel}:{lineno}: 引用了工作树外绝对路径: {m.group(1)}"
                        "(权威源应拷入 _source/ 或记录校验和)"
                    )

            targets = [t for t in MD_LINK_RE.findall(plain) if t.endswith(".md")]
            targets += TICK_PATH_RE.findall(line)
            for target in targets:
                if target.startswith(("http://", "https://", "mailto:", "/")):
                    continue
                resolved = (path.parent / target).resolve()
                if not resolved.exists():
                    errors.append(f"{rel}:{lineno}: 断链: {target}")

            for m in TODO_RE.finditer(plain):
                errors.append(f"{rel}:{lineno}: 残留 {m.group(1)}")

            for m in BARE_MARK_RE.finditer(plain):
                span = plain[max(0, m.start() - 6): m.end() + 6]
                if any(allow in span for allow in BARE_MARK_ALLOW):
                    continue
                warnings.append(
                    f"{rel}:{lineno}: 裸「{m.group(1)}」用法,应写作 [推断] 或 [推荐默认] 以便审计"
                )

            for pattern, label in MARK_VARIANT_PATTERNS:
                if pattern.search(plain):
                    warnings.append(
                        f"{rel}:{lineno}: 疑似推断标记变体 {label},"
                        "应改用 [推断] 或 [推荐默认];若为业务正文而非标记,在最终回复说明"
                    )

            for m in OQ_ID_RE.finditer(plain):
                oq_refs.setdefault(m.group(0), f"{rel}:{lineno}")

            if SOURCE_OQ_RE.search(plain) and not OQ_ID_RE.search(plain):
                errors.append(
                    f"{rel}:{lineno}: 「来源: 开放问题」未带 OQ 编号,无法与全局清单对账"
                )

            if HASH_OQ_RE.search(plain):
                warnings.append(
                    f"{rel}:{lineno}: 「开放问题 #n」式回指,应改用 OQ- 编号以便对账"
                )

            for prefix, numstr in REQ_ID_RE.findall(plain):
                if prefix == "OQ":
                    continue
                req_ids.setdefault(prefix, {}).setdefault(numstr, f"{rel}:{lineno}")

            if file_states:
                for pattern in STATE_REF_RES:
                    for m in pattern.finditer(plain):
                        term = m.group(1)
                        # 误报抑制: 否定语境(「不进入 X」)与页面/栏目名(常以「的」结尾)
                        if plain[max(0, m.start() - 1): m.start()] in ("不", "未"):
                            continue
                        if term.endswith("的"):
                            continue
                        if not state_defined(term, file_states):
                            warnings.append(
                                f"{rel}:{lineno}: 疑似幽灵状态「{term}」"
                                "——正文引用了本文件状态机中未定义的状态"
                            )

    for oq_id, first_ref in sorted(oq_refs.items()):
        if oq_id not in oq_defs:
            errors.append(f"{first_ref}: 引用了未定义的开放问题 {oq_id}(缺少定义表行)")

    # 验收级核验记录: 标验收级的文档必须在 backlog 核验记录小节有条目
    if acceptance_docs:
        backlog = root / "00-global" / "deepening-backlog.md"
        section = ""
        if backlog.exists():
            btext = backlog.read_text(encoding="utf-8", errors="replace")
            sec_m = REVIEW_SECTION_RE.search(btext)
            if sec_m:
                rest = btext[sec_m.end():]
                next_h = re.search(r"^#{2,3}\s", rest, re.M)
                section = rest[: next_h.start()] if next_h else rest
        for rel in acceptance_docs:
            ident = rel.parent.name if rel.name == "prd.md" else rel.stem
            if not backlog.exists():
                warnings.append(
                    f"{rel}: 标「验收级」但缺少 deepening-backlog.md,无处登记核验记录"
                )
            elif not section:
                errors.append(
                    f"{rel}: 标「验收级」但 deepening-backlog.md 无「验收级核验记录」小节"
                )
            elif ident not in section:
                errors.append(
                    f"{rel}: 标「验收级」但核验记录表中无「{ident}」条目"
                    "——验收级必须经独立核验,做的人不能给自己认证"
                )

    # 编号零填充一致性: 同一前缀出现过前导零,则更短的无前导零编号视为混用
    for prefix, nums in sorted(req_ids.items()):
        pad_widths = {len(n) for n in nums if n.startswith("0")}
        if not pad_widths:
            continue
        width = max(pad_widths)
        bad = sorted(
            (n, loc) for n, loc in nums.items()
            if len(n) < width and not n.startswith("0")
        )
        if bad:
            samples = "、".join(f"{prefix}-{n}({loc})" for n, loc in bad[:5])
            more = f" 等 {len(bad)} 处" if len(bad) > 5 else ""
            warnings.append(
                f"编号零填充混用: {prefix}- 前缀存在 {width} 位补零格式,"
                f"但出现未补零编号 {samples}{more},grep 反查会漏检"
            )

    for line in errors:
        print(f"错误: {line}")
    for line in warnings:
        print(f"警告: {line}")
    print(f"\n检查完成: {len(md_files)} 个文件, {len(errors)} 个错误, {len(warnings)} 个警告")
    if warnings:
        print("警告不阻塞交付,但必须在最终回复中逐条说明处理方式。")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
