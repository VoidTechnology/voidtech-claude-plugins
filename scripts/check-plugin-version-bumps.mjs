#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseSemver(value) {
  const match = SEMVER.exec(value);
  if (!match) throw new Error(`不是有效的语义化版本：${value}`);
  return match.slice(1).map(Number);
}

export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function readCurrentVersions(root = ROOT) {
  const marketplace = readJson(path.join(root, '.claude-plugin', 'marketplace.json'));
  return new Map(marketplace.plugins.map((entry) => {
    const cwd = entry.source.replace(/^\.\//, '');
    const manifest = readJson(path.join(root, cwd, '.claude-plugin', 'plugin.json'));
    return [manifest.name, manifest.version];
  }));
}

function git(root, args, options = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options }).trim();
}

export function readBaseVersions(root, baseRef, pluginNames) {
  const versions = new Map();
  for (const plugin of pluginNames) {
    const relative = `plugins/${plugin}/.claude-plugin/plugin.json`;
    try {
      const manifest = JSON.parse(git(root, ['show', `${baseRef}:${relative}`]));
      versions.set(plugin, manifest.version);
    } catch {
      // New plugins have no base version and must start with a valid semver.
    }
  }
  return versions;
}

function changedFilesForBase(root, baseRef) {
  const files = new Set();
  const add = (output) => output.split(/\r?\n/).filter(Boolean).forEach((file) => files.add(file));
  add(git(root, ['diff', '--name-only', `${baseRef}...HEAD`]));
  add(git(root, ['diff', '--name-only']));
  add(git(root, ['diff', '--cached', '--name-only']));
  add(git(root, ['ls-files', '--others', '--exclude-standard']));
  return [...files].sort();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function changelogHasVersion(changelog, plugin, version) {
  return new RegExp(`${escapeRegExp(plugin)}[^\\n]*${escapeRegExp(version)}`, 'i').test(changelog);
}

export function evaluateVersionBumps({ changedFiles, baseVersions, currentVersions, changelog }) {
  const errors = [];
  const changedPlugins = new Set();
  for (const file of changedFiles) {
    const match = /^plugins\/([^/]+)\//.exec(file);
    if (match) changedPlugins.add(match[1]);
  }

  for (const plugin of [...changedPlugins].sort()) {
    const current = currentVersions.get(plugin);
    if (!current) {
      errors.push(`插件目录 ${plugin} 未登记到 Marketplace`);
      continue;
    }
    try {
      parseSemver(current);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    const base = baseVersions.get(plugin);
    if (base && compareSemver(current, base) <= 0) {
      errors.push(`${plugin} 内容已变化，但版本 ${current} 未高于基线 ${base}`);
    }
    if (!changelogHasVersion(changelog, plugin, current)) {
      errors.push(`CHANGELOG.md 缺少 ${plugin} ${current} 条目`);
    }
  }
  return errors;
}

export function validateReleaseSelection({ plugin, version, currentVersions, changelog }) {
  const errors = [];
  if (!currentVersions.has(plugin)) {
    errors.push(`未知插件：${plugin}`);
    return errors;
  }
  if (currentVersions.get(plugin) !== version) {
    errors.push(`发布版本 ${version} 与 ${plugin} manifest ${currentVersions.get(plugin)} 不一致`);
  }
  if (!changelogHasVersion(changelog, plugin, version)) {
    errors.push(`CHANGELOG.md 缺少 ${plugin} ${version} 条目`);
  }
  return errors;
}

function parseArgs(argv) {
  const options = { base: process.env.QUALITY_BASE_REF || 'origin/main', plugin: null, version: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') options.base = argv[++index];
    else if (arg === '--release') {
      options.plugin = argv[++index];
      options.version = argv[++index];
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if ((options.plugin && !options.version) || (!options.plugin && options.version)) {
    throw new Error('--release 需要插件名和版本');
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const currentVersions = readCurrentVersions(ROOT);
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const errors = options.plugin
    ? validateReleaseSelection({ plugin: options.plugin, version: options.version, currentVersions, changelog })
    : evaluateVersionBumps({
      changedFiles: changedFilesForBase(ROOT, options.base),
      baseVersions: readBaseVersions(ROOT, options.base, currentVersions.keys()),
      currentVersions,
      changelog,
    });

  if (errors.length > 0) {
    console.error('插件版本门禁失败：');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(options.plugin ? `${options.plugin} ${options.version} 可发布` : '插件版本门禁通过');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
