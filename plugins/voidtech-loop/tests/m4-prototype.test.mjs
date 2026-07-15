// M4 回归测试（QA 发现）：手写 YAML 解析器与最小 schema 解释器构成 fail-closed 校验层，
// 不得因 __proto__ 键污染对象原型，必填校验必须只认自有属性——否则精心构造的 spec 可旁路必填检查。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { validateSchema } from '../scripts/lib/schema.mjs';

test('M4a: parseYaml 不因 __proto__ 键污染结果对象原型', () => {
  const r = parseYaml('__proto__:\n  injected: 1\nfoo: bar\n');
  const proto = Object.getPrototypeOf(r);
  assert.ok(proto === Object.prototype || proto === null, '结果对象原型必须干净');
  assert.equal('injected' in r, false, '不得从被污染的原型继承键');
});

test('M4b: validateSchema 的必填检查只认自有属性，不走原型链', () => {
  const obj = { foo: 'bar' };
  Object.setPrototypeOf(obj, { budgets: 1 });
  const errors = validateSchema(obj, {
    type: 'object',
    required: ['budgets'],
    properties: { foo: { type: 'string' } },
    additionalProperties: false,
  });
  assert.ok(
    errors.some((e) => e.message.includes('budgets')),
    '继承来的 budgets 不应满足必填检查',
  );
});

test('M4c: additionalProperties 检查只针对自有属性，不误报继承键', () => {
  const obj = { foo: 'bar' };
  Object.setPrototypeOf(obj, { sneaky: 1 });
  const errors = validateSchema(obj, {
    type: 'object',
    properties: { foo: { type: 'string' } },
    additionalProperties: false,
  });
  assert.equal(errors.length, 0, '干净对象不应因继承属性报未知字段');
});
