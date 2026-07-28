import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url));
const UPDATE_CHECK = path.resolve(HOOK_DIR, '..', 'check-update.sh');
const LOCALE_CONTEXT = '【VoidTech locale】团队默认使用简体中文交流；代码、标识符、命令、文件路径与提交信息使用 English；技术文档正文使用中文、代码块使用 English；修改已有文件时遵循文件既有语言，避免中英文混杂。';

export default function registerVoidTechSession(pi) {
  pi.on('session_start', async (_event, ctx) => {
    pi.sendMessage(
      {
        customType: 'voidtech-locale',
        content: LOCALE_CONTEXT,
        display: false,
        attribution: 'extension',
      },
      { deliverAs: 'nextTurn', triggerTurn: false },
    );

    try {
      const result = await pi.exec('bash', [UPDATE_CHECK, '--host', 'omp'], {
        cwd: ctx.cwd,
      });
      if (result.code !== 0 || !result.stdout.trim()) return;

      const payload = JSON.parse(result.stdout);
      const updateContext = payload?.hookSpecificOutput?.additionalContext;
      if (!updateContext) return;

      pi.sendMessage(
        {
          customType: 'voidtech-update',
          content: updateContext,
          display: false,
          attribution: 'extension',
        },
        { deliverAs: 'nextTurn', triggerTurn: false },
      );
    } catch {
      // Update checks are best-effort and must never block session startup.
    }
  });
}
