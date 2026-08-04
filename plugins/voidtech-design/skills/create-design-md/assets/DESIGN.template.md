---
version: alpha
name: product-design-system
description: "可替换的产品设计系统基线。实际使用时必须以目标项目事实重写名称、范围、视觉方向、token、组件和正文。"

colors:
  primary: "#1A3A5C"
  primary-hover: "#0C2D4E"
  on-primary: "#FFFFFF"
  canvas: "#F7F8FA"
  surface: "#FFFFFF"
  ink: "#17202A"
  ink-secondary: "#475467"
  border-strong: "#8590A3"
  focus: "#0E5FA5"
  success: "#067647"
  success-subtle: "#ECFDF3"
  danger: "#B42318"
  danger-subtle: "#FEF3F2"

typography:
  page-title:
    fontFamily: "system-ui, sans-serif"
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: 0
  section-title:
    fontFamily: "system-ui, sans-serif"
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.30
    letterSpacing: 0
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.60
    letterSpacing: 0
  button:
    fontFamily: "system-ui, sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.40
    letterSpacing: 0

rounded:
  none: 0px
  sm: 4px
  md: 8px
  lg: 12px

spacing:
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  section: 64px

components:
  page:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: 24px
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: 24px
  page-heading:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.page-title}"
    rounded: "{rounded.none}"
    padding: 8px
  section-heading:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.section-title}"
    rounded: "{rounded.none}"
    padding: 8px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 12px
    height: 48px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 12px
    height: 48px
  supporting-text:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: 8px
  divider-strong:
    backgroundColor: "{colors.border-strong}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    height: 1px
  focus-ring:
    backgroundColor: "{colors.focus}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    size: 3px
  status-success:
    backgroundColor: "{colors.success-subtle}"
    textColor: "{colors.success}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: 8px
  status-danger:
    backgroundColor: "{colors.danger-subtle}"
    textColor: "{colors.danger}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: 8px
---

# 产品设计系统

## Overview

说明产品定位、目标用户、核心任务、适用端、明确不做范围、事实来源、设计原则、视觉方向和候选决策。

## Colors

解释品牌层、中性层、语义层和焦点层的职责、允许组合、换肤算法、对比度与图片处理规则。

## Typography

解释字体来源、层级、长内容、数字与编号、双语或多语言增长规则。

## Layout

定义容器、网格、断点、页面骨架、触控目标、安全区和响应式降级。

## Elevation & Depth

定义背景分区、边线、阴影、遮罩、层叠顺序及明暗主题差异。

## Shapes

定义圆角、边线、图标、图片裁切和具有产品语境的有限装饰形态。

## Components

逐类定义站点框架、按钮、表单、导航、数据展示、反馈、覆盖层、动效和无障碍状态，并与 YAML 组件键保持一致。

## Do's and Don'ts

列出能直接审查的正反规则、页面与状态覆盖清单，以及落地前的验证门槛。
