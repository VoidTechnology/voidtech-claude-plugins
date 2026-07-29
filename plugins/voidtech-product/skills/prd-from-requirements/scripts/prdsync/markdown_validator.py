"""markdown 正则类检查的归置地（技术设计 §9）。

检查逻辑自 check-prd-tree.py 原样迁入（正则、允许清单、深度声明、
mermaid 状态对账等全部零改动），消费 overlay resolver（effective_view.
resolve_view）给出的「逻辑相对路径 → 实际文件」映射：staging 版本由
resolver 决定，同一逻辑文件只出现一次；本模块只读，不写任何文件。

对外接口:
    validate(root, files) -> (errors, warnings, md_file_count)

files 为 {逻辑相对路径(posix str): 实际文件 Path}；内容检查只处理 .md，
文件名占位符检查覆盖全部逻辑路径（含由文件路径推导出的目录名）。
"""

from __future__ import annotations

import posixpath
import re
from pathlib import Path, PurePosixPath

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

# 模板表头等合法出现「推断」「推荐默认」的固定短语,不算裸标记。
# 「推荐默认方案」是模板固定列名(见 templates/global-open-questions.md、
# cross-system-dependencies.md),不是漏标的裸标记。
BARE_MARK_ALLOW = (
    "是否推断", "推断标记", "标注为推断",
    "推荐默认方案", "推荐默认值", "推荐默认内容",
)

# 「推断」「推荐默认」这两个词既是标记,也是谈论标记体系时的普通名词。
# 「是原文而非推断」「挂推荐默认」「推荐默认是『不可出示』」「见推荐默认栏」
# 都是后者,不是漏标。漏标的形态是紧贴取值出现,前后不带这些虚词。
BARE_MARK_SKIP_LEFT = re.compile(
    r"(?:不是|而非|还是|并非|非|或|和|与|／|/|的|挂|裸|见|按|依|该|条|是|属)\s*$")
BARE_MARK_SKIP_RIGHT = re.compile(
    r"^\s*(?:的|是|为|与|和|栏|下|时|方案|内容|机制|取值|标记|规范|一栏)")

# 被禁止的推断标记变体(SKILL.md「推断标记规范」),命中即警告。
# 不再检「派生」——字段定义表的「来源 = 派生」是合法的第三类取值
# (由其他字段计算得出),与「把推断写成派生」无法机械区分,按
# 「写不进 checker 的就别写成规则」删除,规范由 SKILL.md 的正例约束。
MARK_VARIANT_PATTERNS = (
    # 表格单元格边界不可跨越: 「[推荐默认] | 待确认」是两格,不是一处变体
    (re.compile(r"推荐[，,、\s]*待确认"), "「推荐…待确认」"),
    (re.compile(r"默认[^\n。;；|｜]{0,12}待确认"), "「默认…待确认」"),
    (re.compile(r"[（(]\s*默认\s*(?:[:：]|[）)]|为|值)"), "「(默认…)」"),
)

# 汇总正文落盘: 本技能不产出汇总 PRD(SKILL.md「不生成汇总正文」)
FULL_PRD_NAME_RE = re.compile(r"(?:^|-)full-prd\.md$")

# 变更记录固定四列: 日期 | 版本 | 主题 | commit
CHANGELOG_HEADING_RE = re.compile(r"^#{2,4}\s*(?:[\d.]+[.、]?\s*)?变更记录\s*$")
CHANGELOG_COLUMNS = ("日期", "版本", "主题", "commit")
CHANGELOG_TOPIC_MAX = 80

# 变更记录格内禁止的「关于修改本身的声明」——可判真伪但对实现者零价值,
# 每条都是新造的、会被下一轮推翻的断言。
CHANGELOG_BANNED = (
    (re.compile(r"(?<![\d.])\d+\s*(?:条|项|处|个|类|档)"), "数量对账"),
    (re.compile(
        r"虚报|失实|更正上一版|更正 v|已修完|全部采纳|全部落实"
        r"|逐条核实|已确认修复|漏做|补做"), "关于修改本身的声明"),
    (re.compile(r"第\s*[一二三四五六七八九十\d]+\s*轮"), "核验轮次"),
    (re.compile(r"打回|核验"), "核验结论"),
)

