#!/usr/bin/env node
// 公开发布的 agent 不得固定到带环境前置条件的模型。
//
// 成因：`architect` 与 `product-manager` 曾固定 `model: fable`。Fable 5 要求组织
// 或 workspace 开启 30 天数据保留，配置为零数据保留（ZDR）时**每个请求**都返回
// 400，且错误信息不指向真实原因。装了插件的用户无从得知，也无法覆盖——
// frontmatter 的 model 会盖掉他自己的会话选择。
//
// 本检查只覆盖 `plugins/*/agents/`（随插件分发给用户的部分）。`.claude/agents/`
// 是仓库自用、只在维护者自己的组织里跑，不在此门禁内。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// 短别名白名单。`inherit` 是「用用户的会话模型」的显式写法（Claude Code
// subagent frontmatter 的公开取值，也是省略该字段时的默认值），必须放行——
// 否则这个门禁会禁掉它自己主张的做法。省略 model 字段同样合法。
export const ALLOWED_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'inherit']);

// 带环境前置条件的模型：命中即报错，并说明前置条件是什么。
// 这是显式清单，不会自动跟随新模型——新增模型时按同样标准人工评估。
// 只列真正的环境前置条件：分类器拒答不在此列——Opus 5 也有分类器，它是
// 概率差异而不是前置条件，写进来会让这份清单的判据变得不可执行。
export const PRECONDITION_MODELS = new Map([
  ['fable', '要求组织或 workspace 开启 30 天数据保留，ZDR 组织每个请求都返回 400 invalid_request_error'],
  ['claude-fable-5', '要求组织或 workspace 开启 30 天数据保留，ZDR 组织每个请求都返回 400 invalid_request_error'],
  ['claude-mythos-5', '仅 Project Glasswing 参与者可用'],
  ['claude-mythos-preview', '仅邀请制可用，且已被 claude-mythos-5 取代'],
]);

// 只要有 model 行就算声明，值随后再判。取值到行尾而不是 `(\S+)$`：
// `model: fable # 说明` 若匹配不上就会退回「未声明」分支静默放行，加一句
// 行内注释即可绕过本门禁。
const MODEL_LINE_RE = /^model\s*:(.*)$/m;

export function readAgentModel(text) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!frontmatter) return { declared: false, model: null };
  // 整行注释不是声明；否则解释性注释会被当成 model 值。
  const body = frontmatter[1]
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  const match = MODEL_LINE_RE.exec(body);
  if (!match) return { declared: false, model: null };
  const model = match[1]
    .replace(/\s+#.*$/, '') // YAML 行内注释：`#` 前有空白才是注释
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2') // 带引号的标量与裸值同义
    .trim();
  return { declared: true, model };
}

export function publishedAgentFiles(root = ROOT) {
  const pluginsDir = path.join(root, 'plugins');
  if (!fs.existsSync(pluginsDir)) return [];
  const files = [];
  for (const plugin of fs.readdirSync(pluginsDir).sort()) {
    const agentsDir = path.join(pluginsDir, plugin, 'agents');
    if (!fs.existsSync(agentsDir)) continue;
    for (const entry of fs.readdirSync(agentsDir).sort()) {
      if (entry.endsWith('.md')) files.push(path.join(agentsDir, entry));
    }
  }
  return files;
}

export function evaluateAgentModels(agents) {
  const errors = [];
  for (const { file, model, declared } of agents) {
    if (!declared) continue;
    // 有 model 行但取不到值：报错而不是当成未声明，空值不该被当成「继承」放行。
    if (model === '') {
      errors.push(`${file}: model 字段为空——要么写具体取值，要么整行删掉。`);
      continue;
    }
    const precondition = PRECONDITION_MODELS.get(model);
    if (precondition) {
      errors.push(
        `${file}: 公开 agent 不得固定 model「${model}」——${precondition}。` +
        `改用 ${[...ALLOWED_ALIASES].join(' / ')}，或省略 model 字段继承用户的会话模型。`,
      );
      continue;
    }
    if (!ALLOWED_ALIASES.has(model) && !model.startsWith('claude-')) {
      errors.push(
        `${file}: model「${model}」既不是允许的短别名（${[...ALLOWED_ALIASES].join(' / ')}）` +
        '，也不是 claude- 前缀的模型 ID。',
      );
    }
  }
  return errors;
}

export function runAgentModelCheck(root = ROOT) {
  const agents = publishedAgentFiles(root).map((file) => ({
    file: path.relative(root, file),
    ...readAgentModel(fs.readFileSync(file, 'utf8')),
  }));
  return evaluateAgentModels(agents);
}

function main() {
  const errors = runAgentModelCheck(ROOT);
  if (errors.length > 0) {
    console.error('公开 agent 模型检查失败：');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('公开 agent 模型检查通过');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
