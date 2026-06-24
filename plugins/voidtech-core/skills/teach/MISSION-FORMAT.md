# MISSION.md 格式

> Vendored from [mattpocock/skills](https://github.com/mattpocock/skills) · MIT © 2026 Matt Pocock · upstream 6eeb81b · 汉化:仅译用户可见文案,逻辑/结构未改。LICENSE 见 ../_vendor-licenses/mattpocock-LICENSE

`MISSION.md` 位于工作区根目录。它记录用户学习此主题的 _原因_。每一个教学决策——接下来教什么、推送哪些资源、设计哪些练习——都应能追溯到这份文档。

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

- **一个工作区一个 mission。** 如果用户想学两件不相关的事，那就是两个工作区。
- **具体胜于抽象。** 「十月前跑完半程马拉松」胜过「变得更健康」。「给团队交付一个 Rust CLI」胜过「学 Rust」。
- **对含糊不清要回推。** 如果用户说不清「为什么」，先访谈他们，再动笔写任何东西。一个糟糕的 mission 比没有 mission 更糟。
- **现实变化时及时修订。** mission 会变。当用户的目标移动时，更新这个文件——别留下一个过时的 mission 去引导未来的会话。
- **保持简短。** 如果 `MISSION.md` 超过一屏，它就不再是指南针，而变成了一份计划。
