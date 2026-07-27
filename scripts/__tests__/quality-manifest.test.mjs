import assert from 'node:assert/strict';
import test from 'node:test';

import manifest from '../quality-manifest.mjs';
import {
  matchDeclaredTest,
  validateQualityManifest,
} from '../run-quality.mjs';

test('quality manifest declares every published plugin and every discovered behavior test', () => {
  const errors = validateQualityManifest({ manifest });
  assert.deepEqual(errors, []);
});

test('manifest validation fails when a published plugin is missing', () => {
  const broken = {
    ...manifest,
    plugins: manifest.plugins.slice(1),
  };
  const errors = validateQualityManifest({ manifest: broken });
  assert.ok(errors.some((error) => error.includes('未登记插件')));
});

test('manifest validation fails when a test file is not assigned to a tier', () => {
  const errors = validateQualityManifest({
    manifest,
    discoveredTests: [
      'plugins/voidtech-loop/tests/controller.test.mjs',
      'plugins/voidtech-core/tests/new-behavior.test.mjs',
    ],
  });
  assert.ok(errors.some((error) => error.includes('new-behavior.test.mjs')));
});

test('test matchers cover Product unittest and Loop node:test files only once', () => {
  assert.equal(
    matchDeclaredTest(manifest, 'plugins/voidtech-product/skills/prd-from-requirements/tests/test_cli.py').length,
    1,
  );
  assert.equal(
    matchDeclaredTest(manifest, 'plugins/voidtech-loop/tests/controller.test.mjs').length,
    1,
  );
});
