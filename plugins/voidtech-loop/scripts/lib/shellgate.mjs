// 任意 shell 命令的统一确认门。所有会执行 Goal Spec 的入口都必须复用这里，
// 避免新增 CLI 时只接入执行器、漏掉用户风险确认。

export function shellExecutionGate(validation, { allowShell = false } = {}) {
  if (!validation?.ok) return { ok: true, required: false, commands: [], message: '' };

  const commands = [
    ...validation.normalized.evals
      .filter((evalDef) => evalDef.shell)
      .map((evalDef) => ({ label: `eval ${evalDef.id}`, command: evalDef.command })),
    ...(validation.normalized.setup ?? [])
      .map((command) => ({ label: 'setup', command })),
  ];
  if (commands.length === 0) return { ok: true, required: false, commands, message: '' };

  const lines = [
    'Goal Spec 含将以 shell 执行的任意命令，需要单独确认后才能执行：',
    ...commands.map((item) => `  [${item.label}] ${item.command}`),
    '确认以上命令无误后，加 --allow-shell 重新执行。',
  ];
  return {
    ok: allowShell,
    required: true,
    commands,
    message: lines.join('\n'),
  };
}
