// Controller-backed retrieval（二期技术设计 §7.5，Task 4.3，P2-27）。
// reviewer 不获得原生 Read/Grep/Glob；只能使用本层封闭工具面：
// listFiles / readFile / searchText / getDiff / getSpec / listRounds / listEvidence / readEvidence。
// 安全与预算由 controller 实现：路径经 snapshot 唯一入口校验；evidence 只按 ID 路由；
// 每次响应与 session 累计字节统一计账；预算不足明确返回 budget_limited，
// 不允许静默截断后继续给出 delegate-eligible 结论。

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { canonicalJson } from './validate.mjs';
import { runDir } from './reviewstore.mjs';
import { resolveSnapshotPath } from './reviewsnapshot.mjs';

export const SINGLE_READ_CAP = 64 * 1024;
export const SESSION_TOTAL_CAP = 512 * 1024;
const MAX_SEARCH_FILES = 500;
const MAX_SEARCH_MATCHES = 100;
const MAX_LINE_CHARS = 400;
const MAX_LIST_ENTRIES = 2000;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function looksBinary(buffer) {
  const probe = buffer.subarray(0, 8192);
  return probe.includes(0);
}

// 超长行按稳定规则截断：单行超过 MAX_LINE_CHARS 保留前缀并标记
function clampLines(text) {
  let clamped = false;
  const lines = text.split('\n').map((line) => {
    if (line.length <= MAX_LINE_CHARS) return line;
    clamped = true;
    return `${line.slice(0, MAX_LINE_CHARS)}…[line truncated]`;
  });
  return { text: lines.join('\n'), clamped };
}

