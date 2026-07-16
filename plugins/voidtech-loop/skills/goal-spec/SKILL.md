---
name: goal-spec
description: 把复杂任务编译成 voidtech-loop 可执行的不可变 Goal Spec。探查仓库已有测试/构建命令，将每项要求归入 target/invariant/manual_review/out_of_scope，产出经 schema 校验和基线 dry-run 的草稿与启动命令；单一简单目标则降级为一行 --check。仅在用户要用循环推进一个多目标或含守护条件的复杂任务、需要先把要求编译成规格时手动调用。
argument-hint: "\"<复杂任务描述，可含多个目标、需保持通过的测试、需保护的资产>\""
disable-model-invocation: true
---

# goal-spec — 复杂任务到 Goal Spec 的编译器

把语言描述的复杂任务编译成一份**可被控制器执行、经过校验和基线验证**的 Goal Spec。这是编译器，不是通用 YAML 编辑器：只负责编译并验证草稿是否满足启动条件，绝不启动循环、不改业务代码、不实现第二套校验逻辑、不把不可机器判定的产品要求伪装成 eval。

## 执行流程（PRD 4.1）

1. **探查仓库**：用 Read/Grep/Glob 找出已有的测试、构建、CI 与项目规则命令，不发明不存在的命令。找不到对应命令时标记缺口并问用户，不要编造。
2. **归档每项要求**为四类之一：
   - `target`——本轮必须达成的、可机器判定的变化（绝对退出码；一期不支持相对基线比较器）；
   - `invariant`——不得退化、且在 base commit 上已成立的守护条件；
   - `manual_review`——只能人工确认的产品/设计要求，进报告不进 eval；
   - `out_of_scope`——明确不做的（含相对基线指标，一期归此并提示二期）。
3. **复杂度闸门**：单 target、默认能力、可用一条安全命令表达的任务**不生成 YAML**，直接返回一行 `--check` 启动命令，引导用户用 `/voidtech-loop:goal`。
4. **复杂任务**补齐 protected paths、预算、cwd、环境；需要网络/外部服务/自定义 worker 能力时拒绝并说明不属于一期。草稿默认写入 `.voidtech-loop/specs/<slug>.yaml`。
5. **校验（唯一入口，禁止另写规则）**：

   ```bash
   ${CLAUDE_PLUGIN_ROOT}/scripts/goal-spec validate .voidtech-loop/specs/<slug>.yaml --json
   ```

6. **基线 dry-run**：

   ```bash
   ${CLAUDE_PLUGIN_ROOT}/scripts/goal-spec baseline .voidtech-loop/specs/<slug>.yaml --json
   ```

   spec 含 `shell: true` 的 eval 或 `setup` 命令时，该命令会完整展示将执行的 shell 命令并以退出码 2 停止。把命令清单转达给用户；只有得到明确同意后，才可追加 `--allow-shell` 重新执行。`baseline` 与正式启动共用同一确认门，不得替用户默认确认。

   裁定规则：全部 target 已满足 → 报告“目标在基线已满足”，不交付可启动结论；任一 invariant 基线不成立 → 要求改角色或先修基线；命令超时/需未声明网络/未声明副作用 → 停止，不交付“可启动”。只有“至少一个 target 未满足且全部 invariant 成立”才可启动。
7. **输出**：目标/不变量摘要、基线结果、固定 best-effort 能力、manual review 清单，以及准确的启动命令：

   ```text
   ${CLAUDE_PLUGIN_ROOT}/scripts/loop goal --spec .voidtech-loop/specs/<slug>.yaml
   ```

   若已为同一冻结 spec 明确确认过 shell 命令，启动命令追加 `--allow-shell`；否则保留确认门。绝不自动启动循环、绝不修改业务代码。

## 参考

字段规则与角色语义见 `references/authoring-rules.md`；它与 `schemas/goal-spec.schema.json` 同源，任何调用方不得复制字段清单或另写宽松校验。
