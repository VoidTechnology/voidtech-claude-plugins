#!/usr/bin/env bash
# Tier 0 · zh-locale
# SessionStart 钩子：每个会话只注入一次团队语言约定，避免逐轮重复占用上下文。
# 这是模型偏好而非安全边界；带硬编码英文模板的技能仍需单独本地化。
printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"【VoidTech locale】团队默认使用简体中文交流；代码、标识符、命令、文件路径与提交信息使用 English；技术文档正文使用中文、代码块使用 English；修改已有文件时遵循文件既有语言，避免中英文混杂。"}}'
