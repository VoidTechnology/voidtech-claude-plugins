import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

export async function withDataRoot(callback) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const parent = mkdtempSync(join(tmpdir(), 'loop-data-'));
  const root = join(parent, 'voidtech-loop');
  process.env.CLAUDE_PLUGIN_DATA = root;
  try {
    return await callback(root);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
    rmSync(parent, { recursive: true, force: true });
  }
}

export function makeTestRepo({ prefix = 'loop-fixture-', files = {}, branch = 'main' } = {}) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env });
  const requireGit = (...args) => {
    const result = git(...args);
    if (result.status !== 0) {
      throw new Error(`Git fixture 初始化失败：git ${args.join(' ')}\n${result.stderr}`);
    }
    return result;
  };

  requireGit('init', '-q', '-b', branch);
  requireGit('config', 'user.email', 'fixture@voidtech.local');
  requireGit('config', 'user.name', 'fixture');
  for (const [relativePath, definition] of Object.entries(files)) {
    const path = join(repo, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    const { content, mode } = typeof definition === 'string'
      ? { content: definition, mode: undefined }
      : definition;
    writeFileSync(path, content, mode === undefined ? undefined : { mode });
  }
  requireGit('add', '-A');
  requireGit('commit', '-q', '-m', 'base');
  const sha = requireGit('rev-parse', 'HEAD').stdout.trim();
  return { repo, sha, git };
}
