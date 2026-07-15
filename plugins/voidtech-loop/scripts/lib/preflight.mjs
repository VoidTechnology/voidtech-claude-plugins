// 启动体检的环境门（PRD 4.1 第 1 步 / 5.5 / V9）：试点 OS allowlist 与关键命令。
// 平台与命令探测可注入，供测试在不改变宿主的前提下验证拒绝路径。

import { spawnSync } from 'node:child_process';

const MIN_CLAUDE_CODE = '2.1.210';

export function preflight({
  platform = process.platform,
  arch = process.arch,
  probe = defaultProbe,
} = {}) {
  const problems = [];

  // 试点 OS：仅 macOS arm64；其他直接拒绝，不 best-effort 继续
  if (platform !== 'darwin' || arch !== 'arm64') {
    problems.push({
      code: 'unsupported_os',
      message: `一期仅支持 macOS arm64，当前为 ${platform}/${arch}（未经一期验证，拒绝启动）`,
    });
  }

  for (const cmd of ['git', 'jq', 'claude', 'node']) {
    if (!probe.hasCommand(cmd)) {
      problems.push({ code: 'missing_command', message: `缺少必要命令：${cmd}` });
    }
  }

  const ccVersion = probe.claudeVersion();
  if (ccVersion && compareVersions(ccVersion, MIN_CLAUDE_CODE) < 0) {
    problems.push({
      code: 'claude_too_old',
      message: `Claude Code 版本 ${ccVersion} 低于下限 ${MIN_CLAUDE_CODE}`,
    });
  }

  return { ok: problems.length === 0, problems };
}

const defaultProbe = {
  hasCommand(cmd) {
    return spawnSync('command', ['-v', cmd], { shell: '/bin/bash', encoding: 'utf8' }).status === 0;
  },
  claudeVersion() {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    const m = r.stdout.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  },
};

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}
