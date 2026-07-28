const DANGEROUS_PATTERNS = Object.freeze([
  /\bgit(?:\s+[^\s;&|]+)*\s+push(?:\s|$)/,
  /\bgit\s+reset\s+--hard(?:\s|$)/,
  /\bgit\s+clean\s+-f(?:d)?(?:\s|$)/,
  /\bgit\s+branch\s+-D(?:\s|$)/,
  /\bgit\s+checkout\s+\.(?:\s|$)/,
  /\bgit\s+restore\s+\.(?:\s|$)/,
  /\bpush\s+--force(?:\s|$)/,
  /\breset\s+--hard(?:\s|$)/,
]);

export function isDangerousGitCommand(command) {
  return typeof command === 'string' && DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

export default function registerGitSafety(pi) {
  pi.on('tool_call', async (event) => {
    if (event.toolName !== 'bash' && event.toolName !== 'Bash') return;
    const command = event.input?.command;
    if (typeof command !== 'string') {
      return { block: true, reason: 'BLOCKED: hook input does not contain a Bash command.' };
    }
    if (isDangerousGitCommand(command)) {
      return {
        block: true,
        reason: `BLOCKED: '${command}' matches the configured dangerous Git command policy.`,
      };
    }
  });
}
