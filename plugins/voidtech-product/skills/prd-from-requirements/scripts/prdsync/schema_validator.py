"""极简 JSON Schema 子集校验器（仅标准库）。

支持的关键字以 schemas/*.schema.json 实际使用的集合为准：
type（含类型列表与 "null"）、const、enum、pattern、properties、required、
additionalProperties(false)、patternProperties、items、oneOf、
minItems、minimum、minLength。

超出子集的关键字不静默忽略，直接抛 SchemaError——契约里出现校验器
不认识的约束等于没有约束，必须显式失败。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

_SUPPORTED = {
    "$schema", "$id", "title", "description",
    "type", "const", "enum", "pattern",
    "properties", "required", "additionalProperties", "patternProperties",
    "items", "oneOf", "minItems", "minimum", "minLength",
}


class SchemaError(ValueError):
    """schema 本身使用了不受支持的关键字或类型。"""


def _equal(a, b):
    # Python 中 True == 1；JSON 语义里 boolean 与 number 不相等。
    if isinstance(a, bool) != isinstance(b, bool):
        return False
    return a == b


def _type_ok(value, expected):
    if expected == "null":
        return value is None
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "string":
        return isinstance(value, str)
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    raise SchemaError(f"unsupported type: {expected!r}")


def validate(value, schema, path="$"):
    """返回错误列表；空列表表示通过。"""
    unknown = set(schema) - _SUPPORTED
    if unknown:
        raise SchemaError(f"{path}: unsupported keywords {sorted(unknown)}")

    errors = []

    if "type" in schema:
        declared = schema["type"]
        types = declared if isinstance(declared, list) else [declared]
        if not any(_type_ok(value, t) for t in types):
            return [f"{path}: expected type {types}, got {type(value).__name__}"]

    if "const" in schema and not _equal(value, schema["const"]):
        return [f"{path}: expected const {schema['const']!r}"]

    if "enum" in schema and not any(_equal(value, e) for e in schema["enum"]):
        return [f"{path}: value {value!r} not in enum"]

    if "pattern" in schema and isinstance(value, str):
        if not re.search(schema["pattern"], value):
            errors.append(f"{path}: {value!r} does not match pattern")

    if "minLength" in schema and isinstance(value, str):
        if len(value) < schema["minLength"]:
            errors.append(f"{path}: shorter than minLength {schema['minLength']}")

    if "minimum" in schema and isinstance(value, (int, float)) and not isinstance(value, bool):
        if value < schema["minimum"]:
            errors.append(f"{path}: below minimum {schema['minimum']}")

    if isinstance(value, dict):
        props = schema.get("properties", {})
        pattern_props = schema.get("patternProperties", {})
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: missing required property '{key}'")
        for key, item in value.items():
            child = f"{path}.{key}"
            matched = False
            if key in props:
                matched = True
                errors.extend(validate(item, props[key], child))
            for pat, sub in pattern_props.items():
                if re.search(pat, key):
                    matched = True
                    errors.extend(validate(item, sub, child))
            if not matched and schema.get("additionalProperties", True) is False:
                errors.append(f"{path}: unexpected property '{key}'")

    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: fewer than minItems {schema['minItems']}")
        if "items" in schema:
            for i, item in enumerate(value):
                errors.extend(validate(item, schema["items"], f"{path}[{i}]"))

    if "oneOf" in schema:
        matches = sum(1 for sub in schema["oneOf"] if not validate(value, sub, path))
        if matches != 1:
            errors.append(f"{path}: oneOf matched {matches} branches, expected exactly 1")

    return errors


def load_schema(schemas_dir, name):
    return json.loads((Path(schemas_dir) / f"{name}.schema.json").read_text(encoding="utf-8"))


def check(value, schema):
    return validate(value, schema, "$")
