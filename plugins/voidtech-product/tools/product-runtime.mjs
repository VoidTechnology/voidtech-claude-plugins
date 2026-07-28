import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = path.resolve(TOOL_DIR, '..', 'skills', 'prd-from-requirements', 'scripts');
const SCRIPTS = Object.freeze({
  'xlsx-to-markdown': 'xlsx-to-markdown.py',
  'check-prd-tree': 'check-prd-tree.py',
  'generate-dashboard': 'generate-dashboard.py',
  'prd-sync': 'prd-sync.py',
});

export default function createProductRuntimeTool(pi) {
  return {
    name: 'voidtech_product_runtime',
    label: 'VoidTech Product Runtime',
    description: '运行随 voidtech-product 分发的 PRD 转换、同步、Logic Atlas、Dashboard 与机械检查脚本；不经过 shell，并保留脚本退出码。',
    strict: true,
    parameters: pi.zod.object({
      script: pi.zod.enum(Object.keys(SCRIPTS)),
      args: pi.zod.array(pi.zod.string()).optional().default([]),
    }),

    async execute(_toolCallId, params, _onUpdate, ctx, signal) {
      const scriptFile = SCRIPTS[params.script];
      if (!scriptFile) throw new Error(`Unsupported product runtime script: ${params.script}`);

      const scriptPath = path.join(SCRIPT_DIR, scriptFile);
      const result = await pi.exec('python3', [scriptPath, ...(params.args ?? [])], {
        cwd: ctx?.cwd ?? pi.cwd,
        signal,
      });
      if (result.killed) throw new Error(`${params.script} was cancelled`);

      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      return {
        content: [{
          type: 'text',
          text: output || `${params.script} exited with code ${result.code}`,
        }],
        details: {
          script: params.script,
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
        },
      };
    },
  };
}
