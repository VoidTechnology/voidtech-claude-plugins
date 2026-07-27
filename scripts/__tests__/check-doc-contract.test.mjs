import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectRepositoryFacts,
  validateDocContract,
  validateLocalMarkdownLinks,
} from '../check-doc-contract.mjs';

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voidtech-doc-contract-'));
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins', 'demo', '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins', 'demo', 'skills', 'one'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins', 'demo', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ plugins: [{ name: 'demo', source: './plugins/demo' }] }),
  );
  fs.writeFileSync(
    path.join(root, 'plugins', 'demo', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'demo', version: '1.2.3' }),
  );
  fs.writeFileSync(path.join(root, 'plugins', 'demo', 'skills', 'one', 'SKILL.md'), '---\nname: one\n---\n');
  fs.writeFileSync(path.join(root, 'plugins', 'demo', 'agents', 'reviewer.md'), '# reviewer\n');
  fs.writeFileSync(
    path.join(root, 'README.md'),
    '# Demo\n\n**1 个自包含技能 + 1 个专业 subagent**\n\n| 插件 | 版本 |\n|---|---|\n| [`demo`](plugins/demo) | 1.2.3 |\n\n[指南](docs/guide.md)\n',
  );
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# Guide\n');
  fs.writeFileSync(path.join(root, 'docs', 'CURRENT-AUDIT.md'), '# Audit\n\n- 状态：Current\n');
  return root;
}

test('document contract accepts versions, counts, links, and explicit audit status that match repository facts', () => {
  const root = makeFixture();
  const facts = collectRepositoryFacts(root);
  assert.deepEqual(facts.plugins.map(({ name, version }) => ({ name, version })), [
    { name: 'demo', version: '1.2.3' },
  ]);
  assert.equal(facts.skillCount, 1);
  assert.equal(facts.agentCount, 1);
  assert.deepEqual(validateDocContract(root, facts), []);
  assert.deepEqual(validateLocalMarkdownLinks(root, ['README.md']), []);
});

test('document contract rejects stale skill counts and plugin versions', () => {
  const root = makeFixture();
  const readme = path.join(root, 'README.md');
  fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8').replace('1 个自包含技能', '2 个自包含技能').replace('1.2.3', '1.2.2'));
  const errors = validateDocContract(root, collectRepositoryFacts(root));
  assert.ok(errors.some((error) => error.includes('技能数量')));
  assert.ok(errors.some((error) => error.includes('demo 1.2.3')));
});

test('local markdown link validation rejects missing relative targets and ignores URLs and anchors', () => {
  const root = makeFixture();
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '[缺失](missing.md) [网页](https://example.com) [锚点](#section)\n');
  const errors = validateLocalMarkdownLinks(root, ['docs/guide.md']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /missing\.md/);
});

test('audit documents must declare whether they are current facts or historical snapshots', () => {
  const root = makeFixture();
  fs.writeFileSync(path.join(root, 'docs', 'STALE-AUDIT.md'), '# Old audit\n');
  const errors = validateDocContract(root, collectRepositoryFacts(root));
  assert.ok(errors.some((error) => error.includes('STALE-AUDIT.md')));
});
