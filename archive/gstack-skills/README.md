# gstack 技能归档

本目录保存从 [garrytan/gstack](https://github.com/garrytan/gstack) 引入但尚未完成可移植性改造的技能，不属于任何已发布插件，也不会被 Claude Code 自动发现。

- 本仓库引入提交：`7d4061f`
- 上游许可证：MIT，见 [LICENSE](LICENSE)
- 归档原因：依赖未随技能分发的 `~/.gstack` 状态、`gstack/bin`、遥测流程和其他已删除技能

重新发布单个技能前必须满足：

1. 不依赖插件目录之外的 gstack 文件或状态。
2. 不包含遥测、自动升级或远程安装器。
3. 所有跨技能引用都指向当前 Marketplace 实际发布的技能。
4. 会提交、推送、合并或部署的技能仅允许用户显式调用。
5. `SKILL.md` 控制在 500 行以内，扩展材料拆到同目录参考文件。
6. 记录上游 commit、改动范围和许可证。
