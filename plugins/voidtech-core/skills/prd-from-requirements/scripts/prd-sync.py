#!/usr/bin/env python3
"""prd-sync CLI：prdsync 引擎的薄封装（技术设计 §9；ADR-0004 §6/§8）。

只做四件事：参数解析、versioned 源推断、异常到退出码的映射、输出格式化。
所有业务逻辑（迁移、只读同步、三方归并、operation 生命周期、Atlas）都在
prdsync 包内，本文件不复制任何引擎逻辑。

退出码契约（全 CLI 统一）：
- 0 成功
- 1 引擎/业务错误
- 2 用法错误
- 3 读取栅栏（存在 publishing / publish-conflict operation，先 recover）
- 4 需要人工裁决/确认（迁移缺口、歧义裁决、rebaseline、恢复二选一）
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdsync import atlas, effective_view, merge, migration  # noqa: E402
from prdsync import operation_engine as engine  # noqa: E402
from prdsync import sync, writer_lock  # noqa: E402
from prdsync.canonical_store import (  # noqa: E402
    atomic_write_bytes, canonical_json_bytes, read_json)

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_USAGE = 2
EXIT_FENCE = 3
EXIT_DECISION = 4

REGISTRY_RELPATH = "_source/source-registry.json"
MANIFEST_RELPATH = "prd-worktree.json"
PROPOSALS_RELPATH = engine.PROPOSALS_RELPATH

# 生命周期动作面向 CLI 的合法值（目标状态映射在 merge._TARGET_STATE，单源）。
LIFECYCLE_ACTIONS = ("withdraw", "deprecate", "supersede", "remove",
                     "reactivate", "cancel-deprecation")

# recover --choice 的用户词汇到引擎 conflict_choice 实参的映射
# （operation_engine.recover_operation 接受 "override" / "keep"）。
RECOVER_CHOICE = {"overwrite": "override", "keep": "keep"}


class UsageError(Exception):
    """CLI 层用法错误（多源缺 --source 等），映射到退出码 2。"""


# ---------------------------------------------------------------- 输出

def _emit(args, payload, lines):
    """成功输出：--json 时只打机器 payload（canonical JSON），否则打中文摘要。"""
    if args.json:
        sys.stdout.write(canonical_json_bytes(payload).decode("utf-8"))
    else:
        for line in lines:
            print(line)


def _fail(args, exit_code, message, *, error_type, extra=None):
    print(f"错误：{message}", file=sys.stderr)
    if args is not None and getattr(args, "json", False):
        payload = {"error": {"type": error_type, "message": message}}
        if extra:
            payload["error"].update(extra)
        sys.stdout.write(canonical_json_bytes(payload).decode("utf-8"))
    return exit_code


def _cli_name():
    return Path(sys.argv[0]).name or "prd-sync.py"


# ---------------------------------------------------------------- 源推断

def _versioned_sources(root):
    registry = read_json(root / REGISTRY_RELPATH)
    return [s["sourceId"] for s in registry.get("sources", [])
            if s.get("mode") == "versioned"]


def _infer_source(root, explicit):
    """单 versioned 源自动推断；多源必须显式指定（ADR-0004 §6）。"""
    if explicit:
        return explicit
    registry_path = root / REGISTRY_RELPATH
    if not registry_path.exists():
        raise sync.SourceNotInitialized("<未注册>")
    versioned = _versioned_sources(root)
    if len(versioned) == 1:
        return versioned[0]
    if not versioned:
        raise sync.SourceNotInitialized("<无 versioned 源>")
    raise UsageError(
        f"存在多个 versioned 源（{', '.join(versioned)}），"
        "必须用 --source 显式指定（ADR-0004 §6）")


# ---------------------------------------------------------------- status

def _open_proposals(root):
    proposals_dir = root / PROPOSALS_RELPATH
    result = []
    if not proposals_dir.is_dir():
        return result
    for path in sorted(proposals_dir.glob("*.json")):
        try:
            proposal = read_json(path)
        except (OSError, ValueError):
            continue
        if proposal.get("status") == "open":
            result.append({"proposalId": proposal.get("proposalId", path.stem),
                           "proposalKind": proposal.get("proposalKind"),
                           "candidateRevision": proposal.get("candidateRevision")})
    return result


def _non_terminal_operations(root):
    result = []
    for operation_id in engine.list_non_terminal(root):
        try:
            phase = engine.load_manifest(root, operation_id).get("phase")
        except (OSError, ValueError):
            phase = None
        result.append({"operationId": operation_id, "phase": phase})
    return result


def cmd_status(root, args):
    manifest_path = root / MANIFEST_RELPATH
    manifest = read_json(manifest_path) if manifest_path.exists() else None
    capabilities = (manifest or {}).get("capabilities")

    sources = []
    registry_path = root / REGISTRY_RELPATH
    if registry_path.exists():
        registry = read_json(registry_path)
        state_path = root / sync.SYNC_STATE_RELPATH
        cursors_by_source = {}
        if state_path.exists():
            cursors_by_source = read_json(state_path).get("sources", {})
        for source in registry.get("sources", []):
            cursors = cursors_by_source.get(source["sourceId"]) or {}
            sources.append({
                "sourceId": source["sourceId"],
                "kind": source.get("kind"),
                "mode": source.get("mode"),
                "status": source.get("status"),
                "observedRevision": cursors.get("observedRevision"),
                "appliedRevision": cursors.get("appliedRevision"),
                "pendingRevision": cursors.get("pendingRevision"),
            })

    fence = effective_view.blocking_operations(root)
    atlas_report = None
    if capabilities and capabilities.get("logicAtlas"):
        atlas_report = atlas.check_freshness(root)

    payload = {
        "worktree": str(root),
        "capabilities": capabilities,
        "logicAtlasStage": (manifest or {}).get("logicAtlasStage"),
        "sources": sources,
        "openProposals": _open_proposals(root),
        "nonTerminalOperations": _non_terminal_operations(root),
        "readFence": fence,
        "atlas": atlas_report,
    }

    lines = [f"工作树：{root}"]
    if capabilities is None:
        lines.append("能力：未迁移（无 prd-worktree.json，先执行 migrate）")
    else:
        caps = "、".join(f"{name}={'开' if on else '关'}"
                         for name, on in sorted(capabilities.items()))
        lines.append(f"能力：{caps}")
    if sources:
        for source in sources:
            lines.append(
                f"源：{source['sourceId']}（{source['mode']}/{source['status']}）"
                f" applied={source['appliedRevision'] or '无'}"
                f" pending={source['pendingRevision'] or '无'}"
                f" observed={source['observedRevision'] or '无'}")
    else:
        lines.append("源：未注册")
    open_props = payload["openProposals"]
    lines.append("open proposal：" + (
        "、".join(p["proposalId"] for p in open_props) if open_props else "无"))
    non_terminal = payload["nonTerminalOperations"]
    lines.append("非终态 operation：" + (
        "、".join(f"{o['operationId']}({o['phase']})" for o in non_terminal)
        if non_terminal else "无"))
    if fence:
        lines.append(f"读取栅栏：{', '.join(fence)}"
                     f"（运行 {_cli_name()} recover {root} 恢复）")
    else:
        lines.append("读取栅栏：无")
    if atlas_report is not None:
        state = "新鲜" if atlas_report["contentFresh"] else (
            "过期（" + "、".join(atlas_report["reasons"]) + "）")
        lines.append(f"Atlas 新鲜度：{state}")
    _emit(args, payload, lines)
    return EXIT_OK


# ---------------------------------------------------------------- migrate

def _parse_kv(pairs, option):
    result = {}
    for pair in pairs or []:
        if "=" not in pair:
            raise UsageError(f"{option} 需要 KEY=VALUE 形式：{pair}")
        key, value = pair.split("=", 1)
        result[key] = value
    return result


def cmd_migrate(root, args):
    confirmations = {}
    if args.confirmations:
        confirmations.update(read_json(Path(args.confirmations)))
    confirmations.update(_parse_kv(args.confirm, "--confirm"))

    if args.dry_run or not confirmations:
        report = migration.analyze(root)
        payload = {"dryRun": True, **report}
        lines = ["迁移 dry-run（只读，零写入）："]
        lines.append(f"- 自动候选：{len(report['autoCandidates'])} 条")
        lines.append(f"- 人工确认项：{len(report['manualItems'])} 条")
        for item in report["manualItems"]:
            lines.append(f"  - {item['itemKey']}（sheet「{item['sheet']}」/"
                         f"{item['module']}）待确认目标编号")
        lines.append(f"- 区间级追溯缺口：{len(report['gaps'])} 组")
        for gap in report["gaps"]:
            lines.append(f"  - {gap['requirementRange']}（{gap['count']} 条，"
                         f"{gap['module']}）仅区间级映射")
        if not args.dry_run:
            lines.append("未提供任何确认项，按 dry-run 处理。提交请附 "
                         "--confirm KEY=REQ-ID 或 --confirmations file.json。")
        _emit(args, payload, lines)
        return EXIT_OK

    manifest = migration.commit_migration(root, confirmations)
    lines = [
        f"迁移已提交：operation {manifest['operationId']}（{manifest['phase']}）",
        f"revision 0：{manifest.get('targetRevision')}",
        "sourceSync 能力已开启，后续导入用 sync 命令。",
    ]
    _emit(args, manifest, lines)
    return EXIT_OK


# ---------------------------------------------------------------- sync / rebaseline

def cmd_sync(root, args):
    source_id = _infer_source(root, args.source)
    result = sync.sync_source(root, source_id, Path(args.input))
    if result["noOp"]:
        lines = [f"内容一致，no-op：{source_id} 仍停留在 {result['revisionId']}，"
                 "未创建新 revision。"]
    else:
        diff = result["rawDiff"]
        lines = [
            f"已导入 {source_id} 新 revision：{result['revisionId']}（pending）",
            f"原始差异：新增 {len(diff['added'])} 条、消失 {len(diff['removed'])} 条、"
            f"未变 {diff['unchangedCount']} 条",
            f"下一步：{_cli_name()} propose {root} 生成归并 proposal。",
        ]
    _emit(args, result, lines)
    return EXIT_OK


def cmd_rebaseline(root, args):
    source_id = _infer_source(root, args.source)
    columns = ([c.strip() for c in args.fingerprint_columns.split(",") if c.strip()]
               if args.fingerprint_columns else list(sync.DEFAULT_FINGERPRINT_COLUMNS))
    result = sync.rebaseline(root, source_id, fingerprint_columns=columns)
    payload = {"revisionId": result["revisionId"],
               "operation": result.get("operation")}
    lines = [f"rebaseline 完成：{source_id} 新基线 revision {result['revisionId']}。"]
    _emit(args, payload, lines)
    return EXIT_OK


# ---------------------------------------------------------------- propose / confirm

def cmd_propose(root, args):
    source_id = _infer_source(root, args.source)
    proposal = merge.propose_sync(root, source_id)

    buckets = {}
    for mapping in proposal["mappings"]:
        buckets.setdefault(mapping["classification"], []).append(mapping)
    lines = [f"proposal 已落盘：{proposal['proposalId']}"
             f"（candidate revision {proposal['candidateRevision']}）",
             "变更分类桶："]
    for classification in sorted(buckets):
        lines.append(f"- {classification}：{len(buckets[classification])} 条")
    if not buckets:
        lines.append("- （空）")

    ambiguities = proposal["ambiguities"]
    lines.append(f"歧义项：{len(ambiguities)} 条")
    for ambiguity in ambiguities:
        lines.append(f"- [{ambiguity['kind']}] {ambiguity['detail']}")
        for occ in ambiguity["occurrences"]:
            candidates = "、".join(ambiguity.get("candidateRequirementIds") or []) or "无"
            lines.append(f"  - occurrence {occ}（候选编号：{candidates}）")

    withdrawals = buckets.get("withdrawal-candidate", [])
    lines.append(f"撤回候选：{len(withdrawals)} 条")
    for mapping in withdrawals:
        lines.append(f"- {mapping['requirementId']}（{mapping['confidence']} 置信，"
                     f"occurrence {mapping['sourceOccurrenceId']}）")

    pending = [m["sourceOccurrenceId"] for m in buckets.get("new", [])]
    pending += [occ for a in ambiguities for occ in a["occurrences"]]
    if pending:
        lines.append("待人工裁决 occurrence（confirm 时逐条 --decision OCC=REQ-ID|new）：")
        for occ in pending:
            lines.append(f"- {occ}")

    lines.append("拟改文件：" + ("、".join(proposal["affectedFiles"]) or "无"))
    lines.append(f"确认命令：{_cli_name()} confirm {root} {proposal['proposalId']}")
    _emit(args, proposal, lines)
    return EXIT_OK


def cmd_confirm(root, args):
    decisions = {}
    if args.decisions:
        decisions.update(read_json(Path(args.decisions)))
    decisions.update(_parse_kv(args.decision, "--decision"))
    manifest = merge.commit_proposal(root, args.proposal_id, decisions=decisions)
    lines = [f"proposal {args.proposal_id} 已提交："
             f"operation {manifest['operationId']}（{manifest['phase']}）"]
    if manifest.get("targetRevision"):
        lines.append(f"appliedRevision 已推进到 {manifest['targetRevision']}。")
    _emit(args, manifest, lines)
    return EXIT_OK


# ---------------------------------------------------------------- 治理提案

def cmd_lifecycle(root, args):
    proposal = merge.propose_lifecycle(
        root, args.requirement_id, args.action, effective_at=args.effective_at)
    lines = [f"生命周期提案已落盘：{proposal['proposalId']}"
             f"（{args.requirement_id} → {args.action}）",
             f"提交命令：{_cli_name()} confirm {root} {proposal['proposalId']}",
             "主本修改与收尾走 prd-maintain 工况 5，本命令只落 journal 提案。"]
    _emit(args, proposal, lines)
    return EXIT_OK


def cmd_retire_source(root, args):
    proposal = merge.propose_source_retirement(root, args.source_id)
    lines = [f"退休源提案已落盘：{proposal['proposalId']}",
             f"提交命令：{_cli_name()} confirm {root} {proposal['proposalId']}"]
    _emit(args, proposal, lines)
    return EXIT_OK


def cmd_invalidate_assertions(root, args):
    proposal = merge.propose_assertion_invalidation(root, args.source_id)
    lines = [f"assertion 失效提案已落盘：{proposal['proposalId']}",
             f"提交命令：{_cli_name()} confirm {root} {proposal['proposalId']}"]
    _emit(args, proposal, lines)
    return EXIT_OK


# ---------------------------------------------------------------- 带外变更

def cmd_register_change(root, args):
    requirement_id = args.requirement
    if requirement_id == "new":
        ctx = merge._context(root)
        requirement_id = merge._allocate_ids(merge._existing_ids(ctx), 1)[0]
    manifest = merge.register_change(root, args.change_id, requirement_id, args.text)
    payload = dict(manifest)
    payload["requirementId"] = requirement_id
    lines = [f"带外变更 {args.change_id} 已登记到需求 {requirement_id}："
             f"operation {manifest['operationId']}（{manifest['phase']}）"]
    _emit(args, payload, lines)
    return EXIT_OK


# ---------------------------------------------------------------- recover

def cmd_recover(root, args):
    choice = RECOVER_CHOICE[args.choice] if args.choice else None
    actions = engine.recover_worktree(root, conflict_choice=choice)
    payload = {"actions": actions}
    if actions:
        lines = ["恢复完成："]
        lines += [f"- {operation_id}：{action}"
                  for operation_id, action in sorted(actions.items())]
    else:
        lines = ["无非终态 operation，无需恢复。"]
    _emit(args, payload, lines)
    return EXIT_OK


def _conflict_files(root, operation_id):
    """publish-conflict 的冲突文件清单（只读复用引擎的三态判定，不复制逻辑）。"""
    try:
        manifest = engine.load_manifest(root, operation_id)
        return [entry["path"] for entry in manifest["files"]
                if engine._entry_state(root, entry) == "conflict"]
    except Exception:  # noqa: BLE001 —— 报错兜底：退回受影响文件全集
        try:
            return [entry["path"] for entry in manifest["files"]]
        except Exception:  # noqa: BLE001
            return []


# ---------------------------------------------------------------- atlas

def cmd_atlas(root, args):
    if args.enable:
        manifest_path = Path(root) / "prd-worktree.json"
        if not manifest_path.exists():
            print("工作树未迁移（无 prd-worktree.json），先执行 migrate。", file=sys.stderr)
            return EXIT_ERROR
        manifest = read_json(manifest_path)
        manifest["capabilities"]["logicAtlas"] = True
        manifest["logicAtlasStage"] = args.enable
        manifest["schemaVersions"]["logicModel"] = 1
        atomic_write_bytes(manifest_path, canonical_json_bytes(manifest))
        lines = [f"Logic Atlas 能力已置位：stage={args.enable}。",
                 "生成/更新生成物请运行 atlas --publish。"]
        _emit(args, manifest, lines)
        return EXIT_OK
    if args.publish:
        manifest = atlas.publish(root)
        lines = [f"Atlas 已发布：operation {manifest['operationId']}"
                 f"（{manifest['phase']}）"]
        _emit(args, manifest, lines)
        return EXIT_OK
    if args.gate:
        result = atlas.gate_requirements(root)
        lines = [f"内容门（stage={result['stage']}）："]
        for step in result["steps"]:
            lines.append(f"- {step['id']}（{'阻塞' if step['blocking'] else '非阻塞'}）")
        if not result["steps"]:
            lines.append("- 无 Atlas 步骤（legacy 工作树）")
        _emit(args, result, lines)
        return EXIT_OK
    result = atlas.check_freshness(root)
    if result["contentFresh"]:
        lines = ["Atlas 内容新鲜。"]
    else:
        lines = ["Atlas 内容过期：" + "、".join(result["reasons"])]
    _emit(args, result, lines)
    return EXIT_OK


# ---------------------------------------------------------------- 解析器

def _build_parser():
    parser = argparse.ArgumentParser(
        prog="prd-sync.py",
        description="PRD 工作树来源同步 CLI（prdsync 引擎薄封装）")
    sub = parser.add_subparsers(dest="command", required=True)

    def add(name, help_text, **kwargs):
        p = sub.add_parser(name, help=help_text, **kwargs)
        p.add_argument("worktree", help="PRD 工作树路径")
        p.add_argument("--json", action="store_true",
                       help="输出机器可读 canonical JSON")
        return p

    add("status", "工作树能力、源游标、open proposal 与栅栏巡检").set_defaults(
        func=cmd_status, fence_exempt=True)

    p = add("migrate", "存量工作树迁移（无确认项时按 dry-run 处理）")
    p.add_argument("--dry-run", action="store_true", help="只读分析，不提交")
    p.add_argument("--confirm", action="append", metavar="KEY=REQ-ID",
                   help="人工确认项裁决，可重复")
    p.add_argument("--confirmations", metavar="FILE.json",
                   help="确认项 JSON 文件（itemKey → 需求编号）")
    p.set_defaults(func=cmd_migrate)

    p = add("sync", "只读导入源新版本（只推进 observed/pending）")
    p.add_argument("--input", required=True, metavar="FILE.xlsx", help="源文件路径")
    p.add_argument("--source", help="源 ID（单 versioned 源可省略）")
    p.set_defaults(func=cmd_sync)

    p = add("rebaseline", "规范化契约变化后的基线重建")
    p.add_argument("--source", help="源 ID（单 versioned 源可省略）")
    p.add_argument("--fingerprint-columns", metavar="COL1,COL2",
                   help="fingerprint 列（默认当前契约默认列）")
    p.set_defaults(func=cmd_rebaseline)

    p = add("propose", "三方归并 pending revision，产出可审阅 proposal")
    p.add_argument("--source", help="源 ID（单 versioned 源可省略）")
    p.set_defaults(func=cmd_propose)

    p = add("confirm", "按人工裁决提交 proposal")
    p.add_argument("proposal_id", help="proposal ID")
    p.add_argument("--decision", action="append", metavar="OCC=REQ-ID|new",
                   help="逐条裁决：occurrence 归属既有编号或 new，可重复")
    p.add_argument("--decisions", metavar="FILE.json",
                   help="裁决 JSON 文件（occurrence → 编号或 new）")
    p.set_defaults(func=cmd_confirm)

    p = add("lifecycle", "生命周期迁移提案（提交走 confirm）")
    p.add_argument("requirement_id", help="需求编号，如 REQ-001")
    p.add_argument("action", choices=LIFECYCLE_ACTIONS, help="生命周期动作")
    p.add_argument("--effective-at", metavar="ISO8601",
                   help="生效时点（审计字段，状态在提交时生效）")
    p.set_defaults(func=cmd_lifecycle)

    p = add("retire-source", "退休源提案（不再接受新 revision）")
    p.add_argument("source_id", help="源 ID")
    p.set_defaults(func=cmd_retire_source)

    p = add("invalidate-assertions", "批量失效某源 assertion 的提案")
    p.add_argument("source_id", help="源 ID")
    p.set_defaults(func=cmd_invalidate_assertions)

    p = add("register-change", "登记带外变更（change-stream 降级入口）")
    p.add_argument("--change-id", required=True, help="变更 ID，如 20260723-slug")
    p.add_argument("--requirement", required=True, metavar="REQ-ID|new",
                   help="归属需求编号；new 表示分配新编号")
    p.add_argument("--text", required=True, help="规范化后的需求正文")
    p.set_defaults(func=cmd_register_change)

    p = add("recover", "恢复全部非终态 operation")
    p.add_argument("--choice", choices=sorted(RECOVER_CHOICE),
                   help="publish-conflict 二选一：overwrite 覆盖第三方修改 / keep 保留并回滚")
    p.set_defaults(func=cmd_recover, fence_exempt=True)

    p = add("atlas", "Logic Atlas：新鲜度检查（默认）/发布/内容门")
    group = p.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true", help="新鲜度检查（默认）")
    group.add_argument("--publish", action="store_true", help="编译、校验并发布 Atlas")
    group.add_argument("--gate", action="store_true", help="按阶段列出内容门步骤")
    group.add_argument("--enable", choices=("markdown", "html", "polish"),
                       metavar="STAGE", help="置位 Atlas 能力阶段（markdown/html/polish）")
    p.set_defaults(func=cmd_atlas)

    return parser


# ---------------------------------------------------------------- main

def main(argv=None):
    parser = _build_parser()
    args = parser.parse_args(argv)
    root = Path(args.worktree)
    if not root.is_dir():
        return _fail(args, EXIT_ERROR, f"工作树不存在或不是目录：{root}",
                     error_type="WorktreeNotFound")

    try:
        if not getattr(args, "fence_exempt", False):
            effective_view.assert_read_fence(root)
        return args.func(root, args)
    except UsageError as exc:
        return _fail(args, EXIT_USAGE, str(exc), error_type="UsageError")
    except effective_view.ReadFenceError as exc:
        return _fail(
            args, EXIT_FENCE,
            f"读取栅栏生效（未完成发布的 operation：{', '.join(exc.operation_ids)}）。"
            f"先运行 {_cli_name()} recover {root} 恢复。",
            error_type="ReadFenceError",
            extra={"operationIds": exc.operation_ids})
    except migration.MigrationBlocked as exc:
        return _fail(
            args, EXIT_DECISION,
            "人工确认项未全部裁决，迁移未提交。缺少："
            + "、".join(exc.missing)
            + "。用 --confirm KEY=REQ-ID 或 --confirmations file.json 补齐。",
            error_type="MigrationBlocked", extra={"missing": exc.missing})
    except merge.DecisionRequired as exc:
        return _fail(
            args, EXIT_DECISION,
            "存在未裁决项，未提交任何内容。待裁决 occurrence："
            + "、".join(exc.occurrences)
            + "。用 --decision OCC=REQ-ID|new 逐条裁决。",
            error_type="DecisionRequired", extra={"occurrences": exc.occurrences})
    except sync.RebaselineRequired as exc:
        return _fail(
            args, EXIT_DECISION,
            f"规范化契约不一致，需要基线重建：{exc}。"
            f"先运行 {_cli_name()} rebaseline {root}。",
            error_type="RebaselineRequired")
    except engine.RecoveryChoiceRequired as exc:
        operation_id = exc.args[0] if exc.args else "<未知>"
        conflicts = _conflict_files(root, operation_id)
        return _fail(
            args, EXIT_DECISION,
            f"operation {operation_id} 处于 publish-conflict，需要二选一："
            f"--choice overwrite（覆盖第三方修改）或 --choice keep（保留并回滚）。"
            + ("冲突文件：" + "、".join(conflicts) if conflicts else ""),
            error_type="RecoveryChoiceRequired",
            extra={"operationId": operation_id, "conflictFiles": conflicts})
    except (sync.SourceNotInitialized, sync.SourceRetired,
            atlas.AtlasNotEnabled, atlas.AtlasValidationError,
            writer_lock.LockError, engine.OperationError) as exc:
        return _fail(args, EXIT_ERROR, str(exc), error_type=type(exc).__name__)
    except (OSError, ValueError, KeyError) as exc:
        return _fail(args, EXIT_ERROR, f"{type(exc).__name__}: {exc}",
                     error_type=type(exc).__name__)


if __name__ == "__main__":
    sys.exit(main())
