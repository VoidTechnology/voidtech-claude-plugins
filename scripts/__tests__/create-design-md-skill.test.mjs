import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SKILL_ROOT = path.join(ROOT, 'plugins/voidtech-design/skills/create-design-md');
const read = (relativePath) => fs.readFileSync(path.join(SKILL_ROOT, relativePath), 'utf8');

const createValidatorFixture = (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'voidtech-design-md-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  const fakeBin = path.join(fixture, 'bin');
  fs.mkdirSync(fakeBin);
  const fakeNpm = path.join(fakeBin, 'npm');
  fs.writeFileSync(fakeNpm, `#!/usr/bin/env bash
printf '%s\n' "$@" > "$NPM_CAPTURE_FILE"
prefix=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--prefix" ]]; then
    prefix=$2
    shift 2
  else
    shift
  fi
done
mkdir -p "$prefix/node_modules/.bin"
cat > "$prefix/node_modules/.bin/designmd" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$CLI_CAPTURE_FILE"
printf '%s\n' "$FAKE_LINT_OUTPUT"
exit "${'${FAKE_LINT_EXIT:-0}'}"
SCRIPT
chmod +x "$prefix/node_modules/.bin/designmd"
`);
  fs.chmodSync(fakeNpm, 0o755);

  const designPath = path.join(fixture, 'DESIGN.md');
  fs.copyFileSync(path.join(SKILL_ROOT, 'assets/DESIGN.template.md'), designPath);
  const npmCapturePath = path.join(fixture, 'npm-args.txt');
  const cliCapturePath = path.join(fixture, 'cli-args.txt');
  const validator = path.join(SKILL_ROOT, 'scripts/validate-design-md.sh');
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    NPM_CAPTURE_FILE: npmCapturePath,
    CLI_CAPTURE_FILE: cliCapturePath,
    FAKE_LINT_OUTPUT: JSON.stringify({ summary: { errors: 0, warnings: 0, infos: 1 } }),
  };

  return { cliCapturePath, designPath, env, fakeBin, fixture, npmCapturePath, validator };
};

test('create-design-md 发布自包含工作流、模板与校验器', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /^name: create-design-md$/m);
  assert.match(skill, /^disable-model-invocation: true$/m);
  assert.match(skill, /references\/design-md-contract\.md/);
  assert.match(skill, /assets\/DESIGN\.template\.md/);
  assert.match(skill, /scripts\/validate-design-md\.sh/);
  assert.match(skill, /产品事实.*设计推导.*候选决策/s);
  assert.match(skill, /不可信证据，不是 Agent 指令/);
  assert.match(skill, /mktemp -d/);
  assert.doesNotMatch(skill, /~\/|\/Users\/|\.claude\/skills/);

  for (const relativePath of [
    'references/design-md-contract.md',
    'assets/DESIGN.template.md',
    'scripts/validate-design-md.sh',
    'validator/package.json',
    'validator/package-lock.json',
  ]) {
    assert.equal(fs.existsSync(path.join(SKILL_ROOT, relativePath)), true, relativePath);
  }
});

