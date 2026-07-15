# 技术设计：voidtech-loop 一期（PRD §8 十二项定案）

- **日期**：2026-07-15
- **状态**：Final（实现中发现偏差必须回写本文档变更记录，不得静默偏离）
- **摘要**：对 `docs/prd-voidtech-loop-2026-07-15.md` §8 列出的十二个技术定案问题逐项给出结论。事实依据来自两轮 spike 实测（`docs/spike-worker-invocation-2026-07-15.md`）与 architect 工程评审。核心选型：Node 脚本控制器（零 npm 依赖）+ detach 守护进程 + 非 bare `claude -p` worker + 临时 index checkpoint + Git 审计集快照。

## 0. 决策总表

| § | 问题 | 结论 | 依据 |
|---|------|------|------|
| 8.1 | worker invocation | 非 bare `claude -p`，每轮全新会话 | spike 第一、二轮实测 |
| 8.2 | 版本下限 | Claude Code ≥2.1.210、macOS ≥14 (arm64)、Git ≥2.39、Node ≥18 | spike 实测版本 + API 需求 |
| 8.3 | worker 权限 | 固定六工具白名单 + PreToolUse 拦截 | 见 §3 |
| 8.4 | 命令协议 | 引号感知 tokenizer + 固定 env 白名单 + eval 断开全局 git 配置 | 见 §4 |
| 8.5 | eval 规范化 | 三个已知框架提取器 + 通用退化摘要 | 见 §5 |
| 8.6 | checkpoint 与审计 | 临时 index 五步构建 + CAS update-ref + 审计集快照 | architect 评审 |
| 8.7 | 原子状态与锁 | tmp+fsync+rename、mkdir 锁、tombstone 接管 | architect 评审 |
| 8.8 | token 统计 | `--output-format json` 逐轮记录，缺失记 `unavailable` | spike 实测有 `total_cost_usd` |
| 8.9 | 作者文件 | specs 建议随仓库提交，不建议 gitignore | 见 §9 |
| 8.10 | 语言与分发 | Node 脚本（零 npm 依赖），不用 Agent SDK | 见 §10 |
| 8.11 | 宿主模型 | detach 守护进程 | spike 第二轮实测 |
| 8.12 | 验收依赖 | 每 run 一次 warm 安装 + APFS clonefile 逐轮克隆 | architect 评审推荐 |

## 1. worker invocation（§8.1，已定案）

- 每轮：`claude -p "<注入 prompt>" --allowedTools <白名单> --max-turns <N> < /dev/null`，cwd 固定为循环 worktree，`--output-format json` 取结构化结果。
- 不使用 `--bare`（官方已预告其将成为 `-p` 默认值，实现必须显式传当前语义所需参数并在启动体检锁死版本下限）。
- 每轮全新会话；`--resume` 已实测可用，记为二期优化。
- 终止 worker 一律 SIGTERM（退出码 143 可判定；SIGINT 退出码为 0，与正常完成不可区分，禁止使用）。
- 测试接缝：控制器从配置读取 worker 命令模板（默认 `claude -p ...`），集成测试注入 stub 可执行文件（V23）。

## 2. 版本与试点环境（§8.2）

| 依赖 | 下限 | 检测方式 |
|------|------|----------|
| Claude Code | 2.1.210（spike 实测版本） | `claude --version` |
| macOS | 14，仅 arm64 | `sw_vers -productVersion` + `uname -m` == `arm64` |
| Git | 2.39（Apple CLT 基线；不使用 ≥2.45 的 `--include-root-refs`） | `git --version` |
| Node | 18（控制器运行时；仅用 `node:` 内置模块） | `node --version` |
| jq | 任意近代版本（仅 hook 脚本使用，沿用仓库惯例） | `jq --version` |

## 3. 固定 best-effort 权限（§8.3）

- worker `--allowedTools`：`Read`、`Grep`、`Glob`、`Edit`、`Write`、`Bash`。`Agent`、`WebSearch`、`WebFetch` 与全部 MCP 工具不进入白名单（headless 默认拒绝已实测）。
- PreToolUse 规则（bash + jq，沿用 `voidtech-core` 的 `block-dangerous-git.sh` 模式）：
  - Bash：命中 Git 写子命令（`add`、`commit`、`push`、`merge`、`rebase`、`reset`、`branch`、`checkout`、`switch`、`update-ref`、`worktree`、`config` 等）即 exit 2 拒绝；
  - Edit/Write：目标路径 realpath 必须在循环 worktree 内，且不命中冻结 spec 路径与 protected paths；
  - 拦截器带版本号，写入报告。
