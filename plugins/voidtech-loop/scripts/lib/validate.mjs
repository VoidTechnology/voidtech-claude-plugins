// Goal Spec 校验、规范化与 goal_hash 计算。
// 结构规则来自 schemas/goal-spec.schema.json（唯一来源）；本文件只包含 schema 无法表达的语义规则。

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseYaml, YamlError } from './yaml.mjs';
import { validateSchema } from './schema.mjs';

const SCHEMA_URL = new URL('../../schemas/goal-spec.schema.json', import.meta.url);

// 一期不支持相对基线比较器；命中这些键给出定向错误（PRD V2）。
const RELATIVE_COMPARATOR_KEYS = new Set([
  'baseline', 'compare', 'comparator', 'metric', 'threshold', 'improvement', 'improve',
]);

// 常见凭据字面量模式；spec 中只允许引用环境变量名，不允许出现疑似 secret（技术设计 §9）。
const SECRET_PATTERN =
  /(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY)/;

export function loadSchema() {
  return JSON.parse(readFileSync(SCHEMA_URL, 'utf8'));
}

export function validateSpecText(text) {
  let raw;
  try {
    raw = parseYaml(text);
  } catch (err) {
    if (err instanceof YamlError) {
      return { ok: false, errors: [{ path: '$', message: `YAML 解析失败：${err.message}` }] };
    }
    // 任何其他解析异常（如深层递归的 RangeError）也降级为干净的校验失败，而非向上抛出令 CLI 崩溃
    return { ok: false, errors: [{ path: '$', message: `YAML 解析异常：${err.message ?? err}` }] };
  }
  return validateSpecObject(raw);
}

export function validateSpecObject(raw) {
  const errors = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ path: '$', message: 'Goal Spec 必须是一个映射' }] };
  }

  errors.push(...semanticPrechecks(raw));
  errors.push(...validateSchema(raw, loadSchema()));
  if (errors.length === 0) errors.push(...semanticChecks(raw));

  if (errors.length > 0) {
    return { ok: false, errors: dedupeErrors(errors) };
  }

  const normalized = normalize(raw);
  const canonical = canonicalJson(normalized);
  const goalHash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  const flags = {
    shell: normalized.evals.some((e) => e.shell === true),
    setup: 'setup' in normalized,
  };
  return { ok: true, errors: [], normalized, goal_hash: goalHash, flags };
}

// 在结构校验之前跑的定向检查：让高频错误得到比“未知字段”更有用的信息。
function semanticPrechecks(raw) {
  const errors = [];
  if (Array.isArray(raw.evals)) {
    raw.evals.forEach((e, idx) => {
      if (e === null || typeof e !== 'object' || Array.isArray(e)) return;
      for (const key of Object.keys(e)) {
        if (RELATIVE_COMPARATOR_KEYS.has(key)) {
          errors.push({
            path: `$.evals[${idx}].${key}`,
            message: '一期不支持相对基线比较器；请改为绝对判定（退出码/期望结果），相对指标归入 out_of_scope',
          });
        }
      }
      if (Array.isArray(e.command)) {
        e.command.forEach((arg, argIdx) => {
          if (typeof arg !== 'string') {
            errors.push({
              path: `$.evals[${idx}].command[${argIdx}]`,
              message: `command 数组元素必须是字符串；YAML 中数字/布尔会被解析为标量，请加引号（如 "${String(arg)}"）`,
            });
          }
        });
      }
    });
  }
  return errors;
}

function semanticChecks(spec) {
  const errors = [];

  const targets = spec.evals.filter((e) => e.role === 'target');
  if (targets.length === 0) {
    errors.push({ path: '$.evals', message: 'Eval Pack 至少需要一个 role 为 target 的 eval' });
  }

  const seen = new Set();
  spec.evals.forEach((e, idx) => {
    if (seen.has(e.id)) {
      errors.push({ path: `$.evals[${idx}].id`, message: `eval id 重复：${e.id}` });
    }
    seen.add(e.id);

    const shell = e.shell === true;
    if (shell && typeof e.command !== 'string') {
      errors.push({ path: `$.evals[${idx}].command`, message: 'shell: true 时 command 必须是单个字符串' });
    }
    if (!shell && !Array.isArray(e.command)) {
      errors.push({ path: `$.evals[${idx}].command`, message: '未声明 shell: true 时 command 必须是 argv 数组' });
    }

    if (e.cwd !== undefined) {
      errors.push(...checkCwd(e.cwd, `$.evals[${idx}].cwd`));
    }
  });

  for (const [idx, p] of (spec.protected_paths ?? []).entries()) {
    if (p.startsWith('!')) {
      errors.push({ path: `$.protected_paths[${idx}]`, message: '不支持 ! 否定模式' });
    }
  }

  errors.push(...scanSecrets(spec, '$'));
  return errors;
}

function checkCwd(cwd, path) {
  if (cwd.startsWith('/')) {
    return [{ path, message: 'cwd 必须是相对仓库根的相对路径' }];
  }
  const segments = cwd.split('/');
  if (segments.includes('..')) {
    return [{ path, message: 'cwd 不允许包含 .. 路径段' }];
  }
  return [];
}

function scanSecrets(value, path) {
  const errors = [];
  if (typeof value === 'string') {
    if (SECRET_PATTERN.test(value)) {
      errors.push({ path, message: '疑似凭据字面量；spec 中只允许引用环境变量名' });
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, idx) => errors.push(...scanSecrets(v, `${path}[${idx}]`)));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      errors.push(...scanSecrets(v, `${path}.${k}`));
    }
  }
  return errors;
}

// 填安全默认值（PRD 3.1 / V1），产出进入哈希的规范化形态。
function normalize(spec) {
  const out = structuredClone(spec);
  out.base_commit = out.base_commit.toLowerCase();
  out.budgets.max_duration_seconds ??= 3600;
  out.protected_paths ??= [];
  out.manual_review ??= [];
  out.out_of_scope ??= [];
  out.evals = out.evals.map((e) => ({
    ...e,
    shell: e.shell ?? false,
    cwd: e.cwd ?? '.',
    expected_exit: e.expected_exit ?? 0,
    repeat: e.repeat ?? 1,
  }));
  return out;
}

// 规范化 JSON：递归按键排序 + UTF-8，无空白。goal_hash 对键序与注释不敏感（PRD 3.1）。
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    // 跳过 undefined 值的键，与 JSON.stringify 落盘语义一致：否则 checksum 计入 "key:undefined"，
    // 而落盘丢弃该键，重读时 checksum 不符被误判 corrupt（L6）。
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

function dedupeErrors(errors) {
  const seen = new Set();
  return errors.filter((e) => {
    const key = `${e.path}|${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