# 跨节数目复述: 同一行既指向别的节、又复述那一节的规模
SECTION_REF_RE = re.compile(r"第\s*\d+(?:\.\d+)*\s*节|§\s*\d+(?:\.\d+)*")
CROSS_SECTION_COUNT_RE = re.compile(
    r"(?<![\d.／/-])(\d+)\s*(?:项|类|条|档|种|张)")
# 这些都不是表规模复述: 阈值上限、区间端点、序数索引(「第 6 项」)
THRESHOLD_LEFT_RE = re.compile(
    r"(?:最多|至多|最少|至少|不超过|不少于|不足|超过|超出|每|满|达|上限|下限"
    r"|限|第|≤|≥|<=|>=|<|>|~|至)\s*$")
THRESHOLD_RIGHT_RE = re.compile(r"^\s*(?:以上|以下|以内|起|之内|封顶|为止)")
# 表规模复述的量级只可能是小数目;三位数以上是业务阈值
CROSS_SECTION_COUNT_MAX = 100
# 覆盖率数字的持有点就是追溯矩阵自己,它写出各模块分布不算复述
COUNT_RULE_EXEMPT = ("requirement-traceability-matrix.md",)
# 治理文档只给指针不给数目: 它登记的每个数目都由别的文档持有,必然先过期
COUNT_FREE_DOCS = ("deepening-backlog.md",)
ANY_COUNT_RE = re.compile(r"(?<![\d.／/-])(\d+)\s*(?:项|类|条|档|种|张|个|份)")

# 表格前导句里的规模声明,必须与紧随其后的表格行数一致
LEADIN_COUNT_RE = re.compile(r"(?:共|计|合计|现表实数)\s*(\d+)\s*(项|类|条|档|个|种|张|行)")

# 声明为逐字引用的表列
VERBATIM_HEADER_RE = re.compile(r"原文\s*[（(]\s*(?:逐字|verbatim)\s*[）)]")
SOURCE_DIR = "_source"
TABLE_SEP_RE = re.compile(r"^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$")

# 头部深度声明必须是列表行,如「- **深度**：验收级」或「- 深度:骨架级」
DEPTH_LINE_RE = re.compile(r"^\s*-\s*\*{0,2}深度\*{0,2}\s*[:：]", re.M)
DEPTH_VALUE_RE = re.compile(r"^\s*-\s*\*{0,2}深度\*{0,2}\s*[:：]\s*(\S+)", re.M)
DEPTH_HEAD_LINES = 15
REVIEW_SECTION_RE = re.compile(r"^#{2,3}\s*.*验收级核验记录.*$", re.M)
ACCEPTANCE_LOGIC_MARKERS = (
    "页面契约（机器可解析）",
    "核心流程（机器可解析）",
    "流程状态影响（机器可解析）",
    "页面交互（机器可解析）",
    "状态机与状态流转",
    "页面数据读写（机器可解析）",
)

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

BACKLOG_RELPATH = "00-global/deepening-backlog.md"


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


def acceptance_section_has_content(text, marker):
    """验收级审计章节必须有数据行，或明确声明「不涉及：原因」。"""
    lines = text.splitlines()
    for index, line in enumerate(lines):
        heading = re.match(r"^(#{1,6})\s+.*$", line.strip())
        if not heading or marker not in line:
            continue
        level = len(heading.group(1))
        end = len(lines)
        for cursor in range(index + 1, len(lines)):
            next_heading = re.match(
                r"^(#{1,6})\s+", lines[cursor].strip())
            if next_heading and len(next_heading.group(1)) <= level:
                end = cursor
                break
        section = lines[index + 1:end]
        if re.search(r"不涉及\s*[:：]\s*\S+", "\n".join(section)):
            return True
        for cursor in range(len(section) - 2):
            if not section[cursor].strip().startswith("|"):
                continue
            separator = section[cursor + 1].strip()
            if not re.match(
                    r"^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$",
                    separator):
                continue
            for row in section[cursor + 2:]:
                stripped = row.strip()
                if stripped.startswith("#"):
                    break
                if stripped.startswith("|") and stripped.strip("| \t"):
                    return True
        return False
    return False


