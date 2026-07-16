import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { makeTestRepo, withDataRoot } from './helpers.mjs';

test('withDataRoot：提供本插件专属目录，并在回调后恢复环境与清理现场', async () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  let parent;
  await withDataRoot(async (root) => {
    parent = join(root, '..');
    assert.equal(basename(root), 'voidtech-loop');
    assert.equal(process.env.CLAUDE_PLUGIN_DATA, root);
  });
  assert.equal(process.env.CLAUDE_PLUGIN_DATA, previous);
  assert.equal(existsSync(parent), false);
});

test('withDataRoot：回调同步抛错时仍恢复环境并清理现场', async () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  let parent;
  await assert.rejects(withDataRoot((root) => {
    parent = join(root, '..');
    throw new Error('fixture failed');
  }), /fixture failed/);
  assert.equal(process.env.CLAUDE_PLUGIN_DATA, previous);
  assert.equal(existsSync(parent), false);
});

test('makeTestRepo：集中初始化加固 Git fixture，同时保留测试可读的文件定义', () => {
  const fixture = makeTestRepo({
    prefix: 'helpers-fixture-',
    files: {
      'nested/value.txt': 'fixture\n',
      'check.sh': { content: '#!/bin/bash\nexit 0\n', mode: 0o755 },
    },
  });
  try {
    assert.match(fixture.sha, /^[0-9a-f]{40}$/);
    assert.equal(readFileSync(join(fixture.repo, 'nested/value.txt'), 'utf8'), 'fixture\n');
    assert.notEqual(statSync(join(fixture.repo, 'check.sh')).mode & 0o111, 0);
    assert.equal(fixture.git('status', '--porcelain').stdout, '');
  } finally {
    rmSync(fixture.repo, { recursive: true, force: true });
  }
});
