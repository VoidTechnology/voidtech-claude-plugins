"""定位并装载 voidtech-core 提供的 Archify Runtime。"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

_PACKAGE_NAME = "_voidtech_archify_runtime"
_RUNTIME_RELPATH = Path("runtime/archify/voidtech_archify")


def _registry_core_roots(registry):
    try:
        payload = json.loads(registry.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return
    records = payload.get("plugins", {}).get("voidtech-core@voidtech", [])
    for record in sorted(
        records,
        key=lambda item: item.get("lastUpdated", ""),
        reverse=True,
    ):
        install_path = record.get("installPath")
        if install_path:
            yield Path(install_path)


def _candidate_core_roots():
    configured = os.environ.get("VOIDTECH_CORE_ROOT")
    if configured:
        yield Path(configured).expanduser()

    product_root = Path(__file__).resolve().parents[4]
    yield product_root.parent / "voidtech-core"

    claude_root = Path(
        os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")
    ).expanduser()
    yield from _registry_core_roots(
        claude_root / "plugins" / "installed_plugins.json"
    )

    omp_registries = [Path.home() / ".omp" / "plugins" / "installed_plugins.json"]
    cwd = Path.cwd().resolve()
    omp_registries.extend(
        parent / ".omp" / "plugins" / "installed_plugins.json"
        for parent in (cwd, *cwd.parents)
    )
    seen = set()
    for registry in omp_registries:
        if registry in seen:
            continue
        seen.add(registry)
        yield from _registry_core_roots(registry)


def locate_runtime_package():
    checked = []
    for core_root in _candidate_core_roots():
        package_root = core_root / _RUNTIME_RELPATH
        checked.append(str(package_root))
        if (package_root / "__init__.py").is_file():
            return package_root
    locations = "\n- ".join(checked) if checked else "（无候选路径）"
    raise RuntimeError(
        "找不到 voidtech-core Archify Runtime。请安装并启用 "
        "voidtech-core@voidtech，或设置 VOIDTECH_CORE_ROOT。已检查：\n- "
        + locations
    )


def _load_runtime():
    loaded = sys.modules.get(_PACKAGE_NAME)
    if loaded is not None:
        return loaded
    package_root = locate_runtime_package()
    spec = importlib.util.spec_from_file_location(
        _PACKAGE_NAME,
        package_root / "__init__.py",
        submodule_search_locations=[str(package_root)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法装载 Archify Runtime：{package_root}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_PACKAGE_NAME] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(_PACKAGE_NAME, None)
        raise
    return module


_runtime = _load_runtime()
architecture_ir = _runtime.architecture_ir
archify_bridge = _runtime.archify_bridge
lifecycle_ir = _runtime.lifecycle_ir

__all__ = ["architecture_ir", "archify_bridge", "lifecycle_ir", "locate_runtime_package"]
