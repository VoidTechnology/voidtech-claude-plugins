// Task 1.5：Approval Bundle 版本化与 conditional hash match（技术设计 §3.6，P2-13）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  saveDraftVersion, readDraftVersion, latestDraftVersion,
  recordApproval, readApproval, verifyApprovedBundle, buildApprovalBundle,
} from '../scripts/lib/approvalbundle.mjs';
import { draftDir } from '../scripts/lib/reviewstore.mjs';

const hex64 = (c) => c.repeat(64);
const hex40 = (c) => c.repeat(40);
const RUN = 'payment-tests-a1b2c3d4';
const DRAFT = 'review-draft-1';

function content(overrides = {}) {
  return {
    parent_run_id: RUN,
    proposal_hash: hex64('1'),
    feedback_pack_hash: hex64('2'),
    goal_spec_hash: hex64('3'),
    base_commit: hex40('4'),
    execution_plan_hash: hex64('5'),
    delegation_grant_hash: null,
    evidence_snapshot_hash: hex64('6'),
    validation_plan_hash: hex64('7'),
    ...overrides,
  };
}

function withProject(callback) {
  const projectDir = mkdtempSync(join(tmpdir(), 'approval-'));
  try {
    return callback(projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

test('版本递增：内容变化产生新版本，内容相同幂等返回不虚增', () => withProject((projectDir) => {
  const v1 = saveDraftVersion(projectDir, RUN, DRAFT, content());
  assert.equal(v1.ok, true);
  assert.equal(v1.bundle.draft_version, 1);

  const same = saveDraftVersion(projectDir, RUN, DRAFT, content());
  assert.equal(same.unchanged, true);
  assert.equal(same.bundle.draft_version, 1);

  const v2 = saveDraftVersion(projectDir, RUN, DRAFT, content({ goal_spec_hash: hex64('9') }));
  assert.equal(v2.bundle.draft_version, 2);
  assert.notEqual(v2.bundle.approval_bundle_hash, v1.bundle.approval_bundle_hash);
  assert.equal(latestDraftVersion(projectDir, RUN, DRAFT), 2);
}));

test('批准当前版本：记录精确 hash 与 actor，不保存 allow_shell', () => withProject((projectDir) => {
  const v1 = saveDraftVersion(projectDir, RUN, DRAFT, content());
  const approved = recordApproval(projectDir, RUN, DRAFT, 1);
  assert.equal(approved.ok, true);
  assert.equal(approved.approval.approval_bundle_hash, v1.bundle.approval_bundle_hash);
  assert.equal(approved.approval.approved_by.kind, 'local_user');
  assert.equal(approved.approval.approved_by.identity_verified, false);
  assert.equal(approved.approval.approve_execution, true);
  assert.equal('allow_shell' in approved.approval, false);

  const verify = verifyApprovedBundle(projectDir, RUN, DRAFT, approved.approval);
  assert.equal(verify.ok, true);
  assert.equal(verify.bundle.draft_version, 1);
}));

test('P2-13：validation 期间出现新版本，旧批准失效（draft_superseded）', () => withProject((projectDir) => {
  saveDraftVersion(projectDir, RUN, DRAFT, content());
  const approved = recordApproval(projectDir, RUN, DRAFT, 1);

  // 模拟批准后、validation 完成前草稿被再生成（任何内容变化都会走到新版本）
  saveDraftVersion(projectDir, RUN, DRAFT, content({ execution_plan_hash: hex64('e') }));

  const verify = verifyApprovedBundle(projectDir, RUN, DRAFT, approved.approval);
  assert.deepEqual(
    { ok: verify.ok, reason: verify.reason, latest: verify.latest_version },
    { ok: false, reason: 'draft_superseded', latest: 2 },
  );
}));

test('草稿文件被篡改：重算 hash 不自洽，拒绝并报 bundle_tampered', () => withProject((projectDir) => {
  saveDraftVersion(projectDir, RUN, DRAFT, content());
  const approved = recordApproval(projectDir, RUN, DRAFT, 1);

  const path = join(draftDir(projectDir, RUN, DRAFT), 'bundle-v1.json');
  const tampered = JSON.parse(readFileSync(path, 'utf8'));
  tampered.base_commit = hex40('f');
  writeFileSync(path, JSON.stringify(tampered, null, 2));

  assert.equal(readDraftVersion(projectDir, RUN, DRAFT, 1).reason, 'bundle_tampered');
  assert.equal(verifyApprovedBundle(projectDir, RUN, DRAFT, approved.approval).reason, 'bundle_tampered');
}));

test('批准记录指向的 hash 与草稿不符：approval_stale', () => withProject((projectDir) => {
  saveDraftVersion(projectDir, RUN, DRAFT, content());
  const approved = recordApproval(projectDir, RUN, DRAFT, 1);
  const stale = { ...approved.approval, approval_bundle_hash: hex64('d') };
  assert.equal(verifyApprovedBundle(projectDir, RUN, DRAFT, stale).reason, 'approval_stale');
}));

test('未授权执行的批准不能通过 execution gate 前置检查', () => withProject((projectDir) => {
  saveDraftVersion(projectDir, RUN, DRAFT, content());
  const approved = recordApproval(projectDir, RUN, DRAFT, 1, { approveExecution: false });
  assert.equal(verifyApprovedBundle(projectDir, RUN, DRAFT, approved.approval).reason, 'execution_not_approved');
}));

test('readApproval 与非法输入路径', () => withProject((projectDir) => {
  assert.equal(readApproval(projectDir, RUN, DRAFT, 1).reason, 'missing');
  assert.equal(latestDraftVersion(projectDir, RUN, DRAFT), 0);

  const bad = buildApprovalBundle({ draftId: DRAFT, draftVersion: 1, ...content({ proposal_hash: 'not-a-hash' }) });
  assert.deepEqual({ ok: bad.ok, reason: bad.reason }, { ok: false, reason: 'invalid_bundle' });
}));
