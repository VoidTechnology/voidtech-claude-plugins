#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import manifest from './quality-manifest.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function walkFiles(directory, files = []) {
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(absolute, files);
    else files.push(absolute);
  }
  return files;
}

function publishedPlugins(root = ROOT) {
  const marketplace = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  return marketplace.plugins.map((plugin) => plugin.name).sort();
}

function discoveredBehaviorTests(root = ROOT) {
  const candidateFiles = [
    ...walkFiles(path.join(root, 'scripts', '__tests__')),
    ...walkFiles(path.join(root, 'plugins')),
  ];
  return candidateFiles
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .filter((file) => (
      file.startsWith('scripts/__tests__/') && file.endsWith('.test.mjs')
    ) || (
      file.includes('/tests/') && (file.endsWith('.test.mjs') || /\/test_[^/]+\.py$/.test(file))
    ))
    .filter((file) => !file.includes('/fixtures/'))
    .sort();
}

export function matchDeclaredTest(inputManifest, relativeFile) {
  return inputManifest.testMatchers.filter((matcher) => (
    relativeFile.startsWith(matcher.prefix) && relativeFile.endsWith(matcher.suffix)
  ));
}

export function validateQualityManifest({
  manifest: inputManifest,
  discoveredPlugins = publishedPlugins(ROOT),
  discoveredTests = discoveredBehaviorTests(ROOT),
}) {
  const errors = [];
  if (inputManifest.version !== 1) errors.push(`不支持的质量清单版本：${inputManifest.version}`);

  const declaredPlugins = inputManifest.plugins.map((plugin) => plugin.name);
  for (const plugin of discoveredPlugins) {
    if (!declaredPlugins.includes(plugin)) errors.push(`质量清单存在未登记插件：${plugin}`);
  }
  for (const plugin of declaredPlugins) {
    if (!discoveredPlugins.includes(plugin)) errors.push(`质量清单登记了不存在的插件：${plugin}`);
  }
  for (const plugin of inputManifest.plugins) {
    if (!['behavior', 'contract'].includes(plugin.coverage)) {
      errors.push(`${plugin.name} 的 coverage 必须是 behavior 或 contract`);
    }
    if (plugin.coverage === 'contract' && !plugin.reason) {
      errors.push(`${plugin.name} 使用 contract 覆盖时必须说明原因`);
    }
  }

  for (const file of discoveredTests) {
    const matches = matchDeclaredTest(inputManifest, file);
    if (matches.length === 0) errors.push(`测试文件未登记到质量 tier：${file}`);
    if (matches.length > 1) errors.push(`测试文件被重复登记：${file} -> ${matches.map((match) => match.id).join(', ')}`);
  }

  const tierNames = new Set(Object.keys(inputManifest.tiers));
  for (const matcher of inputManifest.testMatchers) {
    if (!tierNames.has(matcher.tier)) errors.push(`${matcher.id} 引用了未知 tier：${matcher.tier}`);
  }
  for (const tier of inputManifest.allTiers) {
    if (!tierNames.has(tier)) errors.push(`allTiers 引用了未知 tier：${tier}`);
  }
  return errors;
}

function nodeTestFiles(run, root = ROOT) {
  return walkFiles(path.join(root, run.directory))
    .filter((file) => file.endsWith(run.suffix))
    .map((file) => path.relative(root, file))
    .sort();
}

function invocationFor(run) {
  if (run.type === 'command') return { command: run.command, args: run.args };
  if (run.type === 'node-test') {
    const files = nodeTestFiles(run);
    if (files.length === 0) throw new Error(`${run.id} 没有发现测试文件`);
    return { command: process.execPath, args: ['--test', ...files] };
  }
  throw new Error(`${run.id} 使用未知执行类型：${run.type}`);
}

function runOne(run) {
  const invocation = invocationFor(run);
  console.log(`\n==> ${run.id}`);
  console.log(`$ ${[invocation.command, ...invocation.args].join(' ')}`);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${run.id} 失败，退出码 ${result.status ?? 'unknown'}`);
}

function usage() {
  console.log('用法：node scripts/run-quality.mjs --tier <contract|unit|browser|portability|install-smoke>');
  console.log('      node scripts/run-quality.mjs --all');
  console.log('      node scripts/run-quality.mjs --list');
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--all') return { tiers: manifest.allTiers };
  if (argv.length === 1 && argv[0] === '--list') return { list: true, tiers: [] };
  if (argv.length === 2 && argv[0] === '--tier') return { tiers: [argv[1]] };
  throw new Error('参数无效');
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    usage();
    process.exitCode = 2;
    return;
  }

  const errors = validateQualityManifest({ manifest });
  if (errors.length > 0) {
    console.error('质量清单校验失败：');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  if (options.list) {
    for (const [tier, runs] of Object.entries(manifest.tiers)) {
      console.log(`${tier}: ${runs.map((run) => run.id).join(', ')}`);
    }
    return;
  }

  for (const tier of options.tiers) {
    const runs = manifest.tiers[tier];
    if (!runs) {
      console.error(`未知 tier：${tier}`);
      usage();
      process.exitCode = 2;
      return;
    }
    for (const run of runs) runOne(run);
  }
  console.log(`\n质量门通过：${options.tiers.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
