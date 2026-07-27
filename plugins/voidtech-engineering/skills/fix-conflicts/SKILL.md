---
name: fix-conflicts
description: 解决正在进行的 Git merge 或 rebase 冲突，保留双方意图并完成项目验证。
---
> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

1. **查看 merge 或 rebase 的当前状态。** 检查 Git 历史和发生冲突的文件。

2. **找到每个冲突的来源。** 理解两侧改动的原因和原始意图。优先阅读提交信息；如果可以访问相关 PR、issue 或工单，再补充阅读。无法访问远端时继续处理，但要记录缺少了哪些背景信息。

3. **逐个冲突块解决。** 尽可能保留双方意图。两者不兼容时，选择与本次合并目标一致的一方，并记录取舍。不要引入双方都没有要求的新行为。除非发现继续操作会造成数据丢失，否则不要中止流程。

4. 找出并运行项目的**自动化检查**，通常依次执行类型检查、测试和格式检查。修复合并导致的问题。

5. **完成 merge 或 rebase。** 只有用户明确授权提交时，才暂存改动并继续当前 Git 流程；否则停在冲突已解决且检查已通过的状态，并给出后续命令。
