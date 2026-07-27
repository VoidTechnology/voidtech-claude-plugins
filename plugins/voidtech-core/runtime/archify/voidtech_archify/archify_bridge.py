"""Vendored Archify Lifecycle 渲染桥；失败只降级呈现，不阻塞内容门。"""

from __future__ import annotations

import concurrent.futures
import copy
import hashlib
import json
import re
import subprocess
import tempfile
from pathlib import Path
from types import SimpleNamespace

from . import architecture_ir, lifecycle_ir

MAX_REPAIR_ROUNDS = 8
_MIN_NODE_MAJOR = 18
_VENDOR_ROOT = Path(__file__).resolve().parents[3] / "vendor" / "archify"
_ARCHIFY_CLI = _VENDOR_ROOT / "bin" / "archify.mjs"
_TEMPLATE_PATH = _VENDOR_ROOT / "assets" / "template.html"

# SVG 语义类的样式与主题变量都定义在 Archify viewer 模板的 CSS 里；
# 导入裸 SVG 时必须把这两部分确定性地搬运并作用域化，否则全部元素
# 回落到 SVG 默认 fill:black（黑块回归，见 2026-07-24 验收）。
_CSS_STYLE_RE = re.compile(r"<style>(.*?)</style>", re.S)
_CSS_COMMENT_RE = re.compile(r"/\*.*?\*/", re.S)
_CSS_VAR_RE = re.compile(r"(--[\w-]+)\s*:\s*([^;]+)")
_CSS_CLASS_RE = re.compile(r"\.([\w-]+)")
_SVG_CLASS_ATTR_RE = re.compile(r'class="([^"]*)"')
_SVG_PRESET_ATTR_RE = re.compile(r'data-preset="([\w-]+)"')
_CSS_BASE_VARS_SELECTOR = ':root, [data-theme="dark"]'
_CSS_LIGHT_VARS_SELECTOR = '[data-theme="light"]'
_CSS_FORBIDDEN_RE = re.compile(
    r"@import|expression\s*\(|javascript:|<|url\(\s*(?!#)", re.I)


_ROUTE_SEQUENCE = (
    ("straight", None, None),
    ("drop", None, None),
    ("bottom-channel", None, None),
    ("bottom-channel", 410, None),
    ("bottom-channel", 392, None),
    ("right-channel", None, None),
    ("left-channel", None, 48),
)
_SUPPORTED_DIAGNOSTIC_CODES = {
    "clean-flow/edge-through-node",
    "layout/constraint",
    "artifact/legend-clearance",
}
_LABEL_AT_RE = re.compile(
    r'Label "(?P<label>[^"]+)".*?Suggested fix:\s*labelAt\s*'
    r'\[\s*(?P<x>-?\d+(?:\.\d+)?),\s*(?P<y>-?\d+(?:\.\d+)?)\s*\]',
    re.S)
_LABEL_PAIR_RE = re.compile(
    r'Labels "(?P<left>[^"]+)" and "(?P<right>[^"]+)" overlap.*?'
    r'Suggested fix:\s*add labelDy\s*(?P<dy>[+-]?\d+(?:\.\d+)?)',
    re.S)
_TOO_SHORT_RE = re.compile(
    r'^Transition "(?P<label>[^"]+)" is too short .*?'
    r'route it through a channel or drop its label\.$', re.S)


