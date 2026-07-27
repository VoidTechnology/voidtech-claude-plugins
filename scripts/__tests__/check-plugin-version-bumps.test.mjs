import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareSemver,
  evaluateVersionBumps,
  validateReleaseSelection,
} from '../check-plugin-version-bumps.mjs';

const baseVersions = new Map([
  ['voidtech-core', '1.2.3'],
  ['voidtech-loop', '0.3.0'],
]);

const currentVersions = new Map([
  ['voidtech-core', '1.2.4'],
  ['voidtech-loop', '0.3.0'],
]);

test('semantic version comparison only accepts a strictly newer version', () => {
  assert.equal(compareSemver('1.2.4', '1.2.3'), 1);
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('2.0.0', '10.0.0'), -1);
  assert.throws(() => compareSemver('latest', '1.0.0'), /语义化版本/);
});

test('runtime plugin changes require a version bump and changelog entry', () => {
  const errors = evaluateVersionBumps({
    changedFiles: ['plugins/voidtech-loop/src/controller.mjs'],
    baseVersions,
    currentVersions,
    changelog: '# Changelog\n',
  });
  assert.ok(errors.some((error) => error.includes('voidtech-loop') && error.includes('版本')));
});

test('a newer version and matching changelog entry satisfy the release boundary', () => {
  const errors = evaluateVersionBumps({
    changedFiles: ['plugins/voidtech-core/skills/research/SKILL.md'],
    baseVersions,
    currentVersions,
    changelog: '## voidtech-core 1.2.4 - 2026-07-27\n',
  });
  assert.deepEqual(errors, []);
});

test('root governance and CI changes do not require a plugin release', () => {
  const errors = evaluateVersionBumps({
    changedFiles: ['README.md', '.github/workflows/quality-contract.yml', 'scripts/check-doc-contract.mjs'],
    baseVersions,
    currentVersions,
    changelog: '# Changelog\n',
  });
  assert.deepEqual(errors, []);
});

test('release selection must match a manifest version and changelog entry', () => {
  assert.deepEqual(
    validateReleaseSelection({
      plugin: 'voidtech-core',
      version: '1.2.4',
      currentVersions,
      changelog: '## voidtech-core 1.2.4 - 2026-07-27\n',
    }),
    [],
  );
  assert.ok(
    validateReleaseSelection({
      plugin: 'voidtech-core',
      version: '1.2.3',
      currentVersions,
      changelog: '# Changelog\n',
    }).length >= 1,
  );
});
