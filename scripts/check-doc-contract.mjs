#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const AUDIT_STATUS = /状态[：:]\s*(Current|Historical Snapshot)/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listDirectories(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function listFiles(directory, suffix = '') {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => entry.name)
    .sort();
}

function walkFiles(directory, predicate, files = []) {
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      walkFiles(absolute, predicate, files);
    } else if (predicate(absolute)) {
      files.push(absolute);
    }
  }
  return files;
}

export function collectRepositoryFacts(root = ROOT) {
  const marketplacePath = path.join(root, '.claude-plugin', 'marketplace.json');
  const marketplace = readJson(marketplacePath);
  const plugins = marketplace.plugins.map((entry) => {
    const cwd = entry.source.replace(/^\.\//, '');
    const manifestPath = path.join(root, cwd, '.claude-plugin', 'plugin.json');
    const manifest = readJson(manifestPath);
    return { name: manifest.name, version: manifest.version, cwd };
  }).sort((left, right) => left.name.localeCompare(right.name));

  let skillCount = 0;
  let agentCount = 0;
  for (const plugin of plugins) {
    skillCount += listDirectories(path.join(root, plugin.cwd, 'skills'))
      .filter((name) => fs.existsSync(path.join(root, plugin.cwd, 'skills', name, 'SKILL.md')))
      .length;
    agentCount += listFiles(path.join(root, plugin.cwd, 'agents'), '.md').length;
  }

  return { plugins, skillCount, agentCount };
}

function auditFiles(root) {
  return walkFiles(path.join(root, 'docs'), (file) => file.endsWith('AUDIT.md'));
}

export function validateDocContract(root = ROOT, facts = collectRepositoryFacts(root)) {
  const errors = [];
  const readmePath = path.join(root, 'README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');
  const countMatch = readme.match(/\*\*(\d+)\s*个自包含技能\s*\+\s*(\d+)\s*个专业\s*subagent\*\*/i);
  if (!countMatch) {
    errors.push('README.md 缺少可机器解析的技能与 subagent 数量声明');
  } else {
    const documentedSkills = Number(countMatch[1]);
    const documentedAgents = Number(countMatch[2]);
    if (documentedSkills !== facts.skillCount) {
      errors.push(`README.md 技能数量为 ${documentedSkills}，实际为 ${facts.skillCount}`);
    }
    if (documentedAgents !== facts.agentCount) {
      errors.push(`README.md subagent 数量为 ${documentedAgents}，实际为 ${facts.agentCount}`);
    }
  }

  const readmeLines = readme.split(/\r?\n/);
  for (const plugin of facts.plugins) {
    const row = readmeLines.find((line) => line.includes(`\`${plugin.name}\``) && line.trimStart().startsWith('|'));
    if (!row || !row.includes(`| ${plugin.version} |`)) {
      errors.push(`README.md 插件表未同步 ${plugin.name} ${plugin.version}`);
    }
  }

  for (const file of auditFiles(root)) {
    if (!AUDIT_STATUS.test(fs.readFileSync(file, 'utf8'))) {
      errors.push(`${path.relative(root, file)} 缺少“状态：Current”或“状态：Historical Snapshot”`);
    }
  }

  return errors;
}

function markdownTargets(markdown) {
  return [...markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1].trim().replace(/^<|>$/g, ''))
    .filter((target) => target && !/^(?:https?:|mailto:|#)/i.test(target));
}

export function validateLocalMarkdownLinks(root = ROOT, relativeFiles = []) {
  const errors = [];
  for (const relativeFile of relativeFiles) {
    const source = path.join(root, relativeFile);
    if (!fs.existsSync(source)) {
      errors.push(`${relativeFile} 不存在`);
      continue;
    }
    for (const target of markdownTargets(fs.readFileSync(source, 'utf8'))) {
      const fileTarget = decodeURIComponent(target.split('#', 1)[0]);
      if (!fileTarget) continue;
      const resolved = path.resolve(path.dirname(source), fileTarget);
      if (!fs.existsSync(resolved)) {
        errors.push(`${relativeFile} 的本地链接不存在：${target}`);
      }
    }
  }
  return errors;
}

export function currentContractDocs(root = ROOT) {
  const rootDocs = [
    'README.md',
    'ONBOARDING.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'CODE_OF_CONDUCT.md',
    'AGENTS.md',
  ].filter((file) => fs.existsSync(path.join(root, file)));
  const ruleDocs = walkFiles(path.join(root, 'docs', 'dev-rules'), (file) => file.endsWith('.md'))
    .map((file) => path.relative(root, file));
  const audits = auditFiles(root).map((file) => path.relative(root, file));
  return [...new Set([...rootDocs, ...ruleDocs, ...audits])].sort();
}

export function runDocContract(root = ROOT) {
  const facts = collectRepositoryFacts(root);
  return [
    ...validateDocContract(root, facts),
    ...validateLocalMarkdownLinks(root, currentContractDocs(root)),
  ];
}

function main() {
  const errors = runDocContract(ROOT);
  if (errors.length > 0) {
    console.error('文档契约检查失败：');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('文档契约检查通过');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
