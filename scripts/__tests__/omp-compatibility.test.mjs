import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(read(relativePath));
const execFileAsync = promisify(execFile);

const OMP_PLUGINS = [
  'voidtech-core',
  'voidtech-design',
  'voidtech-engineering',
  'voidtech-mcp-apple',
  'voidtech-mcp-common',
  'voidtech-product',
];

test('OMP marketplace publishes the phase 1 and 2 compatible plugins but not voidtech-loop', () => {
  const marketplace = readJson('.omp-plugin/marketplace.json');
  assert.equal(marketplace.name, 'voidtech');
  assert.deepEqual(marketplace.plugins.map((plugin) => plugin.name).sort(), OMP_PLUGINS);
  assert.ok(marketplace.plugins.every((plugin) => plugin.source === `./plugins/${plugin.name}`));
  const enabledByDefault = marketplace.plugins
    .filter((plugin) => plugin.defaultEnabled)
    .map((plugin) => plugin.name)
    .sort();
  assert.deepEqual(enabledByDefault, [
    'voidtech-core',
    'voidtech-design',
    'voidtech-engineering',
    'voidtech-product',
  ]);
  assert.ok(
    marketplace.plugins
      .filter((plugin) => plugin.name.startsWith('voidtech-mcp-'))
      .every((plugin) => plugin.defaultEnabled === false),
  );
});

test('Core OMP session hook injects locale context and host-correct update guidance', async () => {
  const hookPath = path.join(ROOT, 'plugins/voidtech-core/hooks/pre/voidtech-session.mjs');
  const { default: register } = await import(`${pathToFileURL(hookPath).href}?test=${Date.now()}`);
  const handlers = new Map();
  const messages = [];
  const execCalls = [];
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    async exec(command, args, options) {
      execCalls.push({ command, args, options });
      return {
        code: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            additionalContext: '【VoidTech update】请运行 omp plugin marketplace update voidtech && omp plugin upgrade voidtech-core@voidtech',
          },
        }),
        stderr: '',
      };
    },
    sendMessage(message, options) { messages.push({ message, options }); },
  };

  register(pi);
  assert.ok(handlers.has('session_start'));
  await handlers.get('session_start')({}, { cwd: ROOT });

  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].command, 'bash');
  assert.match(execCalls[0].args[0], /plugins\/voidtech-core\/hooks\/check-update\.sh$/);
  assert.deepEqual(execCalls[0].args.slice(1), ['--host', 'omp']);
  assert.ok(messages.some(({ message }) => message.content.includes('默认使用简体中文')));
  assert.ok(messages.some(({ message }) => message.content.includes('omp plugin upgrade')));
  assert.ok(messages.every(({ options }) => options.deliverAs === 'nextTurn'));
});

test('Product OMP runtime tool resolves bundled scripts and preserves CLI exit semantics', async () => {
  const toolPath = path.join(ROOT, 'plugins/voidtech-product/tools/product-runtime.mjs');
  const { default: createTool } = await import(`${pathToFileURL(toolPath).href}?test=${Date.now()}`);
  const schema = { optional() { return this; }, default() { return this; } };
  const execCalls = [];
  const pi = {
    cwd: '/workspace',
    zod: {
      object() { return schema; },
      enum() { return schema; },
      array() { return schema; },
      string() { return schema; },
    },
    async exec(command, args, options) {
      execCalls.push({ command, args, options });
      return { code: 3, stdout: '', stderr: 'read fence active', killed: false };
    },
  };

  const tool = createTool(pi);
  assert.equal(tool.name, 'voidtech_product_runtime');
  const result = await tool.execute('call-1', {
    script: 'check-prd-tree',
    args: ['/workspace/prd'],
  }, undefined, {}, new AbortController().signal);

  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].command, 'python3');
  assert.match(execCalls[0].args[0], /skills\/prd-from-requirements\/scripts\/check-prd-tree\.py$/);
  assert.deepEqual(execCalls[0].args.slice(1), ['/workspace/prd']);
  assert.equal(execCalls[0].options.cwd, '/workspace');
  assert.equal(result.details.exitCode, 3);
  assert.match(result.content[0].text, /read fence active/);

  await tool.execute('atlas', {
    script: 'prd-sync',
    args: ['atlas', '/workspace/prd', '--publish'],
  }, undefined, {}, new AbortController().signal);
  assert.equal(execCalls.length, 2);
  assert.match(execCalls[1].args[0], /skills\/prd-from-requirements\/scripts\/prd-sync\.py$/);
  assert.deepEqual(execCalls[1].args.slice(1), ['atlas', '/workspace/prd', '--publish']);
});

