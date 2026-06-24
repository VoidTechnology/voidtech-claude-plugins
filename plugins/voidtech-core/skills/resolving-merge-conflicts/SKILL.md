---
name: resolving-merge-conflicts
description: "当你需要解决一个正在进行中的 git merge/rebase 冲突时使用。"
---
> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

1. **查看 merge/rebase 的当前状态**。检查 git history，以及发生冲突的文件。

2. **找到每个冲突的原始来源**。深入理解每处改动为何做出，以及最初的意图是什么。阅读 commit messages，查看 PR，查看原始的 issue/ticket。

3. **逐个 hunk 解决冲突。**尽可能保留双方的意图。当两者不兼容时，选择与本次 merge 既定目标相符的一方，并记下其中的取舍。**不要**臆造新的行为。始终完成解决；绝不 `--abort`。

4. 找出项目的**自动化检查**并运行——通常是 typecheck，然后 tests，再然后 format。修复任何被 merge 破坏的内容。

5. **完成 merge/rebase。**暂存全部改动并 commit。如果在 rebase，继续 rebase 流程直到所有 commit 都完成 rebase。
