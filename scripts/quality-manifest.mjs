const manifest = {
  version: 1,
  plugins: [
    { name: 'voidtech-core', coverage: 'contract', reason: '静态 Skill、Agent、Hook 与共享 Runtime 由 portability、更新 Hook 和跨插件安装冒烟覆盖' },
    { name: 'voidtech-product', coverage: 'behavior' },
    { name: 'voidtech-design', coverage: 'contract', reason: '静态设计 Skill 由 portability 与安装冒烟覆盖' },
    { name: 'voidtech-engineering', coverage: 'contract', reason: '静态工程 Skill 与 Git Hook 由 portability 的危险/只读命令矩阵覆盖' },
    { name: 'voidtech-loop', coverage: 'behavior' },
    { name: 'voidtech-mcp-common', coverage: 'contract', reason: 'MCP manifest、精确版本和默认禁用由 portability 与安装冒烟覆盖' },
    { name: 'voidtech-mcp-apple', coverage: 'contract', reason: 'MCP manifest、精确版本和默认禁用由 portability 与安装冒烟覆盖' },
  ],
  testMatchers: [
    {
      id: 'repository-contracts',
      plugin: 'repository',
      tier: 'contract',
      prefix: 'scripts/__tests__/',
      suffix: '.test.mjs',
    },
    {
      id: 'product-behavior',
      plugin: 'voidtech-product',
      tier: 'unit',
      prefix: 'plugins/voidtech-product/skills/prd-from-requirements/tests/test_',
      suffix: '.py',
    },
    {
      id: 'loop-behavior',
      plugin: 'voidtech-loop',
      tier: 'unit',
      prefix: 'plugins/voidtech-loop/tests/',
      suffix: '.test.mjs',
    },
  ],
  tiers: {
    contract: [
      { id: 'repository-contracts', type: 'node-test', directory: 'scripts/__tests__', suffix: '.test.mjs' },
      { id: 'document-facts', type: 'command', command: 'node', args: ['scripts/check-doc-contract.mjs'] },
      { id: 'plugin-version-bumps', type: 'command', command: 'node', args: ['scripts/check-plugin-version-bumps.mjs'] },
    ],
    unit: [
      {
        id: 'product-behavior',
        type: 'command',
        command: 'python3',
        args: ['-m', 'unittest', 'discover', '-s', 'plugins/voidtech-product/skills/prd-from-requirements/tests', '-p', 'test_*.py'],
      },
      { id: 'loop-behavior', type: 'node-test', directory: 'plugins/voidtech-loop/tests', suffix: '.test.mjs' },
      { id: 'update-hook', type: 'command', command: 'bash', args: ['scripts/test-update-check.sh'] },
    ],
    browser: [
      { id: 'renderer-proof', type: 'command', command: 'node', args: ['scripts/validate-renderer.mjs'] },
    ],
    portability: [
      { id: 'plugin-portability', type: 'command', command: 'bash', args: ['scripts/check-portability.sh'] },
    ],
    'install-smoke': [
      { id: 'isolated-install', type: 'command', command: 'bash', args: ['scripts/check-portability.sh', '--install-smoke'] },
    ],
  },
  allTiers: ['contract', 'unit', 'browser', 'portability'],
};

export default manifest;