test('Product OMP runtime launches every bundled CLI and generates Dashboard outputs', async (t) => {
  const toolPath = path.join(ROOT, 'plugins/voidtech-product/tools/product-runtime.mjs');
  const { default: createTool } = await import(`${pathToFileURL(toolPath).href}?integration=${Date.now()}`);
  const schema = { optional() { return this; }, default() { return this; } };
  const pi = {
    cwd: ROOT,
    zod: {
      object() { return schema; },
      enum() { return schema; },
      array() { return schema; },
      string() { return schema; },
    },
    async exec(command, args, options) {
      try {
        const result = await execFileAsync(command, args, {
          cwd: options.cwd,
          encoding: 'utf8',
          signal: options.signal,
        });
        return { code: 0, stdout: result.stdout, stderr: result.stderr, killed: false };
      } catch (error) {
        return {
          code: typeof error.code === 'number' ? error.code : 1,
          stdout: error.stdout ?? '',
          stderr: error.stderr ?? error.message,
          killed: error.killed ?? false,
        };
      }
    },
  };
  const tool = createTool(pi);

  for (const script of ['xlsx-to-markdown', 'check-prd-tree', 'prd-sync']) {
    const result = await tool.execute(
      `help-${script}`,
      { script, args: ['--help'] },
      undefined,
      { cwd: ROOT },
      new AbortController().signal,
    );
    assert.equal(result.details.exitCode, 0, `${script}: ${result.details.stderr}`);
  }

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'voidtech-omp-dashboard-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const dashboard = await tool.execute(
    'dashboard',
    { script: 'generate-dashboard', args: [worktree] },
    undefined,
    { cwd: ROOT },
    new AbortController().signal,
  );
  assert.equal(dashboard.details.exitCode, 0, dashboard.details.stderr);
  assert.equal(fs.existsSync(path.join(worktree, '00-global/status-dashboard.md')), true);
  assert.equal(fs.existsSync(path.join(worktree, '00-global/status-dashboard.html')), true);
});

test('Product skills use one documented host-runtime seam for every bundled PRD workflow', () => {
  const runtimeGuide = read('plugins/voidtech-product/skills/_shared/HOST-RUNTIME.md');
  for (const script of ['xlsx-to-markdown', 'check-prd-tree', 'generate-dashboard', 'prd-sync']) {
    assert.match(runtimeGuide, new RegExp(script));
  }
  assert.match(runtimeGuide, /voidtech_product_runtime/);
  assert.match(runtimeGuide, /CLAUDE_PLUGIN_ROOT/);

  for (const skill of ['prd-from-requirements', 'prd-maintain', 'prd-sync']) {
    const body = read(`plugins/voidtech-product/skills/${skill}/SKILL.md`);
    assert.match(body, /skills\/_shared\/HOST-RUNTIME\.md/);
  }
});

test('Published agents declare equivalent Claude Code and OMP read and search tools', () => {
  const productManager = read('plugins/voidtech-product/agents/product-manager.md');
  const architect = read('plugins/voidtech-engineering/agents/architect.md');
  for (const agent of [productManager, architect]) {
    assert.match(agent, /^tools:.*\bRead\b.*\bread\b/m);
    assert.match(agent, /^tools:.*\bGrep\b.*\bgrep\b/m);
    assert.match(agent, /^tools:.*\bGlob\b.*\bglob\b/m);
    assert.match(agent, /^tools:.*\bWebSearch\b.*\bweb_search\b/m);
  }
  assert.match(productManager, /^tools:.*\bWrite\b.*\bwrite\b/m);
});

test('Engineering Git safety ships an OMP hook with the Claude policy matrix', async () => {
  const guardPath = path.join(
    ROOT,
    'plugins/voidtech-engineering/skills/git-safety/scripts/block-dangerous-git-omp.mjs',
  );
  const { default: register, isDangerousGitCommand } = await import(
    `${pathToFileURL(guardPath).href}?test=${Date.now()}`
  );
  for (const command of [
    'git -C repo push origin main',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git branch -D feature',
    'git checkout .',
    'git restore .',
  ]) {
    assert.equal(isDangerousGitCommand(command), true, command);
  }
  assert.equal(isDangerousGitCommand('git status --short'), false);

  let handler;
  register({ on(event, candidate) { if (event === 'tool_call') handler = candidate; } });
  assert.equal((await handler({ toolName: 'bash', input: {} })).block, true);
  assert.equal(
    (await handler({ toolName: 'bash', input: { command: 'git push origin main' } })).block,
    true,
  );
  assert.equal(await handler({ toolName: 'bash', input: { command: 'git status' } }), undefined);
});

test('Design brief targets a host-neutral design workflow', () => {
  const briefSkill = read('plugins/voidtech-design/skills/to-design-brief/SKILL.md');
  assert.match(briefSkill, /Claude Design 或 OMP/);
  assert.doesNotMatch(briefSkill, /读者是 claude\.ai\/design/);
});

test('Both OMP MCP plugins retain portable standalone MCP manifests', () => {
  const common = readJson('plugins/voidtech-mcp-common/.mcp.json');
  const apple = readJson('plugins/voidtech-mcp-apple/.mcp.json');
  assert.equal(common.mcpServers.context7.type, 'http');
  assert.equal(common.mcpServers['chrome-devtools'].command, 'npx');
  assert.equal(apple.mcpServers['apple-docs'].command, 'npx');
  assert.equal(apple.mcpServers.xcodebuild.command, 'npx');
});