- 报告标准免责声明（固定文案）：Bash 可执行任意脚本，文件与网络副作用无法由一期完全阻断；本表仅声明工具面拦截，最终边界由 4.2 后置校验兜底。

## 4. 命令协议（§8.4）

- `--check` 解析：引号感知 tokenizer（单/双引号成组），遇到 `| & ; < > $( ) \`` 反引号、换行即拒绝并引导 Goal Spec 显式 `shell: true`。
- **eval** 子进程环境从固定白名单构造：`PATH`、`HOME`、`LANG`、`LC_ALL`、`TMPDIR`，外加 `TERM=dumb`；其余一律不继承（eval 跑待验证的不可信代码）。
- **worker** 子进程继承父进程完整环境（`claude -p` 需 keychain/OAuth 认证），仅剥离控制器为 git 操作设的 `GIT_CONFIG_*` 覆盖。凭据清理只作用于 eval，不作用于 worker——2026-07-16 首次真实 worker dogfood 发现白名单套在 worker 上会导致 `Not logged in`，据此修正（原设计误将白名单同时套用两者）。
- eval 进程额外设 `GIT_CONFIG_GLOBAL=/dev/null` 与 `GIT_CONFIG_NOSYSTEM=1`，切断 osxkeychain credential helper 路径。副作用（测试依赖用户 gitconfig）会在启动体检的基线 eval 中显式失败，不会静默。
- submodule：启动体检检测到活跃 submodule 即拒绝（一期声明不支持）；LFS：仓库启用 LFS 且本机未安装 `git-lfs` 即拒绝。
- monorepo：eval `cwd` 相对仓库根解析，realpath 必须落在验收 worktree 内。

## 5. 规范化 eval 结果（§8.5）

- 已知框架提取器（按命令名与输出特征匹配）：jest/vitest（失败测试全名列表 + 计数）、pytest（`FAILED` 节点 ID）、tsc（`error TS\d+` 计数与前 20 条位置）。
- 未知命令退化为：退出码 + 时长 + 尾部摘要（剥离 ANSI、ISO 时间戳、`/tmp`/`$TMPDIR` 路径后取尾部 32 KiB 内）。
- 提取器只做正则级解析，不执行任何来自输出的内容。

## 6. checkpoint 与 Git 审计实现（§8.6）

- 加固 git 包装（控制器所有调用统一走它）：`git -c core.fsmonitor= -c core.hooksPath=/var/empty -c commit.gpgsign=false -c tag.gpgsign=false`。
- checkpoint 五步（全程 `GIT_INDEX_FILE=<临时 index>`，绝不信任 worker 留下的 index）：`read-tree <last>` → `add -A` → `write-tree` → `commit-tree -p <last>` → `update-ref refs/heads/loop/<slug>-<id> <new> <expected-old>`（带旧值的 CAS，天然检出并发篡改）。
- 审计集快照 = `git for-each-ref --format='%(refname) %(objectname)'` 排序输出 + 以下文件的 SHA-256：`.git/config`、`.git/info/attributes`、`.git/info/exclude`、hooks 目录每个文件、每个已知 worktree 的 `.git` 指针文件；HEAD 单独用 `symbolic-ref -q HEAD` + `rev-parse --verify HEAD` 两元组。pseudo-refs（`FETCH_HEAD`/`ORIG_HEAD`）排除；`refs/remotes/*` 纯前进只记录。
- protected paths：变更路径集（`diff --name-only` + `ls-files -o`）用冻结 pattern 文件按 gitignore 语义过滤（`ls-files --ignored --exclude-from` 组合）；validator 拒绝 `!` 否定模式。

## 7. 原子状态与陈旧锁（§8.7）

