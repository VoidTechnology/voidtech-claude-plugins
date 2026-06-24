# MISSION.md 格式

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 已汉化并完成 VoidTech 插件内自包含适配。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

`MISSION.md` 位于工作区根目录，记录用户学习当前主题的原因。接下来教什么、推荐哪些资料和设计哪些练习，都应以这份文档为依据。

## 模板

```md
# Mission: {Topic}

## Why
{1-3 sentences. The concrete real-world goal the user is chasing. What changes in their life or work when they have this skill? Avoid abstract framings like "to understand X" — push for the underlying outcome.}

## Success looks like
- {A specific, observable thing the user will be able to do}
- {Another specific thing}
- {…}

## Constraints
- {Time, budget, prior commitments, learning preferences, anything that bounds the approach}

## Out of scope
- {Adjacent topics the user explicitly does not want to chase right now — protects the zone of proximal development}
```

## 规则

- **一个工作区只记录一个学习目标。** 两个不相关的主题应使用两个工作区。
- **具体胜于抽象。** 「十月前跑完半程马拉松」胜过「变得更健康」。「给团队交付一个 Rust CLI」胜过「学 Rust」。
- **先明确含糊的目标。** 如果用户说不清“为什么”，先通过提问确认实际目的，再写文件。错误的学习目标会误导后续课程。
- **目标变化时及时修订。** 用户目标发生变化时更新这个文件，避免后续会话继续依据过时信息。
- **保持简短。** `MISSION.md` 应能在一屏内读完；更详细的安排应放入课程计划。
