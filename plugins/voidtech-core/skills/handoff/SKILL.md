---
name: handoff
description: 把当前任务整理成一份交接文档，供另一个 agent 继续工作。
argument-hint: "下一个会话将用于做什么？"
disable-model-invocation: true
---
> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

撰写一份交接文档，概括当前对话，使一个全新的 agent 能够继续这项工作。保存到用户操作系统的临时目录——而不是当前工作区。临时目录优先使用 `$TMPDIR`，其次使用 `$TEMP`，POSIX 系统最后回退到 `/tmp`；文件命名为 `voidtech-handoff-<timestamp>.md`。完成后返回绝对路径。

在文档中包含“建议技能”章节，只列出当前会话确实可发现的技能，并使用完整标识符。没有合适技能时写“无”，不得沿用上游仓库中的技能名或猜测不存在的命令。

不要重复已被其他产物（PRD、计划、ADR、issue、commit、diff）记录的内容。改用路径或 URL 引用它们。

隐去任何敏感信息，例如 API key、密码或可识别个人身份的信息。

如果用户传入了参数，把它当作对下一个会话将聚焦内容的描述，并据此调整文档。

写完后重新读取文件，确认它包含：当前目标、已完成工作、未完成工作、关键决策、验证状态、风险、下一步和 suggested skills。任何一项缺失都要在返回路径前补齐。
