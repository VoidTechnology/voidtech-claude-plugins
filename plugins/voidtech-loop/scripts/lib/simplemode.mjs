// 简单模式（PRD 3.1 / 4.1）：把一行 --check 规范化为单 target Goal Spec。
// 安全默认：cwd=仓库根、expected_exit=0、单 eval 超时 600s、repeat=1、max_duration=3600s。
// 拒绝字符集：管道/重定向/命令替换/控制运算符（技术设计 §4）——引导用户改用 Goal Spec 显式 shell。

const SHELL_METACHARS = /[|&;<>`]|\$\(|\)|\n/;

export function slugify(text) {
  const base = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return base || 'goal';
}

// 引号感知 tokenizer：单/双引号成组，不经过 shell。
export function tokenizeCheck(check) {
  if (SHELL_METACHARS.test(check)) {
    return { ok: false, error: '命令包含管道、重定向、命令替换或控制运算符；请改用 Goal Spec 并显式声明 shell: true' };
  }
  const tokens = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < check.length; i++) {
    const c = check[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === ' ' || c === '\t') {
      if (has) { tokens.push(cur); cur = ''; has = false; }
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) return { ok: false, error: '命令引号未闭合' };
  if (has) tokens.push(cur);
  if (tokens.length === 0) return { ok: false, error: '命令为空' };
  return { ok: true, argv: tokens };
}

// 构造简单模式 Goal Spec 原始对象（未规范化，交给 validate 统一处理）。
export function buildSimpleSpec({ task, check, maxIterations, maxDuration, baseCommit, goalId }) {
  const tok = tokenizeCheck(check);
  if (!tok.ok) return { ok: false, error: tok.error };
  const spec = {
    schema_version: 1,
    goal_id: goalId ?? slugify(task),
    task,
    base_commit: baseCommit,
    budgets: { max_iterations: maxIterations },
    evals: [
      {
        id: 'check',
        role: 'target',
        command: tok.argv,
        cwd: '.',
        expected_exit: 0,
        timeout_seconds: 600,
        repeat: 1,
      },
    ],
  };
  if (maxDuration !== undefined) spec.budgets.max_duration_seconds = maxDuration;
  return { ok: true, spec };
}