def needs_depth_header(rel: PurePosixPath):
    """按文档角色匹配,而非精确文件名——改名(如 feature-permission-matrix)不豁免。"""
    name = rel.name
    if name == "prd.md":
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


def split_row(line):
    """把 markdown 表格行拆成格;转义竖线 `\\|` 不当分隔符。"""
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|") and not body.endswith("\\|"):
        body = body[:-1]
    cells = re.split(r"(?<!\\)\|", body)
    return [c.strip() for c in cells]


def iter_tables(text):
    """产出 (表头行号, 表头格列表, [(数据行号, 数据格列表)])。围栏内不算表。"""
    lines = text.splitlines()
    in_fence = False
    index = 0
    while index < len(lines):
        stripped = lines[index].strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            index += 1
            continue
        if in_fence or not stripped.startswith("|"):
            index += 1
            continue
        if index + 1 >= len(lines) or not TABLE_SEP_RE.match(lines[index + 1].strip()):
            index += 1
            continue
        header = split_row(lines[index])
        rows = []
        cursor = index + 2
        while cursor < len(lines) and lines[cursor].strip().startswith("|"):
            rows.append((cursor + 1, split_row(lines[cursor])))
            cursor += 1
        yield index + 1, header, rows
        index = cursor


def normalize_quote(value):
    """逐字引文比对前的归一化: 去 markdown 强调、行内代码、转义与空白差异。"""
    text = value.replace("\\|", "|")
    text = re.sub(r"\*\*|__|`", "", text)
    text = re.sub(r"<br\s*/?>", "", text)
    return re.sub(r"\s+", "", text)


def changelog_section(text):
    """返回 (小节起始行号, 小节文本);无变更记录小节时返回 (None, "")。"""
    lines = text.splitlines()
    for index, line in enumerate(lines):
        heading = re.match(r"^(#+)", line.strip())
        if not heading or not CHANGELOG_HEADING_RE.match(line.strip()):
            continue
        level = len(heading.group(1))
        end = len(lines)
        for cursor in range(index + 1, len(lines)):
            head = re.match(r"^(#{1,6})\s+", lines[cursor].strip())
            if head and len(head.group(1)) <= level:
                end = cursor
                break
        return index + 1, "\n".join(lines[index + 1:end])
    return None, ""


def check_changelog(rel, text):
    """变更记录必须是固定四列,且格内不写关于修改本身的声明。"""
    errors = []
    start, section = changelog_section(text)
    if start is None:
        return errors
    tables = list(iter_tables(section))
    if not tables:
        return errors
    header_offset, header, rows = tables[0]
    lineno = start + header_offset
    if len(header) != len(CHANGELOG_COLUMNS) or not all(
            want.lower() in got.lower()
            for want, got in zip(CHANGELOG_COLUMNS, header)):
        errors.append(
            f"{rel}:{lineno}: 变更记录表头必须是固定四列"
            f"「{' | '.join(CHANGELOG_COLUMNS)}」,实际为「{' | '.join(header)}」"
            "——变更历史由 git 回答,正文不自证修改史"
        )
        return errors
    for row_offset, cells in rows:
        row_lineno = start + row_offset
        joined = " ".join(cells)
        for pattern, label in CHANGELOG_BANNED:
            hit = pattern.search(joined)
            if hit:
                errors.append(
                    f"{rel}:{row_lineno}: 变更记录禁止写{label}"
                    f"(命中「{hit.group(0)}」)——这类断言由 git diff 与 PR 承担"
                )
        if len(cells) >= 3 and len(cells[2]) > CHANGELOG_TOPIC_MAX:
            errors.append(
                f"{rel}:{row_lineno}: 变更记录主题超过 {CHANGELOG_TOPIC_MAX} 字"
                f"(实际 {len(cells[2])} 字),只允许一句话主题"
            )
    return errors


def _real_count(plain, hit):
    """排除阈值、区间端点与序数索引后,才算一处「写死的数目」。"""
    if THRESHOLD_LEFT_RE.search(plain[:hit.start()]):
        return False
    return not THRESHOLD_RIGHT_RE.match(plain[hit.end():])


