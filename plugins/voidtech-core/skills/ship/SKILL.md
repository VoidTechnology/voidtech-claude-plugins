---
name: ship
description: 审查当前改动，运行验证，提交、推送当前分支，并按 GitHub 或 GitLab 创建 PR/MR。仅在用户明确要求 review/commit/push/PR/MR/ship 时手动调用。
argument-hint: "这次要发布什么？可包含目标分支、标题或是否 draft"
disable-model-invocation: true
---

# Ship

把当前工作树整理成可审查的远端变更。调用本技能表示用户授权执行一次 `review -> commit -> push -> PR/MR` 流程；仍然要在风险不清楚时停止并说明阻塞条件。

## 硬约束

- 不使用 `git reset --hard`、`git clean`、force push、历史改写或删除分支。
- 不提交明显无关改动、临时文件、密钥、构建产物或调试输出；无法拆分时先停下说明。
- 默认不在 `main`、`master`、`develop` 或远端默认分支上直接提交。若当前就在默认分支，先创建短分支；分支名使用 `ship/<short-topic>`、`feat/<short-topic>` 或 `fix/<short-topic>`。
- 验证失败时不提交、不推送、不创建 PR/MR。只有用户明确要求带失败状态发布时，才可继续，并在 PR/MR 正文中醒目标出失败项。
- PR/MR 标题和正文必须按 `voidtech-core:text-naturalizer` 的口吻规则润色：自然、准确、克制，不使用聊天机器人开场、营销腔、机械总结或装饰性 emoji。

## 流程

### 1. 盘点仓库状态

运行：

```bash
git status --short --branch
git remote -v
git diff --stat
git diff --check
```

确认：

- 当前分支、上游分支、默认目标分支。
- 暂存区和未暂存区是否都属于本次发布。
- 是否有未跟踪文件需要纳入或忽略。
- 是否有空白错误、冲突标记或明显生成物。

若发现无关改动，先列出文件并询问用户要拆分、暂存部分文件，还是停止。不要替用户丢弃改动。

### 2. 识别平台

按 remote 判断平台：

- GitHub：使用 `gh`。
- GitLab：使用 `glab`。

执行只读检查：

```bash
gh auth status
gh repo view --json nameWithOwner,defaultBranchRef,url
```

或：

```bash
glab auth status
glab repo view
```

如果两个平台都不匹配，或者 CLI/认证不可用，停止在本地提交前；给出缺失工具、认证命令和后续手动步骤。

### 3. 审查 diff

阅读完整 diff，而不是只看文件名：

```bash
git diff --cached
git diff
```

按以下顺序审查：

1. 正确性：改动是否满足用户目标，是否漏掉必要路径。
2. 风险：公共 API、数据格式、迁移、权限、网络请求、文件系统、并发和安全边界。
3. 可维护性：是否引入重复、过早抽象、命名漂移或与项目风格冲突。
4. 测试缺口：新增行为是否有测试或可解释的验证替代。
5. 发布卫生：无密钥、无调试输出、无无关格式化、无临时文件。

发现阻塞问题时，先修复并重新验证；无法修复时停止并报告。非阻塞风险写入 PR/MR 正文。

### 4. 运行验证

优先使用项目现有质量门。常见入口：

```bash
scripts/check-portability.sh
npm test
npm run lint
npm run typecheck
swift test
xcodebuild test
```

只运行当前仓库实际存在且相关的命令；不要凭空安装依赖。记录每条命令的结果。没有可运行验证时，说明查过哪些文件以及为什么无法运行。

### 5. 暂存与提交

提交前再次检查：

```bash
git status --short
git diff --staged --stat
git diff --staged
```

提交规则：

- 只暂存本次发布相关文件。
- commit message 遵循项目约定；没有约定时使用简短中文 Conventional Commit，例如 `feat: 增加发布技能`。
- 一次发布默认一个提交；如果 diff 明显包含多个独立逻辑改动，先建议拆成多个提交。

执行：

```bash
git add <files>
git commit -m "<message>"
```

### 6. 推送分支

推送前确认当前分支不是默认分支，并且不需要 force push：

```bash
git branch --show-current
git status --short --branch
git push -u origin HEAD
```

如果远端拒绝普通 push，停止并说明原因；不要改用 force push。

### 7. 起草并润色 PR/MR

先根据 diff、提交和验证结果写草稿：

```markdown
## Summary

- ...

## Verification

- ...

## Risks

- ...
```

然后按 `voidtech-core:text-naturalizer` 的规则润色标题和正文。若 Skill 工具可用，调用 `voidtech-core:text-naturalizer` 处理草稿；若不可用，读取 `${CLAUDE_PLUGIN_ROOT}/skills/text-naturalizer/SKILL.md`，按其中规则自审并改写。要求：

- 标题具体，避免 “update/fix things/misc”。
- Summary 写事实，不写宣传。
- Verification 逐条列出实际运行的命令；失败或未运行必须说明。
- Risks 只写真实残余风险；没有就写 “无已知风险”。

把润色后的正文写入操作系统临时目录：

```bash
body_file="${TMPDIR:-/tmp}/voidtech-pr-body-$(date +%s).md"
```

### 8. 创建 PR 或 MR

GitHub 使用正文文件，避免 shell 展开破坏格式：

```bash
gh pr create --base <base-branch> --head <current-branch> --title "<title>" --body-file "$body_file"
```

GitLab 的 `glab mr create` 没有稳定的正文文件参数；先把正文写入临时文件，再从文件读取到变量传入：

```bash
description=$(cat "$body_file")
glab mr create --target-branch <base-branch> --source-branch <current-branch> --title "<title>" --description "$description"
```

用户要求 draft 时加 `--draft`。创建成功后返回 PR/MR URL。

## 完成输出

最后返回：

- 创建的 PR/MR URL。
- commit hash 和分支名。
- 运行过的验证命令及结果。
- 已知风险或未完成事项。
- 若中途停止，给出唯一阻塞条件和可执行下一步。
