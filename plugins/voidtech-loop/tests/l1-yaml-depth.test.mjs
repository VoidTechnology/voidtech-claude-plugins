// L1 回归测试（QA 发现）：深层嵌套 YAML 不得抛出未捕获的 RangeError，须降级为干净的校验失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSpecText } from '../scripts/lib/validate.mjs';
import { parseYaml, YamlError } from '../scripts/lib/yaml.mjs';

function deeplyNested(levels) {
  let s = '';
  for (let i = 0; i < levels; i++) s += `${' '.repeat(i)}k:\n`;
  s += `${' '.repeat(levels)}leaf: v\n`;
  return s;
}

test('L1: 深层嵌套 YAML 经 validateSpecText 返回 ok:false 而非抛出', () => {
  const r = validateSpecText(deeplyNested(500));
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
});

test('L1: parseYaml 对超深嵌套抛 YamlError（可捕获），而非 RangeError', () => {
  assert.throws(() => parseYaml(deeplyNested(500)), (err) => err instanceof YamlError);
});

test('L1: 正常深度（<上限）仍正常解析', () => {
  const r = parseYaml(deeplyNested(10));
  assert.equal(typeof r, 'object');
});
