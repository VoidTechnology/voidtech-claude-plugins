#!/usr/bin/env python3
"""PRD 工作树机械自检(薄入口,检查逻辑在 prdsync/markdown_validator.py)。

用法:
    python3 check-prd-tree.py <工作树> [--operation-id <id>]

只使用 Python 标准库。正则类检查项与 SKILL.md「机械自检」一节一一对应,
实现见 prdsync/markdown_validator.py(占位符残留、断链、绝对路径、生成物
声明、空文件与 TODO、推断标记审计、开放问题对账、深度声明、编号零填充、
幽灵状态、验收级核验记录)。

文件集来源(技术设计 §9):
- 默认模式: 先查读取栅栏——存在 publishing / publish-conflict 状态的
  operation 时报告 operation id 并退出码 3,零写入,不自行恢复(恢复走
  `prd-sync recover`);否则经 effective_view.resolve_view 取当前有效视图,
  自动排除 `_source/reconciliation/`(operations staging/backup 不重复计入)。
- `--operation-id`: 经 overlay resolver 读取「当前有效视图 + 该 operation
  staging」的预提交合成视图,同一逻辑文件只出现一次;不查栅栏(预提交
  自检语义)。

能力分层: 工作树存在 prd-worktree.json 且 capabilities.logicAtlas 开启且
非 --operation-id 模式时,追加 atlas.check_freshness 严格只读新鲜度检查,
contentFresh 为 False 时每条 reason 计为一个错误(§10: 带外修改报 stale,
检查器永不写文件)。legacy 工作树(无 prd-worktree.json)行为不变。

退出码: 0 = 通过(可有警告), 1 = 存在错误, 2 = 用法错误, 3 = 读取栅栏。
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from prdsync import atlas, effective_view, markdown_validator  # noqa: E402


def _logic_atlas_enabled(root: Path) -> bool:
    manifest_path = root / "prd-worktree.json"
    if not manifest_path.exists():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    capabilities = manifest.get("capabilities")
    return bool(isinstance(capabilities, dict) and capabilities.get("logicAtlas"))


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="check-prd-tree.py", description="PRD 工作树机械自检(严格只读)")
    parser.add_argument("worktree", help="PRD 工作树根目录")
    parser.add_argument(
        "--operation-id", default=None,
        help="经 overlay resolver 检查该 operation 的预提交合成视图")
    args = parser.parse_args(argv)

    root = Path(args.worktree).resolve()
    if not root.is_dir():
        print(f"错误: 目录不存在: {root}")
        return 2

    if args.operation_id is None:
        blocking = effective_view.blocking_operations(root)
        if blocking:
            print(
                "错误: 读取栅栏生效,存在未完成发布的 operation: "
                + ", ".join(blocking), file=sys.stderr)
            print(
                "提示: 本检查器零写入,不自行恢复;先运行 prd-sync recover 后重试。",
                file=sys.stderr)
            return 3
        files = effective_view.resolve_view(root)
    else:
        try:
            files = effective_view.resolve_view(root, args.operation_id)
        except (OSError, ValueError, KeyError):
            print(f"错误: operation 清单不存在或不可读: {args.operation_id}")
            return 2

    errors, warnings, md_count = markdown_validator.validate(root, files)

    if args.operation_id is None and _logic_atlas_enabled(root):
        freshness = atlas.check_freshness(root)
        if not freshness.get("contentFresh"):
            for reason in freshness.get("reasons", []):
                errors.append(
                    f"Logic Atlas 内容过期(stale): {reason}"
                    "——需经显式 operation 重新发布,本检查器零写入"
                )

    for line in errors:
        print(f"错误: {line}")
    for line in warnings:
        print(f"警告: {line}")
    print(f"\n检查完成: {md_count} 个文件, {len(errors)} 个错误, {len(warnings)} 个警告")
    if warnings:
        print("警告不阻塞交付,但必须在最终回复中逐条说明处理方式。")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