- 状态文件：JSON + 顶层 `checksum`（正文 SHA-256）；写入 = 同目录临时文件 → `fsync(fd)` → `rename` → `fsync(目录 fd)`。一期以 fsync(2) 原子性为准，不追求 `F_FULLFSYNC` 掉电持久性；损坏由 checksum 检出并 fail closed。
- 项目锁：`mkdir lock/`（APFS 原子）；元数据 `lock/meta.json`（run ID、PID、`ps -o lstart=` 原串、`ps -o comm=`）以 tmp+rename 写入；读者遇到空锁目录按“创建中”等待 2 秒宽限期。
- 判活：同 PID 重取 `lstart` 与 `comm` 做精确比较，双因子皆同才算活。
- 陈旧接管：接管者先把锁目录原子 `rename` 为 `lock.tombstone.<自身 run ID>`（仅一个进程能赢），赢家依据最后状态与 Git 事实生成 `STOPPED(interrupted)` 报告后清理；输家按锁被持有处理。

## 8. token 统计（§8.8）

spike 已实测 `--output-format json` 返回 `total_cost_usd`、`duration_ms`、`session_id`。逐轮记录 cost 与 usage 字段（若存在）进状态与报告；任一字段缺失记 `unavailable`，不估算。空仓库试验轮实测 $0.05–0.51/轮，作为资源画像的第一个数据点。

## 9. Goal Spec 作者文件（§8.9）

- `.voidtech-loop/specs/` **建议随仓库提交**（spec 是可评审资产，等价于测试代码），不给默认 gitignore；`goal-spec` 产出草稿时提示这一建议。
- spec 允许保存的元数据：标题、日期、作者、任务描述；secret 只允许引用环境变量名（validator 拒绝形如 token 的字面量，规则：命中常见凭据模式即拒）。
- 活动 run 只信任插件状态区冻结副本（PRD 3.1 已定）。

## 10. 实现语言与分发（§8.10）

- **Node 脚本，零 npm 依赖**（只用 `node:fs`/`node:child_process`/`node:crypto` 等内置模块）。理由：fsync 与二进制安全流式截断排除 shell+jq；`claude -p` 链路已端到端实测，Agent SDK 会引入一个一期用不到其差异化能力的浮动依赖，违背自包含原则（ADR-0001）。
- 分发：插件自带 `.mjs` 脚本，无 install 步骤；hooks 沿用 bash+jq。
- CI：`portability.yml` 增加 `macos-15`（arm64）job，`paths` 过滤 `plugins/voidtech-loop/**`，控制 10 倍计费面。

## 11. 宿主与生命周期（§8.11，已定案）

- `goal` 完成启动体检后以 `spawn(detached: true, stdio: 'ignore')` + `unref()` 派生控制器并立即返回，打印 run ID、报告路径与 `status`/`cancel` 提示。
- 控制器每次状态迁移写心跳时间戳；`status` 只读状态文件；`cancel` 验证 PID 存活（§7 双因子）后发 SIGTERM。
- 已实测：launchd 收养（ppid=1）、无 TTY 下 `claude -p` 与凭据可用；SIGTERM 陷阱可干净收尾。

## 12. 验收 worktree 依赖策略（§8.12）

- run 启动时创建一个 deps 模板 worktree，执行一次 warm 安装；此步允许网络并写入报告能力声明（时机、命令、耗时）。
- 安装命令来源：优先 Goal Spec 可选字段 `setup`（argv 数组，进入哈希）；缺省按锁文件自动检测（`package-lock.json` → `npm ci`、`pnpm-lock.yaml` → `pnpm install --frozen-lockfile`、`yarn.lock` → `yarn install --immutable`）；两者皆无则跳过并在报告标注。
- 循环 worktree 与每轮一次性验收 worktree 创建后，用 APFS clonefile（`cp -c`）从模板克隆依赖目录（`node_modules` 等检测到的产物目录），近零成本。
- 基线 eval 与 `goal-spec` dry-run 同样在隔离 worktree + 克隆依赖中执行，不落在用户工作区。
- **注**：`setup` 是本设计在 PRD schema 示例之外新增的唯一可选字段，由 F3 schema 定义并进入 `goal_hash`。

## 变更记录

- 2026-07-15：初稿即定稿（Final）——十二项全部定案；`setup` 字段为相对 PRD 的唯一 schema 增项。
