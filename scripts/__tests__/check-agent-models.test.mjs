import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  evaluateAgentModels,
  readAgentModel,
  publishedAgentFiles,
  runAgentModelCheck,
} from '../check-agent-models.mjs';

function makeFixture(agentsByPlugin) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voidtech-agent-models-'));
  for (const [plugin, agents] of Object.entries(agentsByPlugin)) {
    const dir = path.join(root, 'plugins', plugin, 'agents');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(agents)) {
      fs.writeFileSync(path.join(dir, `${name}.md`), body);
    }
  }
  return root;
}

const frontmatter = (fields) => `---\n${fields}\n---\n\n正文。\n`;

test('固定到带环境前置条件的模型被拒绝，错误里写明前置条件', () => {
  const errors = evaluateAgentModels([
    { file: 'plugins/demo/agents/one.md', declared: true, model: 'fable' },
  ]);

  assert.equal(errors.length, 1);
  assert.match(errors[0], /不得固定 model「fable」/);
  assert.match(errors[0], /30 天数据保留/);
});

test('允许的短别名与 claude- 前缀的具体模型 ID 都通过', () => {
  const errors = evaluateAgentModels([
    { file: 'a.md', declared: true, model: 'opus' },
    { file: 'b.md', declared: true, model: 'sonnet' },
    { file: 'c.md', declared: true, model: 'haiku' },
    { file: 'd.md', declared: true, model: 'claude-opus-5' },
  ]);

  assert.deepEqual(errors, []);
});

test('省略 model 字段合法——那表示继承用户的会话模型', () => {
  const root = makeFixture({
    demo: { inherits: frontmatter('name: inherits\ndescription: 不声明模型。') },
  });

  assert.deepEqual(runAgentModelCheck(root), []);
});

test('非 Claude 模型被拒绝：frontmatter 的 model 字段只接受 Claude 模型', () => {
  const errors = evaluateAgentModels([
    { file: 'plugins/demo/agents/one.md', declared: true, model: 'gpt-5' },
  ]);

  assert.equal(errors.length, 1);
  assert.match(errors[0], /既不是允许的短别名/);
});

test('frontmatter 里的注释行不被当成 model 声明', () => {
  const { declared, model } = readAgentModel(
    frontmatter('name: commented\n# model: fable 会触发 ZDR 组织的 400\nmodel: opus'),
  );

  assert.equal(declared, true);
  assert.equal(model, 'opus');
});

test('只扫描 plugins/*/agents/：仓库自用的 .claude/agents/ 不在门禁内', () => {
  const root = makeFixture({ demo: { one: frontmatter('name: one\nmodel: opus') } });
  const internal = path.join(root, '.claude', 'agents');
  fs.mkdirSync(internal, { recursive: true });
  fs.writeFileSync(path.join(internal, 'internal.md'), frontmatter('name: internal\nmodel: fable'));

  assert.deepEqual(
    publishedAgentFiles(root).map((file) => path.relative(root, file)),
    ['plugins/demo/agents/one.md'],
  );
  assert.deepEqual(runAgentModelCheck(root), []);
});

test('仓库自身的公开 agent 全部通过', () => {
  assert.deepEqual(runAgentModelCheck(), []);
});