def _sha256(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def vendor_digest(vendor_root=None):
    """摘要覆盖 vendored Archify 的路径与字节，目录枚举顺序固定。"""
    root = Path(vendor_root or _VENDOR_ROOT)
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix().encode("utf-8")
        data = path.read_bytes()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return "sha256:" + digest.hexdigest()


def node_runtime(runner=subprocess.run, executable="node"):
    try:
        completed = runner(
            [executable, "--version"], capture_output=True, text=True,
            check=False, timeout=10)
    except (FileNotFoundError, OSError, subprocess.SubprocessError):
        return {"status": "unavailable", "code": "runtime/node-unavailable"}
    match = re.match(r"^v?(\d+)(?:\.\d+){0,2}", completed.stdout.strip())
    if completed.returncode != 0 or match is None:
        return {"status": "unavailable", "code": "runtime/node-version-invalid"}
    major = int(match.group(1))
    if major < _MIN_NODE_MAJOR:
        return {
            "status": "unavailable",
            "code": "runtime/node-version-unsupported",
            "major": major,
        }
    return {"status": "ok", "major": major}


def extract_single_svg(html):
    """逐字节保留唯一 SVG；零个或多个均视为不可信产物。"""
    starts = list(re.finditer(r"<svg(?:\s|>)", html, re.I))
    ends = list(re.finditer(r"</svg\s*>", html, re.I))
    if len(starts) != 1 or len(ends) != 1 or ends[0].start() < starts[0].start():
        raise ValueError("Archify HTML 必须恰好包含一个 SVG")
    return html[starts[0].start():ends[0].end()]


_SVG_TEXT_TAG_RE = re.compile(r"<text\b([^>]*)>([^<]*)</text>")
_SVG_ATTR_RE = re.compile(r'([\w:-]+)="([^"]*)"')
_SVG_VIEWBOX_RE = re.compile(r'viewBox="0 0 ([\d.]+) ([\d.]+)"')
# 与 vendor 一致的口径下限：最宽状态盒 126px（event 带半宽 63）。
_SUBLABEL_BOX_LIMIT = 126.0


def _est_text_width(text, font_size):
    """CJK 感知估宽：全宽字形 ≈ font_size px，半宽 ≈ 0.55×font_size。"""
    return sum(
        font_size if ord(ch) > 0x2E80 else font_size * 0.55 for ch in text)


def svg_text_overflows(svg):
    """SVG 文本几何审计（fail-closed 守门）。

    vendor 校验器按拉丁口径估宽且完全不校验子标签，中文文本可以通过
    deliver 却在画布上溢出（2026-07-24 客户套餐验收：子标签压邻、标签越界）。
    审计两类可判事实：任何文本横向越出 viewBox；子标签估宽超过最宽状态盒。
    返回违规描述列表，空列表即通过。
    """
    box = _SVG_VIEWBOX_RE.search(svg)
    if not box:
        return ["SVG 缺少 viewBox，无法审计文本几何"]
    width = float(box.group(1))
    violations = []
    for raw_attrs, content in _SVG_TEXT_TAG_RE.findall(svg):
        text = content.strip()
        if not text:
            continue
        attrs = dict(_SVG_ATTR_RE.findall(raw_attrs))
        try:
            x = float(attrs.get("x", ""))
        except ValueError:
            continue
        font_size = float(attrs.get("font-size", 12) or 12)
        est = _est_text_width(text, font_size)
        anchor = attrs.get("text-anchor", "start")
        if anchor == "middle":
            left, right = x - est / 2, x + est / 2
        elif anchor == "end":
            left, right = x - est, x
        else:
            left, right = x, x + est
        if left < -2 or right > width + 2:
            violations.append(
                f"文本「{text[:24]}」估宽 {est:.0f}px 越出 viewBox"
                f"（[{left:.0f},{right:.0f}] vs 0..{width:.0f}）")
        if attrs.get("data-detail") == "context" and est > _SUBLABEL_BOX_LIMIT:
            violations.append(
                f"子标签「{text[:24]}」估宽 {est:.0f}px 超过状态盒 "
                f"{_SUBLABEL_BOX_LIMIT:.0f}px，会压到相邻状态")
    return violations


def _template_css_rules(template_path=None):
    """扫描模板顶层 CSS 规则 → [(归一化选择器, 规则体)]。

    只取顶层：SVG 语义类与主题/preset 变量均定义在顶层；@media、@keyframes
    等 at-rule 整块跳过（其内没有本桥需要的规则，展开反而引入语义歧义）。
    """
    path = Path(template_path) if template_path else _TEMPLATE_PATH
    try:
        match = _CSS_STYLE_RE.search(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError):
        return None
    if not match:
        return None
    css = _CSS_COMMENT_RE.sub("", match.group(1))
    rules = []
    index, length = 0, len(css)
    while index < length:
        brace = css.find("{", index)
        if brace < 0:
            break
        selector = " ".join(css[index:brace].split())
        depth, cursor = 1, brace + 1
        while cursor < length and depth:
            if css[cursor] == "{":
                depth += 1
            elif css[cursor] == "}":
                depth -= 1
            cursor += 1
        if depth:
            return None
        if not selector.startswith("@"):
            rules.append((selector, css[brace + 1:cursor - 1].strip()))
        index = cursor
    return rules


def _css_vars(rules, selector):
    """按选择器全等取变量块；恰好一个才可信（模板漂移时 fail closed）。"""
    bodies = [body for candidate, body in rules if candidate == selector]
    if len(bodies) != 1:
        return None
    return {name: " ".join(value.split())
            for name, value in _CSS_VAR_RE.findall(bodies[0])}


def _format_vars(variables):
    return "".join(f"{name}:{variables[name]};" for name in sorted(variables))


def lifecycle_svg_css(class_tokens, presets, template_path=None,
                      scope_class="archify-lifecycle-svg"):
    """从 vendored 模板确定性抽取 SVG 语义 CSS 并作用域化。

    返回单份样式文本（同 scope 下所有嵌入 SVG 共用），任何一步不可信即返回
    None，调用方必须整体降级——裸嵌无样式 SVG 比内建图更糟。`scope_class`
    使同一抽取逻辑既服务 Lifecycle（.archify-lifecycle-svg）也服务 Architecture
    （.archify-architecture-svg）嵌入包裹类。主题桥接与 Atlas viewer 的层叠完全
    同构：默认亮色、`prefers-color-scheme` 暗色媒体查询、`:root[data-theme=…]`
    显式覆盖。
    """
    tokens = {token for token in class_tokens if token}
    if not tokens or not presets:
        return None
    rules = _template_css_rules(template_path)
    if not rules:
        return None
    base = _css_vars(rules, _CSS_BASE_VARS_SELECTOR)
    light = _css_vars(rules, _CSS_LIGHT_VARS_SELECTOR)
    if not base or not light:
        return None
    parts = []
    for preset in sorted(presets):
        preset_dark = _css_vars(
            rules, f'[data-preset="{preset}"][data-theme="dark"]')
        preset_light = _css_vars(
            rules, f'[data-preset="{preset}"][data-theme="light"]')
        if preset_dark is None or preset_light is None:
            return None
        dark_set = {**base, **preset_dark}
        light_set = {**base, **light, **preset_light}
        scope = f'.{scope_class} svg[data-preset="{preset}"]'
        parts.append(
            f"{scope}{{background:var(--bg);{_format_vars(light_set)}}}")
        parts.append(
            "@media (prefers-color-scheme: dark){"
            f"{scope}{{{_format_vars(dark_set)}}}}}")
        parts.append(
            f':root[data-theme="light"] {scope}{{{_format_vars(light_set)}}}')
        parts.append(
            f':root[data-theme="dark"] {scope}{{{_format_vars(dark_set)}}}')
    matched = False
    for selector, body in rules:
        selector_parts = [part.strip() for part in selector.split(",")]
        kept = [part for part in selector_parts
                if set(_CSS_CLASS_RE.findall(part)) & tokens]
        if not kept or not body:
            continue
        matched = True
        prefixed = ",".join(f".{scope_class} {part}" for part in kept)
        parts.append(f"{prefixed}{{{body}}}")
    if not matched:
        return None
    stylesheet = "\n".join(parts)
    if _CSS_FORBIDDEN_RE.search(stylesheet):
        return None
    return stylesheet


def svg_style_inputs(svgs):
    """从已渲染 SVG 收集类 token 与 preset（确定性、与来源逐字节绑定）。"""
    tokens, presets = set(), set()
    for svg in svgs:
        for attr in _SVG_CLASS_ATTR_RE.findall(svg):
            tokens.update(attr.split())
        presets.update(_SVG_PRESET_ATTR_RE.findall(svg))
    return tokens, presets


def _transition_for_diagnostic(ir, diagnostic):
    subject = diagnostic.get("subject") or {}
    transitions = ir.get("transitions") or []
    transition_id = subject.get("id")
    if transition_id:
        matches = [item for item in transitions if item.get("id") == transition_id]
        return matches[0] if len(matches) == 1 else None
    index = subject.get("index")
    if isinstance(index, int) and 0 <= index < len(transitions):
        return transitions[index]
    return None


def _set_route(transition, route, channel_y=None, channel_x=None):
    for key in ("via", "channelY", "channelX", "fromSide", "toSide"):
        transition.pop(key, None)
    transition["route"] = route
    if channel_y is not None:
        transition["channelY"] = channel_y
    if channel_x is not None:
        transition["channelX"] = channel_x


def _repair_clean_flow(ir, diagnostic):
    transition = _transition_for_diagnostic(ir, diagnostic)
    if transition is None:
        return False
    current = (
        transition.get("route") or "auto",
        transition.get("channelY"),
        transition.get("channelX"),
    )
    if current[0] == "auto":
        next_index = 0
    else:
        try:
            next_index = _ROUTE_SEQUENCE.index(current) + 1
        except ValueError:
            return False
    if next_index >= len(_ROUTE_SEQUENCE):
        return False
    _set_route(transition, *_ROUTE_SEQUENCE[next_index])
    return True


def _transitions_with_label(ir, label):
    return [item for item in ir.get("transitions", [])
            if item.get("label") == label]


def _number(value):
    parsed = float(value)
    return int(parsed) if parsed.is_integer() else parsed


def _repair_short_transition(ir, label):
    candidates = sorted(
        _transitions_with_label(ir, label),
        key=lambda item: item.get("id", ""))
    if not candidates:
        return False
    target = next((item for item in candidates
                   if item.get("fromSide") is None), candidates[0])
    pair = sorted([
        item for item in ir.get("transitions", [])
        if {item.get("from"), item.get("to")}
        == {target.get("from"), target.get("to")}
    ], key=lambda item: item.get("id", ""))
    side = "right" if pair.index(target) % 2 == 0 else "left"
    _set_route(
        target, f"{side}-channel", None, None if side == "right" else 48)
    target["fromSide"] = side
    target["toSide"] = side
    return True


def _repair_layout_constraint(ir, diagnostic):
    message = str(diagnostic.get("message") or "")
    short = _TOO_SHORT_RE.search(message)
    if short:
        return _repair_short_transition(ir, short.group("label"))
    match = _LABEL_AT_RE.search(message)
    if match:
        suggested = [_number(match.group("x")), _number(match.group("y"))]
        transitions = sorted(
            _transitions_with_label(ir, match.group("label")),
            key=lambda item: item.get("id", ""))
        candidates = [
            item for item in transitions
            if item.get("labelAt") != suggested
        ]
        if not candidates:
            return False
        candidates[0]["labelAt"] = suggested
        return True

    match = _LABEL_PAIR_RE.search(message)
    if match:
        candidates = sorted({
            item.get("id"): item
            for item in (
                _transitions_with_label(ir, match.group("left"))
                + _transitions_with_label(ir, match.group("right")))
            if item.get("id")
        }.values(), key=lambda item: item.get("id", ""))
        if len(candidates) < 2:
            return False
        target = next((item for item in candidates
                       if "labelDy" not in item and "labelAt" not in item),
                      candidates[0])
        delta = _number(match.group("dy"))
        if "labelAt" in target:
            target["labelAt"][1] += delta
        else:
            target["labelDy"] = delta + target.get("labelDy", 0)
        return True
    return False


def _repair_legend_clearance(ir, diagnostic):
    transition = _transition_for_diagnostic(ir, diagnostic)
    if transition is None:
        candidates = [item for item in ir.get("transitions", [])
                      if item.get("route") == "bottom-channel"]
        transition = min(candidates, key=lambda item: item.get("id", "")) if candidates else None
    if transition is None:
        return False
    channel_y = transition.get("channelY")
    if channel_y is None:
        _set_route(transition, "bottom-channel", 410, None)
        return True
    if channel_y <= 356:
        return False
    _set_route(transition, "bottom-channel", channel_y - 18, None)
    return True


def apply_diagnostic_repair(ir, diagnostic):
    """只按冻结 code 与受限 Suggested fix 语法做局部修复。"""
    code = diagnostic.get("code")
    if code == "clean-flow/edge-through-node":
        return _repair_clean_flow(ir, diagnostic)
    if code == "layout/constraint":
        return _repair_layout_constraint(ir, diagnostic)
    if code == "artifact/legend-clearance":
        return _repair_legend_clearance(ir, diagnostic)
    return False


def _safe_diagnostics(diagnostics, temporary_root=None, stderr=""):
    root_text = str(temporary_root) if temporary_root else ""
    safe = []
    for diagnostic in diagnostics or []:
        message = str(diagnostic.get("message") or "")
        if root_text:
            message = message.replace(root_text, "<temporary>")
        safe.append({
            "code": str(diagnostic.get("code") or "internal/unclassified"),
            "message": message[:500],
        })
    if not safe and stderr:
        message = stderr.replace(root_text, "<temporary>") if root_text else stderr
        safe.append({"code": "delivery/non-json", "message": message.strip()[:500]})
    return safe or [{"code": "delivery/unknown", "message": "Archify 未返回可解析诊断"}]


_RECEIPT_INVALID_CODE = "delivery/receipt-invalid"


def _ok_result(completed):
    """复核通过后，把 deliver 的非零退出码归一为成功，其余字段保持原样。"""
    return SimpleNamespace(
        returncode=0,
        stdout=getattr(completed, "stdout", ""),
        stderr=getattr(completed, "stderr", ""))


def _receipt_was_truncated(receipt):
    """deliver 因回执不可解析而失败（与真正的渲染失败区分开）。"""
    if receipt.get("ok") is True:
        return False
    return any(
        (item or {}).get("code") == _RECEIPT_INVALID_CODE
        for item in (receipt.get("diagnostics") or []))


def _recover_via_file_receipt(runner, executable, diagram_type, input_path,
                              output_path, work):
    """绕开 deliver 内层管道重做交付；无法复核时返回 None。

    vendored `deliver` 用 spawnSync(stdio:'pipe') 读 check 回执，而
    `check-render-output.mjs` 在 console.log 大 JSON 后立即 process.exit()。
    管道上 stdout 写是异步的，exit 会丢掉未排空的部分（约 64KB 后截断），
    于是一张渲染完全正常的图会因回执不可解析被误判为交付失败。

    按 vendor 政策不修改 vendored 代码，改从调用侧重做 deliver 的两步：
    - `render` 直接产出 output_path（deliver 在回执阶段失败时不会把候选产物
      提升过去，所以必须自己渲染，不能只对着不存在的文件重跑 check）；
    - `check` 是独立命令，其 runNode 用 stdio 'inherit'，没有内层管道；把
      stdout 重定向到文件即可拿到完整回执（文件写同步，不受 exit 截断影响）。

    只取回执的 ok 判定与失败项，不复制 vendor 的诊断分类表。
    """
    receipt_path = Path(work) / "check-receipt.json"
    try:
        rendered = runner([
            executable, str(_ARCHIFY_CLI), "render", diagram_type,
            str(input_path), str(output_path),
        ], capture_output=True, text=True, check=False, timeout=60)
        if getattr(rendered, "returncode", 1) != 0:
            return None
        with open(receipt_path, "w", encoding="utf-8") as handle:
            runner([
                executable, str(_ARCHIFY_CLI), "check", str(output_path),
            ], stdout=handle, stderr=subprocess.PIPE, text=True,
                check=False, timeout=60)
        return json.loads(receipt_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, UnicodeError, ValueError,
            subprocess.SubprocessError):
        return None


def _checker_failure_diagnostics(checker):
    """复核判定为失败时的诊断：只报可直接读出的失败项，不复制 vendor 分类表。"""
    failed = [
        str(check.get("name"))
        for check in (checker.get("checks") or []) if not check.get("ok")]
    composition = (checker.get("composition") or {}).get("status")
    detail = "；".join(filter(None, [
        ("未通过检查：" + "、".join(failed)) if failed else "",
        f"composition={composition}" if composition else "",
    ])) or "未给出可归类的失败项"
    return [{
        "code": "artifact/check-failed",
        "message": f"文件回执复核判定产物不合格：{detail}"[:500],
    }]


def _machine_maps(machine):
    return {
        "stateNodeIds": {
            lifecycle_ir.state_ir_id(node["nodeId"]): node["nodeId"]
            for node in machine["states"]
        },
        "transitionEdgeIds": {
            lifecycle_ir.transition_ir_id(edge["edgeId"]): edge["edgeId"]
            for edge in machine["transitions"]
        },
    }


def _degraded_machine(machine, ir, diagnostics, attempts):
    return {
        "machineId": machine["machineId"],
        "scopeId": machine["scopeId"],
        "object": machine["object"],
        "status": "degraded",
        "attempts": attempts,
        "ir": ir,
        "irDigest": _sha256(lifecycle_ir.canonical_ir_bytes(ir)),
        "diagnostics": diagnostics,
        **_machine_maps(machine),
    }


def render_machine(machine, ir, *, runner=subprocess.run, executable="node",
                   temp_root=None, runtime=None, max_rounds=MAX_REPAIR_ROUNDS):
    runtime = runtime or node_runtime(runner, executable)
    if runtime.get("status") != "ok":
        return _degraded_machine(machine, ir, [{
            "code": runtime.get("code", "runtime/node-unavailable"),
            "message": "Node.js 18+ 不可用，已降级为 Atlas 内建状态图",
        }], 0)

    owned_temp = None
    if temp_root is None:
        owned_temp = tempfile.TemporaryDirectory(prefix="prd-atlas-lifecycle-")
        work = Path(owned_temp.name)
    else:
        work = Path(temp_root) / machine["machineId"]
        work.mkdir(parents=True, exist_ok=True)
    working_ir = copy.deepcopy(ir)
    try:
        for attempt in range(1, max_rounds + 1):
            input_path = work / "lifecycle.json"
            output_path = work / "lifecycle.html"
            input_path.write_bytes(lifecycle_ir.canonical_ir_bytes(working_ir))
            try:
                completed = runner([
                    executable, str(_ARCHIFY_CLI), "deliver", "lifecycle",
                    str(input_path), str(output_path), "--json",
                ], capture_output=True, text=True, check=False, timeout=60)
            except (FileNotFoundError, OSError, subprocess.SubprocessError) as error:
                return _degraded_machine(machine, working_ir, [{
                    "code": "runtime/node-execution-failed",
                    "message": f"Node/Archify 执行失败：{type(error).__name__}",
                }], attempt)
            try:
                receipt = json.loads(completed.stdout)
            except (json.JSONDecodeError, TypeError):
                return _degraded_machine(
                    machine, working_ir,
                    _safe_diagnostics([], work, completed.stderr), attempt)
            if _receipt_was_truncated(receipt):
                checker = _recover_via_file_receipt(
                    runner, executable, "lifecycle", input_path, output_path,
                    work)
                if checker is not None:
                    if checker.get("ok") is True:
                        receipt = {"ok": True, "diagnostics": []}
                        completed = _ok_result(completed)
                    else:
                        return _degraded_machine(
                            machine, working_ir,
                            _checker_failure_diagnostics(checker), attempt)
            if completed.returncode == 0 and receipt.get("ok") is True:
                try:
                    svg = extract_single_svg(output_path.read_text(encoding="utf-8"))
                except (OSError, UnicodeError, ValueError) as error:
                    return _degraded_machine(machine, working_ir, [{
                        "code": "artifact/svg-invalid",
                        "message": str(error)[:500],
                    }], attempt)
                overflow = svg_text_overflows(svg)
                if overflow:
                    return _degraded_machine(machine, working_ir, [{
                        "code": "artifact/text-overflow",
                        "message": "；".join(overflow)[:500],
                    }], attempt)
                return {
                    "machineId": machine["machineId"],
                    "scopeId": machine["scopeId"],
                    "object": machine["object"],
                    "status": "ok",
                    "attempts": attempt,
                    "ir": working_ir,
                    "irDigest": _sha256(lifecycle_ir.canonical_ir_bytes(working_ir)),
                    "svg": svg,
                    "svgDigest": _sha256(svg.encode("utf-8")),
                    "diagnostics": [],
                    **_machine_maps(machine),
                }
            diagnostics = receipt.get("diagnostics") or []
            ordered = sorted(
                diagnostics,
                key=lambda item: (
                    str(item.get("code") or ""),
                    json.dumps(item.get("subject") or {}, sort_keys=True),
                    str(item.get("message") or ""),
                ))
            unsupported = [
                item for item in ordered
                if item.get("code") not in _SUPPORTED_DIAGNOSTIC_CODES
            ]
            if not ordered or unsupported:
                return _degraded_machine(
                    machine, working_ir,
                    _safe_diagnostics(diagnostics, work, completed.stderr), attempt)
            repaired = False
            for diagnostic in ordered:
                if apply_diagnostic_repair(working_ir, diagnostic):
                    repaired = True
            if not repaired:
                return _degraded_machine(
                    machine, working_ir,
                    _safe_diagnostics(diagnostics, work, completed.stderr), attempt)
        return _degraded_machine(machine, working_ir, [{
            "code": "repair/budget-exhausted",
            "message": f"Archify 自动修复达到 {max_rounds} 轮上限",
        }], max_rounds)
    finally:
        if owned_temp is not None:
            owned_temp.cleanup()


_ARCH_SCOPE_CLASS = "archify-architecture-svg"
# architecture 渲染路径可自动修复的诊断：仅标签-组件重叠（渲染器直接给出可用
# labelAt 目标坐标）。其余（如 clean-flow 穿卡）无法确定性反解 → 整体降级回
# viewer 内建总览图，绝不硬上。
_ARCH_SUPPORTED_DIAGNOSTIC_CODES = {"layout/constraint"}


def _arch_connection_by_id(ir, connection_id):
    for connection in ir.get("connections", []):
        if connection.get("id") == connection_id:
            return connection
    return None


def _repair_arch_label(ir, diagnostic):
    """按渲染器建议的显式 labelAt 目标坐标就地移动重叠标签（复用 _LABEL_AT_RE）。"""
    subject = diagnostic.get("subject") or {}
    connection = _arch_connection_by_id(ir, subject.get("id"))
    if connection is None:
        return False
    match = _LABEL_AT_RE.search(str(diagnostic.get("message") or ""))
    if not match:
        return False
    connection["labelAt"] = [_number(match.group("x")), _number(match.group("y"))]
    return True


def _degraded_architecture(model, ir, diagnostics, attempts):
    return {
        "status": "degraded",
        "attempts": attempts,
        "ir": ir,
        "irDigest": _sha256(architecture_ir.canonical_ir_bytes(ir)),
        "diagnostics": diagnostics,
        "componentModuleIds": architecture_ir.component_module_ids(model),
        "connectionEdgeIds": architecture_ir.connection_edge_ids(model),
    }


def render_architecture(model, ir, *, runner=subprocess.run, executable="node",
                        temp_root=None, runtime=None,
                        max_rounds=MAX_REPAIR_ROUNDS):
    """把 Architecture IR 经 fail-closed deliver 渲染为可嵌入 SVG；失败降级。

    与 render_machine 同构：复用 node_runtime / deliver 子进程 / extract_single_svg
    / svg_text_overflows / 诊断排序与 _safe_diagnostics，仅诊断修复词汇不同。
    """
    runtime = runtime or node_runtime(runner, executable)
    if runtime.get("status") != "ok":
        return _degraded_architecture(model, ir, [{
            "code": runtime.get("code", "runtime/node-unavailable"),
            "message": "Node.js 18+ 不可用，已降级为 Atlas 内建总览图",
        }], 0)

    owned_temp = None
    if temp_root is None:
        owned_temp = tempfile.TemporaryDirectory(prefix="prd-atlas-architecture-")
        work = Path(owned_temp.name)
    else:
        work = Path(temp_root) / "architecture"
        work.mkdir(parents=True, exist_ok=True)
    working_ir = copy.deepcopy(ir)
    try:
        for attempt in range(1, max_rounds + 1):
            input_path = work / "architecture.json"
            output_path = work / "architecture.html"
            input_path.write_bytes(architecture_ir.canonical_ir_bytes(working_ir))
            try:
                completed = runner([
                    executable, str(_ARCHIFY_CLI), "deliver", "architecture",
                    str(input_path), str(output_path), "--json",
                ], capture_output=True, text=True, check=False, timeout=60)
            except (FileNotFoundError, OSError, subprocess.SubprocessError) as error:
                return _degraded_architecture(model, working_ir, [{
                    "code": "runtime/node-execution-failed",
                    "message": f"Node/Archify 执行失败：{type(error).__name__}",
                }], attempt)
            try:
                receipt = json.loads(completed.stdout)
            except (json.JSONDecodeError, TypeError):
                return _degraded_architecture(
                    model, working_ir,
                    _safe_diagnostics([], work, completed.stderr), attempt)
            if _receipt_was_truncated(receipt):
                checker = _recover_via_file_receipt(
                    runner, executable, "architecture", input_path,
                    output_path, work)
                if checker is not None:
                    if checker.get("ok") is True:
                        receipt = {"ok": True, "diagnostics": []}
                        completed = _ok_result(completed)
                    else:
                        return _degraded_architecture(
                            model, working_ir,
                            _checker_failure_diagnostics(checker), attempt)
            if completed.returncode == 0 and receipt.get("ok") is True:
                try:
                    svg = extract_single_svg(
                        output_path.read_text(encoding="utf-8"))
                except (OSError, UnicodeError, ValueError) as error:
                    return _degraded_architecture(model, working_ir, [{
                        "code": "artifact/svg-invalid",
                        "message": str(error)[:500],
                    }], attempt)
                overflow = svg_text_overflows(svg)
                if overflow:
                    return _degraded_architecture(model, working_ir, [{
                        "code": "artifact/text-overflow",
                        "message": "；".join(overflow)[:500],
                    }], attempt)
                return {
                    "status": "ok",
                    "attempts": attempt,
                    "ir": working_ir,
                    "irDigest": _sha256(
                        architecture_ir.canonical_ir_bytes(working_ir)),
                    "svg": svg,
                    "svgDigest": _sha256(svg.encode("utf-8")),
                    "diagnostics": [],
                    "componentModuleIds":
                        architecture_ir.component_module_ids(model),
                    "connectionEdgeIds":
                        architecture_ir.connection_edge_ids(model),
                }
            diagnostics = receipt.get("diagnostics") or []
            ordered = sorted(
                diagnostics,
                key=lambda item: (
                    str(item.get("code") or ""),
                    json.dumps(item.get("subject") or {}, sort_keys=True),
                    str(item.get("message") or ""),
                ))
            unsupported = [
                item for item in ordered
                if item.get("code") not in _ARCH_SUPPORTED_DIAGNOSTIC_CODES
            ]
            if not ordered or unsupported:
                return _degraded_architecture(
                    model, working_ir,
                    _safe_diagnostics(diagnostics, work, completed.stderr),
                    attempt)
            repaired = False
            for diagnostic in ordered:
                if _repair_arch_label(working_ir, diagnostic):
                    repaired = True
            if not repaired:
                return _degraded_architecture(
                    model, working_ir,
                    _safe_diagnostics(diagnostics, work, completed.stderr),
                    attempt)
        return _degraded_architecture(model, working_ir, [{
            "code": "repair/budget-exhausted",
            "message": f"Archify 自动修复达到 {max_rounds} 轮上限",
        }], max_rounds)
    finally:
        if owned_temp is not None:
            owned_temp.cleanup()


def build_architecture(model, *, runner=subprocess.run, executable="node",
                       runtime=None):
    """渲染系统关系总览并抽取作用域化 CSS，产出可嵌入 viewer 的 architecture 载荷。"""
    runtime = runtime or node_runtime(runner, executable)
    ir = architecture_ir.build_architecture_ir(model)
    rendered = render_architecture(
        model, ir, runner=runner, executable=executable, runtime=runtime)
    css = ""
    if rendered["status"] == "ok":
        tokens, presets = svg_style_inputs([rendered["svg"]])
        extracted = lifecycle_svg_css(
            tokens, presets, scope_class=_ARCH_SCOPE_CLASS)
        if extracted is None:
            # 样式抽取失败时裸嵌 SVG 会整体回落 fill:black——整体降级回内建总览。
            rendered = _degraded_architecture(model, rendered["ir"], [{
                "code": "artifact/css-extraction-failed",
                "message": "无法从 vendored Archify 模板抽取 SVG 样式，"
                           "已降级为 Atlas 内建总览图",
            }], rendered["attempts"])
        else:
            css = extracted
    payload = {
        "schemaVersion": 1,
        "renderer": "archify-architecture",
        "runtime": runtime,
        "css": css,
        "cssDigest": _sha256(css.encode("utf-8")) if css else None,
    }
    payload.update(rendered)
    return payload


def build_presentation(model, *, runner=subprocess.run, executable="node"):
    machines = lifecycle_ir.extract_machines(model)
    runtime = node_runtime(runner, executable)

    def _render(machine):
        ir = lifecycle_ir.build_lifecycle_ir(machine)
        return render_machine(
            machine, ir, runner=runner, executable=executable, runtime=runtime)

    # 每台机器的渲染/修复循环相互独立、各用独立临时目录，可并发。结果按机器
    # 次序回收，确定性与串行一致（同输入字节一致，已回归验证）。仅在使用真实
    # subprocess 且多于一台机器时并发，避免影响注入 mock runner 的单测。
    if (runtime.get("status") == "ok" and runner is subprocess.run
            and len(machines) > 1):
        max_workers = min(8, len(machines))
        with concurrent.futures.ThreadPoolExecutor(
                max_workers=max_workers) as pool:
            rendered = list(pool.map(_render, machines))
    else:
        rendered = [_render(machine) for machine in machines]
    architecture = build_architecture(
        model, runner=runner, executable=executable, runtime=runtime)
    css = ""
    ok_machines = [item for item in rendered if item["status"] == "ok"]
    if ok_machines:
        tokens, presets = svg_style_inputs(
            item["svg"] for item in ok_machines)
        extracted = lifecycle_svg_css(tokens, presets)
        if extracted is None:
            # 样式抽取失败时裸 SVG 会整体渲染为黑块（fill 回落默认值），
            # 比内建状态图更糟——整体降级并如实标注。
            for item in ok_machines:
                item["status"] = "degraded"
                item.pop("svg", None)
                item.pop("svgDigest", None)
                item["diagnostics"] = [{
                    "code": "artifact/css-extraction-failed",
                    "message": "无法从 vendored Archify 模板抽取 SVG 样式，"
                               "已降级为 Atlas 内建状态图",
                }]
        else:
            css = extracted
    risks = [
        {
            "machineId": item["machineId"],
            "scopeId": item["scopeId"],
            "object": item["object"],
            "diagnostics": item["diagnostics"],
        }
        for item in rendered if item["status"] != "ok"
    ]
    if architecture["status"] != "ok":
        risks.append({
            "machineId": None,
            "scopeId": None,
            "object": "系统关系总览",
            "diagnostics": architecture["diagnostics"],
        })
    if runtime.get("status") != "ok" and not risks:
        risks.append({
            "machineId": None,
            "scopeId": None,
            "object": None,
            "diagnostics": [{
                "code": runtime.get("code", "runtime/node-unavailable"),
                "message": "Node.js 18+ 不可用",
            }],
        })
    return {
        "schemaVersion": 1,
        "renderer": "archify-lifecycle",
        "runtime": runtime,
        "css": css,
        "cssDigest": _sha256(css.encode("utf-8")) if css else None,
        "presentationRisk": risks,
        "machines": rendered,
        "architecture": architecture,
    }