def check_counts(rel, text):
    """数目失准的三种可机械判定形态。"""
    errors = []
    lines = text.splitlines()
    count_free = rel.name in COUNT_FREE_DOCS
    exempt = rel.name in COUNT_RULE_EXEMPT
    for lineno, line, in_fence in iter_lines(text):
        if in_fence:
            continue
        plain = INLINE_CODE_RE.sub("", line)
        if count_free:
            for hit in ANY_COUNT_RE.finditer(plain):
                if not _real_count(plain, hit):
                    continue
                errors.append(
                    f"{rel}:{lineno}: 治理文档不写数目「{hit.group(0).strip()}」"
                    "——这里登记的每个数目都由别的文档持有,只给指针"
                )
                break
        elif not exempt and SECTION_REF_RE.search(plain):
            for hit in CROSS_SECTION_COUNT_RE.finditer(plain):
                value = int(hit.group(1))
                if value <= 1 or value >= CROSS_SECTION_COUNT_MAX:
                    continue
                if not _real_count(plain, hit):
                    continue
                errors.append(
                    f"{rel}:{lineno}: 同一行既指向别处、又写死数目"
                    f"「{hit.group(0).strip()}」——数目只由持有那张表的位置自持,"
                    "引用方给指针不给数字"
                )
                break
    for header_lineno, _, rows in iter_tables(text):
        for back in range(1, 4):
            probe = header_lineno - 1 - back
            if probe < 0:
                break
            candidate = lines[probe]
            if not candidate.strip():
                continue
            hit = LEADIN_COUNT_RE.search(INLINE_CODE_RE.sub("", candidate))
            if hit and int(hit.group(1)) != len(rows):
                errors.append(
                    f"{rel}:{probe + 1}: 声明「{hit.group(0)}」"
                    f"与紧随表格的实际行数 {len(rows)} 不符"
                )
            break
    return errors


def check_verbatim(rel, text, source_blob):
    """标为逐字的引文必须能在 _source/ 中原样命中。"""
    errors = []
    if not source_blob:
        return errors
    for _, header, rows in iter_tables(text):
        columns = [i for i, cell in enumerate(header) if VERBATIM_HEADER_RE.search(cell)]
        if not columns:
            continue
        for lineno, cells in rows:
            for column in columns:
                if column >= len(cells):
                    continue
                quote = normalize_quote(cells[column])
                if len(quote) < 8 or quote in ("—", "-"):
                    continue
                if quote not in source_blob:
                    errors.append(
                        f"{rel}:{lineno}: 标为逐字的引文在 {SOURCE_DIR}/ 中找不到原样出处"
                        f"(「{cells[column][:40]}…」)——逐字声明必须逐字成立"
                    )
    return errors


def _link_exists(root: Path, rel: PurePosixPath, target: str, files: dict) -> bool:
    """按逻辑位置解析相对链接：树内看逻辑映射（staging/删除生效），树外回退文件系统。"""
    logical = posixpath.normpath(posixpath.join(str(rel.parent), target))
    if logical == ".." or logical.startswith("../"):
        candidate = (root / rel.parent / target).resolve()
        return candidate.exists()
    return logical in files