export function createRetrievalSession({ snapshot, manifest, diffText, projectDir, runId, spec, budgetLimit = SESSION_TOTAL_CAP }) {
  const changedPaths = new Set(manifest.diff.files.map((f) => f.path));
  const session = {
    budget_limit_bytes: budgetLimit,
    budget_used_bytes: 0,
    budget_limited: false,
    limitations: [],
    inspected_files: new Set(),
    inspected_evidence: new Set(),
  };

  // 统一计账：任何响应先过预算；超限即整体拒绝并进入 budget_limited，不静默截断
  function charge(bytes, makeResponse) {
    if (session.budget_used_bytes + bytes > session.budget_limit_bytes) {
      session.budget_limited = true;
      if (!session.limitations.includes('budget_limited')) session.limitations.push('budget_limited');
      return {
        ok: false, reason: 'budget_limited',
        budget_used_bytes: session.budget_used_bytes, budget_limit_bytes: session.budget_limit_bytes,
      };
    }
    session.budget_used_bytes += bytes;
    return makeResponse();
  }

  function markLimitation(kind) {
    if (!session.limitations.includes(kind)) session.limitations.push(kind);
  }

  return {
    session,

    listFiles(pattern = null) {
      let files = snapshot.tracked_files;
      if (pattern) {
        const regex = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
        files = files.filter((f) => regex.test(f));
      }
      const truncated = files.length > MAX_LIST_ENTRIES;
      const listed = files.slice(0, MAX_LIST_ENTRIES);
      const payload = listed.join('\n');
      return charge(Buffer.byteLength(payload, 'utf8'), () => ({
        ok: true, files: listed, truncated, source: { locator: 'tracked-files', hash: snapshot.tracked_files_manifest_hash },
      }));
    },

    readFile(path, { offset = 0, limit = SINGLE_READ_CAP } = {}) {
      const resolved = resolveSnapshotPath(snapshot, path);
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      const buffer = readFileSync(resolved.path);
      if (looksBinary(buffer)) {
        markLimitation('binary_limited');
        return { ok: false, reason: 'binary_limited', path: resolved.relative };
      }
      const cap = Math.min(limit, SINGLE_READ_CAP);
      const slice = buffer.subarray(offset, offset + cap).toString('utf8');
      const { text, clamped } = clampLines(slice);
      const truncated = offset + cap < buffer.length || clamped;
      return charge(Buffer.byteLength(text, 'utf8'), () => {
        session.inspected_files.add(resolved.relative);
        return {
          ok: true, content: text, offset, truncated,
          total_bytes: buffer.length,
          source: { locator: resolved.relative, blob_sha256: sha256(buffer.toString('utf8')) },
        };
      });
    },

    searchText(query, paths = null) {
      if (typeof query !== 'string' || query.length === 0) return { ok: false, reason: 'invalid_query' };
      const candidates = (paths ?? snapshot.tracked_files).slice(0, MAX_SEARCH_FILES);
      const filesTruncated = (paths ?? snapshot.tracked_files).length > MAX_SEARCH_FILES;
      const matches = [];
      for (const path of candidates) {
        if (matches.length >= MAX_SEARCH_MATCHES) break;
        const resolved = resolveSnapshotPath(snapshot, path);
        if (!resolved.ok) continue;
        const buffer = readFileSync(resolved.path);
        if (looksBinary(buffer)) continue;
        const lines = buffer.toString('utf8').split('\n');
        for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i += 1) {
          if (lines[i].includes(query)) {
            matches.push({ path: resolved.relative, line: i + 1, text: lines[i].slice(0, MAX_LINE_CHARS) });
          }
        }
      }
      const payload = JSON.stringify(matches);
      return charge(Buffer.byteLength(payload, 'utf8'), () => ({
        ok: true, matches, matches_truncated: matches.length >= MAX_SEARCH_MATCHES, files_truncated: filesTruncated,
      }));
    },

    // 只接受 Fact Pack manifest 记录的 base/candidate 对（§7.5）
    getDiff(base, candidate, { offset = 0, limit = SINGLE_READ_CAP } = {}) {
      if (base !== manifest.base_commit || candidate !== manifest.candidate_commit) {
        return { ok: false, reason: 'diff_pair_not_in_manifest' };
      }
      const cap = Math.min(limit, SINGLE_READ_CAP);
      const slice = diffText.slice(offset, offset + cap);
      const truncated = offset + cap < diffText.length;
      return charge(Buffer.byteLength(slice, 'utf8'), () => {
        // diff 覆盖视作对全部 changed files 的 diff 级检查（文件级细读另计）
        for (const f of manifest.diff.files) session.inspected_files.add(f.path);
        return {
          ok: true, content: slice, offset, truncated,
          total_bytes: manifest.diff.total_bytes, source: { locator: 'diff', sha256: manifest.diff.sha256 },
        };
      });
    },

    getSpec() {
      const text = canonicalJson(spec);
      return charge(Buffer.byteLength(text, 'utf8'), () => ({
        ok: true, content: text, source: { locator: 'spec', sha256: manifest.spec.sha256 },
      }));
    },

    listRounds() {
      const payload = JSON.stringify(manifest.rounds);
      return charge(Buffer.byteLength(payload, 'utf8'), () => ({ ok: true, rounds: manifest.rounds }));
    },

    listEvidence() {
      const payload = JSON.stringify(manifest.evidence);
      return charge(Buffer.byteLength(payload, 'utf8'), () => ({ ok: true, evidence: manifest.evidence }));
    },

    // evidence 只按 ID 读取；agent 提交的路径不能映射插件数据目录（§7.5）
    readEvidence(evidenceId, { offset = 0, limit = SINGLE_READ_CAP } = {}) {
      const entry = manifest.evidence.find((e) => e.id === evidenceId);
      if (!entry) return { ok: false, reason: 'unknown_evidence_id' };
      if (isAbsolute(entry.locator) || entry.locator.split('/').includes('..')) {
        return { ok: false, reason: 'invalid_locator' };
      }
      const path = join(runDir(projectDir, runId), entry.locator);
      if (!existsSync(path)) {
        markLimitation('source_limited');
        return { ok: false, reason: 'source_limited', evidence_id: evidenceId };
      }
      const content = readFileSync(path, 'utf8');
      if (sha256(content) !== entry.file_sha256 || statSync(path).size !== entry.file_bytes) {
        markLimitation('source_limited');
        return { ok: false, reason: 'source_limited', evidence_id: evidenceId, detail: 'hash_mismatch' };
      }
      const cap = Math.min(limit, SINGLE_READ_CAP);
      const slice = content.slice(offset, offset + cap);
      const truncated = offset + cap < content.length || entry.truncated;
      return charge(Buffer.byteLength(slice, 'utf8'), () => {
        session.inspected_evidence.add(evidenceId);
        return {
          ok: true, content: slice, offset, truncated,
          source: { locator: entry.locator, file_sha256: entry.file_sha256, stream_sha256: entry.stream_sha256 },
        };
      });
    },

    // coverage（§7.4）：complete 只在全部 changed files 与 evidence 已检查且无任何 limitation 时成立。
    coverage() {
      const changedInspected = [...changedPaths].filter((p) => session.inspected_files.has(p)).length;
      const evidenceInspected = manifest.evidence.filter((e) => session.inspected_evidence.has(e.id)).length;
      let status = 'complete';
      if (session.limitations.includes('budget_limited')) status = 'budget_limited';
      else if (session.limitations.includes('source_limited')) status = 'source_limited';
      else if (session.limitations.includes('binary_limited') || manifest.diff.files.some((f) => f.binary)) status = 'binary_limited';
      else if (changedInspected < changedPaths.size || evidenceInspected < manifest.evidence.length) status = 'source_limited';
      return {
        status,
        changed_files_total: changedPaths.size,
        changed_files_inspected: changedInspected,
        evidence_items_total: manifest.evidence.length,
        evidence_items_inspected: evidenceInspected,
        budget_used_bytes: session.budget_used_bytes,
        budget_limit_bytes: session.budget_limit_bytes,
        limitations: [...session.limitations],
      };
    },
  };
}
