# 编写 Agent 实现说明

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

agent 实现说明是 issue 或 PR 进入 `ready-for-agent` 状态时发布的一条结构化评论。原始正文和讨论用于补充背景，实现说明则明确后续 agent 要完成的行为和验收标准。

实现说明陈述 **agent 应当做什么**。对于 issue，它描述需要从头实现的变更；对于 PR，它描述现有 diff 还缺少什么，例如补全实现、修复遗漏或回应评审意见。两种情况使用相同原则，PR 示例会单独展示差异。

## 原则

### 优先保证长期有效

issue 可能在 `ready-for-agent` 状态停留数天或数周，其间代码库会发生变化。实现说明在文件重命名、移动或重构后仍应有效。

- **要**描述接口、类型和行为契约
- **要**点名 agent 应当查找或修改的具体类型、函数签名或配置形态
- **不要**引用文件路径——它们会过时
- **不要**引用行号
- **不要**假设当前实现结构会保持不变

### 描述行为，而非过程

描述系统**应当做什么**，而非**如何实现**。agent 会重新探查代码库并自行做出实现决策。

- **好：** "The `SkillConfig` type should accept an optional `schedule` field of type `CronExpression`"
- **坏：** "Open src/types/skill.ts and add a schedule field on line 42"
- **好：** "When a user runs `/voidtech-core:prepare-issue` with no arguments, they should see a summary of issues needing attention"
- **坏：** "Add a switch statement in the main handler function"

### 完整的验收标准

agent 需要知道何时算完成。每份实现说明都必须包含具体、可测试且可独立验证的验收标准。

- **好：** "Running `gh issue list --label needs-triage` returns issues that have been through initial classification"
- **坏：** "Triage should work correctly"

### 明确的范围边界

明确哪些内容不在本次范围内，防止 agent 擅自扩展需求或实现相邻功能。

## 模板

```markdown
## Agent Brief

**Category:** bug / enhancement
**Summary:** one-line description of what needs to happen

**Current behavior:**
Describe what happens now. For bugs, this is the broken behavior.
For enhancements, this is the status quo the feature builds on.

**Desired behavior:**
Describe what should happen after the agent's work is complete.
Be specific about edge cases and error conditions.

**Key interfaces:**
- `TypeName` — what needs to change and why
- `functionName()` return type — what it currently returns vs what it should return
- Config shape — any new configuration options needed

**Acceptance criteria:**
- [ ] Specific, testable criterion 1
- [ ] Specific, testable criterion 2
- [ ] Specific, testable criterion 3

**Out of scope:**
- Thing that should NOT be changed or addressed in this issue
- Adjacent feature that might seem related but is separate
```

## 示例

### 好的 agent 实现说明（bug）

```markdown
## Agent Brief

**Category:** bug
**Summary:** Skill description truncation drops mid-word, producing broken output

**Current behavior:**
When a skill description exceeds 1024 characters, it is truncated at exactly
1024 characters regardless of word boundaries. This produces descriptions
that end mid-word (e.g. "Use when the user wants to confi").

**Desired behavior:**
Truncation should break at the last word boundary before 1024 characters
and append "..." to indicate truncation.

**Key interfaces:**
- The `SkillMetadata` type's `description` field — no type change needed,
  but the validation/processing logic that populates it needs to respect
  word boundaries
- Any function that reads SKILL.md frontmatter and extracts the description

**Acceptance criteria:**
- [ ] Descriptions under 1024 chars are unchanged
- [ ] Descriptions over 1024 chars are truncated at the last word boundary
      before 1024 chars
- [ ] Truncated descriptions end with "..."
- [ ] The total length including "..." does not exceed 1024 chars

**Out of scope:**
- Changing the 1024 char limit itself
- Multi-line description support
```

### 好的 agent 实现说明（enhancement）

```markdown
## Agent Brief

**Category:** enhancement
**Summary:** Add `.out-of-scope/` directory support for tracking rejected feature requests

**Current behavior:**
When a feature request is rejected, the issue is closed with a `wontfix` label
and a comment. There is no persistent record of the decision or reasoning.
Future similar requests require the maintainer to recall or search for the
prior discussion.

**Desired behavior:**
Rejected feature requests should be documented in `.out-of-scope/<concept>.md`
files that capture the decision, reasoning, and links to all issues that
requested the feature. When triaging new issues, these files should be
checked for matches.

**Key interfaces:**
- Markdown file format in `.out-of-scope/` — each file should have a
  `# Concept Name` heading, a `**Decision:**` line, a `**Reason:**` line,
  and a `**Prior requests:**` list with issue links
- The triage workflow should read all `.out-of-scope/*.md` files early
  and match incoming issues against them by concept similarity

**Acceptance criteria:**
- [ ] Closing a feature as wontfix creates/updates a file in `.out-of-scope/`
- [ ] The file includes the decision, reasoning, and link to the closed issue
- [ ] If a matching `.out-of-scope/` file already exists, the new issue is
      appended to its "Prior requests" list rather than creating a duplicate
- [ ] During triage, existing `.out-of-scope/` files are checked and surfaced
      when a new issue matches a prior rejection

**Out of scope:**
- Automated matching (human confirms the match)
- Reopening previously rejected features
- Bug reports (only enhancement rejections go to `.out-of-scope/`)
```

### 好的 agent 实现说明（PR）

对于 PR，"Current behavior" 描述现有 diff 的状态，实现说明要求 agent 补全或修复它，而不是从头实现。

```markdown
## Agent Brief

**Category:** enhancement
**Summary:** Finish the contributor's `--json` output flag for `triage list`

**Current behavior:**
The PR adds a `--json` flag that serializes the issue list to JSON. The happy
path works and the diff matches the project's command structure. Two gaps
remain: errors are still printed as human text (not JSON), and the new flag has
no test coverage.

**Desired behavior:**
With `--json`, all output — including errors — is well-formed JSON on stdout,
and the command's exit codes are unchanged. The existing human-readable output
is untouched when the flag is absent.

**Key interfaces:**
- The command's error path should emit `{ "error": string }` under `--json`
  instead of the plain-text error
- Reuse the existing serializer the PR already added; don't introduce a second

**Acceptance criteria:**
- [ ] `triage list --json` emits valid JSON for both success and error cases
- [ ] Exit codes match the non-JSON command
- [ ] A test covers the `--json` success output and one error case
- [ ] Default (non-JSON) output is byte-for-byte unchanged

**Out of scope:**
- Adding `--json` to any other command
- Changing the JSON shape of the success payload the PR already defined
```

### 不合格的 agent 实现说明

```markdown
## Agent Brief

**Summary:** Fix the triage bug

**What to do:**
The triage thing is broken. Look at the main file and fix it.
The function around line 150 has the issue.

**Files to change:**
- src/triage/handler.ts (line 150)
- src/types.ts (line 42)
```

这份说明不合格，因为：
- 没有 category
- 描述含糊（"the triage thing is broken"）
- 引用了会过时的文件路径和行号
- 没有验收标准
- 没有范围边界
- 没有描述当前 vs 期望的行为
