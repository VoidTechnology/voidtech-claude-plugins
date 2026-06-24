---
name: handoff
description: 将当前对话压缩成一份交接文档，供另一个 agent 接手。
argument-hint: "下一个会话将用于做什么？"
disable-model-invocation: true
---
> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

撰写一份交接文档，概括当前对话，使一个全新的 agent 能够继续这项工作。保存到用户操作系统的临时目录——而不是当前工作区。

在文档中包含一个 "suggested skills" 章节，列出该 agent 应当调用的 skills。

不要重复已被其他产物（PRD、计划、ADR、issue、commit、diff）记录的内容。改用路径或 URL 引用它们。

隐去任何敏感信息，例如 API key、密码或可识别个人身份的信息。

如果用户传入了参数，把它当作对下一个会话将聚焦内容的描述，并据此调整文档。
