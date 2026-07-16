// Review Fact Pack builder（二期技术设计 §7.1，Task 4.1，P2-07 前置）。
// manifest 是完整事实索引：frozen spec、terminal state projection、candidate diff、
// rounds 摘要与 evidence 元数据，只存 locator/bytes/hash，不复制正文。
// 任何来源缺失或损坏都 fail closed：不产出 pack、不启动 reviewer，报告缺失来源清单。

import { existsSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute, join, relative } from 'node:path';
import { canonicalJson } from './validate.mjs';
import { readState, atomicWrite } from './statestore.mjs';
import { gitRun, resolveCommit } from './gitops.mjs';
import { runDir, factPackDir, validateReviewArtifact, artifactHash } from './reviewstore.mjs';

const TERMINAL = ['EVALS_PASSED', 'STOPPED', 'ACCEPTED'];

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// terminal state projection（§7.2）：只含裁定所需的稳定字段，round 明细归索引与摘要。
function projectTerminalState(state) {
  const rounds = state.rounds ?? [];
  const evidenceTotal = rounds.reduce((sum, r) => sum
    + (r.eval?.results ?? []).reduce((s, e) => s + e.runs.filter((run) => run.evidence).length, 0), 0);
  return {
    status: state.status,
    stop_reason: state.stop_reason ?? null,
    iteration: state.iteration ?? 0,
    rounds_total: rounds.length,
    evals_total: state.spec?.evals?.length ?? 0,
    evidence_total: evidenceTotal,
    last_checkpoint: state.last_checkpoint ?? null,
    started_at: state.started_at ?? null,
    updated_at: state.updated_at ?? null,
    cost_unavailable: state.cost?.unavailable ?? true,
    cost_total_usd: state.cost?.unavailable ? null : (state.cost?.total_usd ?? null),
  };
}

function parseNumstat(text) {
  const files = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split('\t');
    files.push({
      path: rest.join('\t'),
      additions: a === '-' ? null : Number(a),
      deletions: d === '-' ? null : Number(d),
      binary: a === '-' || d === '-',
    });
  }
  return files;
}

// 收集 evidence 元数据：state 记录的是原始流（total_bytes/sha256/truncated），
// 磁盘文件是截断捕获；两者都进 manifest，缺失文件进入 missing 清单触发 fail closed。
function collectEvidence(state, stateDir) {
  const entries = [];
  const missing = [];
  for (const round of state.rounds ?? []) {
    for (const evalResult of round.eval?.results ?? []) {
      evalResult.runs.forEach((run, runIdx) => {
        if (!run.evidence) return;
        const id = `${evalResult.id}-i${round.iteration}-r${runIdx + 1}`;
        const path = isAbsolute(run.evidence.path) ? run.evidence.path : join(stateDir, run.evidence.path);
        if (!existsSync(path)) {
          missing.push({ source: 'evidence', id, path });
          return;
        }
        const content = readFileSync(path, 'utf8');
        entries.push({
          id,
          locator: relative(stateDir, path),
          file_bytes: statSync(path).size,
          file_sha256: sha256(content),
          stream_total_bytes: run.evidence.total_bytes,
          stream_sha256: run.evidence.sha256,
          truncated: run.evidence.truncated === true,
        });
      });
    }
  }
  return { entries, missing };
}

export function buildReviewFactPack({ repo, projectDir, runId, grantHash = null }) {
  const stateDir = runDir(projectDir, runId);
  const stateResult = readState(stateDir);
  if (!stateResult.ok) {
    return { ok: false, reason: 'state_unreadable', missing: [{ source: 'state', detail: stateResult.reason }] };
  }
  const state = stateResult.state;
  if (!TERMINAL.includes(state.status)) {
    return { ok: false, reason: 'not_terminal', status: state.status };
  }

  const candidate = state.candidate_commit ?? state.last_checkpoint;
  if (!candidate) return { ok: false, reason: 'no_candidate' };
  const base = resolveCommit(repo, state.base_commit);
  const cand = resolveCommit(repo, candidate);
  if (!base.ok || !cand.ok) {
    return { ok: false, reason: 'commit_unresolvable', missing: [{ source: 'git', detail: `${state.base_commit} / ${candidate}` }] };
  }

  const patch = gitRun(repo, ['diff', base.sha, cand.sha]);
  const numstat = gitRun(repo, ['diff', '--numstat', base.sha, cand.sha]);
  if (patch.status !== 0 || numstat.status !== 0) {
    return { ok: false, reason: 'diff_failed', missing: [{ source: 'diff', detail: patch.stderr || numstat.stderr }] };
  }

  const specCanonical = canonicalJson(state.spec);
  const evidence = collectEvidence(state, stateDir);
  if (evidence.missing.length > 0) {
    return { ok: false, reason: 'evidence_missing', missing: evidence.missing };
  }

  const manifest = {
    schema_version: 1,
    fact_pack_id: `fact-pack-${randomBytes(6).toString('hex')}`,
    run_id: runId,
    goal_hash: state.goal_hash,
    state_checksum: stateResult.checksum,
    base_commit: base.sha,
    candidate_commit: cand.sha,
    terminal_state: projectTerminalState(state),
    spec: { locator: 'spec', total_bytes: Buffer.byteLength(specCanonical, 'utf8'), sha256: sha256(specCanonical) },
    diff: {
      locator: 'diff',
      total_bytes: Buffer.byteLength(patch.stdout, 'utf8'),
      sha256: sha256(patch.stdout),
      files: parseNumstat(numstat.stdout),
    },
    rounds: (state.rounds ?? []).map((r) => ({
      iteration: r.iteration,
      locator: `round-${r.iteration}`,
      no_change: r.no_change === true,
      checkpoint: r.checkpoint ?? null,
      eval_passed: r.eval ? r.eval.passed : null,
      failed_ids: r.eval?.failed_ids ?? [],
    })),
    evidence: evidence.entries,
    snapshot: { snapshot_id: null, tracked_files_manifest_hash: null },
    delegation_grant_hash: grantHash,
  };

  const validation = validateReviewArtifact('review_fact_pack', manifest);
  if (!validation.ok) return { ok: false, reason: 'invalid_manifest', errors: validation.errors };

  return { ok: true, manifest, input_manifest_hash: artifactHash(manifest), diff_text: patch.stdout };
}

// input_manifest_hash 的定义（§7.1）：canonical manifest JSON 的 SHA-256；
// snapshot 绑定（4.2）后 manifest 变化会产生新 hash，proposal 引用的是绑定后的值。
export function computeInputManifestHash(manifest) {
  return artifactHash(manifest);
}

export function persistFactPack(projectDir, runId, manifest) {
  const dir = factPackDir(projectDir, runId, manifest.fact_pack_id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'manifest.json');
  atomicWrite(path, JSON.stringify(manifest, null, 2));
  return { ok: true, path };
}

export function readFactPack(projectDir, runId, factPackId) {
  const path = join(factPackDir(projectDir, runId, factPackId), 'manifest.json');
  if (!existsSync(path)) return { ok: false, reason: 'missing' };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  const validation = validateReviewArtifact('review_fact_pack', manifest);
  if (!validation.ok) return { ok: false, reason: 'invalid', errors: validation.errors };
  return { ok: true, manifest, input_manifest_hash: artifactHash(manifest) };
}