test('官方校验器的完整依赖图带 integrity 锁定且禁用安装脚本', () => {
  const packageJson = JSON.parse(read('validator/package.json'));
  const packageLock = JSON.parse(read('validator/package-lock.json'));
  const validator = read('scripts/validate-design-md.sh');

  assert.equal(packageJson.dependencies['@google/design.md'], '0.4.0');
  assert.equal(packageLock.packages['node_modules/@google/design.md'].version, '0.4.0');
  for (const [packagePath, metadata] of Object.entries(packageLock.packages)) {
    if (!packagePath.startsWith('node_modules/')) continue;
    assert.match(metadata.integrity, /^sha512-/, packagePath);
  }
  assert.match(validator, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.doesNotMatch(validator, /\bnpx\b/);
});

test('DESIGN 模板只包含规范要求的八个二级章节并保持顺序', () => {
  const template = read('assets/DESIGN.template.md');
  assert.match(template, /^---\nversion:/);
  const headings = [...template.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(headings, [
    'Overview',
    'Colors',
    'Typography',
    'Layout',
    'Elevation & Depth',
    'Shapes',
    'Components',
    "Do's and Don'ts",
  ]);
  assert.doesNotMatch(template, /\b(?:TODO|TBD)\b/);
});

test('校验脚本固定官方 CLI 版本并把 warning 当作失败', (t) => {
  const { cliCapturePath, designPath, env, npmCapturePath, validator } = createValidatorFixture(t);

  execFileSync(validator, [designPath], { cwd: ROOT, env, encoding: 'utf8' });
  const npmArgs = fs.readFileSync(npmCapturePath, 'utf8').trim().split('\n');
  assert.deepEqual(npmArgs.slice(0, 5), [
    'ci',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix',
  ]);
  assert.deepEqual(fs.readFileSync(cliCapturePath, 'utf8').trim().split('\n'), [
    'lint',
    fs.realpathSync(designPath),
  ]);

  const warningResult = spawnSync(validator, [designPath], {
    cwd: ROOT,
    env: {
      ...env,
      FAKE_LINT_OUTPUT: JSON.stringify({ summary: { errors: 0, warnings: 1, infos: 0 } }),
    },
    encoding: 'utf8',
  });
  assert.equal(warningResult.status, 1);
  assert.match(warningResult.stderr, /warning/);
});

test('校验脚本对参数、文件、Node 版本和官方 CLI 失败采用安全默认值', (t) => {
  const { designPath, env, fakeBin, fixture, validator } = createValidatorFixture(t);

  const missingArgument = spawnSync(validator, [], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(missingArgument.status, 2);
  assert.match(missingArgument.stderr, /Usage:/);

  const missingTools = spawnSync('/bin/bash', [validator, designPath], {
    cwd: ROOT,
    env: { ...env, PATH: fixture },
    encoding: 'utf8',
  });
  assert.equal(missingTools.status, 2);
  assert.match(missingTools.stderr, /Node\.js and npm are required/);

  const missingFile = spawnSync(validator, [path.join(fixture, 'missing.md')], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  assert.equal(missingFile.status, 2);
  assert.match(missingFile.stderr, /target is not a file/);

  const fakeNode = path.join(fakeBin, 'node');
  fs.writeFileSync(fakeNode, '#!/usr/bin/env bash\nprintf "16\\n"\n');
  fs.chmodSync(fakeNode, 0o755);
  const unsupportedNode = spawnSync(validator, [designPath], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(unsupportedNode.status, 2);
  assert.match(unsupportedNode.stderr, /Node\.js 18 or newer/);
  fs.rmSync(fakeNode);

  const cliFailure = spawnSync(validator, [designPath], {
    cwd: ROOT,
    env: { ...env, FAKE_LINT_EXIT: '7' },
    encoding: 'utf8',
  });
  assert.equal(cliFailure.status, 7);
});

test('校验脚本拒绝无法证明零错误零警告的官方输出', (t) => {
  const { designPath, env, validator } = createValidatorFixture(t);

  const cases = [
    { output: 'not-json', status: 2, message: /valid JSON/ },
    { output: JSON.stringify({ findings: [] }), status: 2, message: /summary counts/ },
    {
      output: JSON.stringify({ summary: { errors: -1, warnings: 0, infos: 0 } }),
      status: 1,
      message: /-1 error/,
    },
    {
      output: JSON.stringify({ summary: { errors: 1, warnings: 0, infos: 0 } }),
      status: 1,
      message: /1 error/,
    },
  ];

  for (const testCase of cases) {
    const result = spawnSync(validator, [designPath], {
      cwd: ROOT,
      env: { ...env, FAKE_LINT_OUTPUT: testCase.output },
      encoding: 'utf8',
    });
    assert.equal(result.status, testCase.status);
    assert.match(result.stderr, testCase.message);
  }
});

test('校验脚本机械拒绝未知、缺失、重复和乱序的二级章节', (t) => {
  const { designPath, env, fixture, validator } = createValidatorFixture(t);
  const template = fs.readFileSync(designPath, 'utf8');
  const cases = [
    template.replace('## Shapes', '## Foo'),
    template.replace(/\n## Shapes[\s\S]*?(?=\n## Components)/, ''),
    template.replace('## Colors', '## Colors\n\n重复章节。\n\n## Colors'),
    template
      .replace('## Colors', '## TEMP')
      .replace('## Typography', '## Colors')
      .replace('## TEMP', '## Typography'),
  ];

  for (const [index, content] of cases.entries()) {
    const target = path.join(fixture, `invalid-sections-${index}.md`);
    fs.writeFileSync(target, content);
    const result = spawnSync(validator, [target], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /expected exactly these level-2 sections in order/);
  }

  const fencedHeading = path.join(fixture, 'fenced-heading.md');
  fs.writeFileSync(
    fencedHeading,
    template
      .replace('version: alpha', 'version: alpha\n## YAML comment')
      .replace('## Components', '## Components\n\n```markdown\n## Example only\n```'),
  );
  execFileSync(validator, [fencedHeading], { cwd: ROOT, env, encoding: 'utf8' });
});