def validate(root, files):
    """对逻辑文件集执行全部机械检查,返回 (errors, warnings, md_file_count)。"""
    root = Path(root)
    errors = []
    warnings = []
    oq_defs = set()
    oq_refs = {}  # id -> 首次引用位置
    req_ids = {}  # prefix -> {numstr: 首次出现位置}
    acceptance_docs = []  # 头部标「验收级」的文档,需有核验记录

    # status-dashboard.* 是 generate-dashboard.py 的生成物,其信号列会复述
    # 被检词(如「样例」),不参与内容检查
    md_files = sorted(
        rel for rel in files
        if rel.endswith(".md")
        and "__pycache__" not in PurePosixPath(rel).parts
        and PurePosixPath(rel).name != "status-dashboard.md"
    )

    # 汇总正文不得落盘(SKILL.md「不生成汇总正文」)。没有生成器的「生成物」
    # 声明只能靠记性执行,而每处改动被手抄多份必然产生偏差。
    for rel in sorted(files):
        if FULL_PRD_NAME_RE.search(PurePosixPath(rel).name):
            errors.append(
                f"{rel}: 汇总正文不得落盘——模块 prd.md 是正文唯一存放处,"
                "整树导航写进 README.md 索引表与 status-dashboard.md"
            )

    # 逐字引文比对的底本: _source/ 全量正文归一化后拼接
    source_blob = "".join(
        normalize_quote(files[rel].read_text(encoding="utf-8", errors="replace"))
        for rel in sorted(files)
        if rel.endswith(".md") and PurePosixPath(rel).parts[:1] == (SOURCE_DIR,)
    )

    # 文件名与目录名中的占位符残留(目录名由逻辑文件路径推导)
    path_names = set()
    for rel in files:
        parts = PurePosixPath(rel).parts
        for i in range(1, len(parts) + 1):
            path_names.add("/".join(parts[:i]))
    for rel_str in sorted(path_names):
        if "{" in rel_str or "}" in rel_str:
            errors.append(f"{rel_str}: 文件名或目录名残留模板占位符")

    # 第一遍: 收集 OQ 定义行
    for rel in md_files:
        text = files[rel].read_text(encoding="utf-8", errors="replace")
        for _, line, in_fence in iter_lines(text):
            if in_fence:
                continue
            m = OQ_DEF_RE.match(line)
            if m:
                oq_defs.add(m.group(1))

    # 第二遍: 逐文件检查
    for rel_str in md_files:
        rel = PurePosixPath(rel_str)
        text = files[rel_str].read_text(encoding="utf-8", errors="replace")

        if len(text.strip()) < 10:
            errors.append(f"{rel}: 空文件或内容不足 10 字符")
            continue

        head = "\n".join(text.splitlines()[:DEPTH_HEAD_LINES])
        if needs_depth_header(rel) and not DEPTH_LINE_RE.search(head):
            errors.append(f"{rel}: 头部缺少「深度」声明(骨架级/验收级)")
        depth_m = DEPTH_VALUE_RE.search(head)
        if depth_m and depth_m.group(1).startswith("验收级"):
            acceptance_docs.append(rel)
            if rel.name == "prd.md" and len(rel.parts) >= 3:
                for marker in ACCEPTANCE_LOGIC_MARKERS:
                    if marker not in text:
                        errors.append(
                            f"{rel}: 验收级模块缺少审计结构「{marker}」")
                    elif not acceptance_section_has_content(text, marker):
                        errors.append(
                            f"{rel}: 验收级模块审计结构没有数据行"
                            f"且未声明不涉及「{marker}」")
        # _source/ 是权威源的转换产物,不是交付物,不受交付物的写法约束
        if rel.parts[:1] != (SOURCE_DIR,):
            errors.extend(check_changelog(rel, text))
            errors.extend(check_counts(rel, text))
            errors.extend(check_verbatim(rel, text, source_blob))

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
                if not _link_exists(root, rel, target, files):
                    errors.append(f"{rel}:{lineno}: 断链: {target}")

            for m in TODO_RE.finditer(plain):
                errors.append(f"{rel}:{lineno}: 残留 {m.group(1)}")

            for m in BARE_MARK_RE.finditer(plain):
                span = plain[max(0, m.start() - 6): m.end() + 6]
                if any(allow in span for allow in BARE_MARK_ALLOW):
                    continue
                if BARE_MARK_SKIP_LEFT.search(plain[:m.start()]):
                    continue
                if BARE_MARK_SKIP_RIGHT.match(plain[m.end():]):
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
                        # 「进入『动作入口』/页面」是导航标签组合，不是状态引用。
                        trailing = plain[m.end():m.end() + 4].lstrip()
                        if trailing.startswith(("/", "／")):
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
        backlog = files.get(BACKLOG_RELPATH)
        section = ""
        if backlog is not None:
            btext = backlog.read_text(encoding="utf-8", errors="replace")
            sec_m = REVIEW_SECTION_RE.search(btext)
            if sec_m:
                rest = btext[sec_m.end():]
                next_h = re.search(r"^#{2,3}\s", rest, re.M)
                section = rest[: next_h.start()] if next_h else rest
        for rel in acceptance_docs:
            ident = rel.parent.name if rel.name == "prd.md" else rel.stem
            if backlog is None:
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

    return errors, warnings, len(md_files)
