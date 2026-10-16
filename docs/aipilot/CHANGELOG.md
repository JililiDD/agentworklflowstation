# Changelog

- 2026-10-13T16:12:15 新建产品规格第 1 版：开源、与领域无关的多模型 agent 工作流平台。product-spec.md
- 2026-10-15T17:50:22 完成 Phase 1 单节点运行时：验证 pi 能力，支持 agent、交互继续、命令与重试。2026-10-14-0947-phase-1-single-node-runtime.md
- 2026-10-15T18:51:40 完成 Phase 2 调度核心：实现工作流模型、加载时校验、依赖与条件调度、审批重跑、组循环和 foreach 嵌套。2026-10-15-1811-phase-2-scheduling-core.md
- 2026-10-15T19:56:25 完成 Phase 3 持久化、工作区与真实运行：支持独立 git worktree、只读撤销、检查点 diff、原子运行快照、预算控制及崩溃断点续跑。2026-10-15-1917-phase-3-durable-workspace.md
- 2026-10-15T22:15:14 完成 Phase 4 本地服务：提供工作流库、设置与运行接口，支持 pi SDK 登录与共享凭证、实时事件和架构依赖测试。2026-10-15-2031-phase-4-local-service.md
- 2026-10-16T08:15:00 完成 Phase 5 运行视图：建立 React/Vite 前端、同源静态交付、四区导航、只读嵌套画布与轮次/项切换、安全预览、脱敏问答与审批 Inbox、Stop/Resume 及 Playwright E2E 浏览器验收。2026-10-15-2220-phase-5-run-view.md
- 2026-10-16T10:30:00 完成 Phase 6 工作流编辑器：基于 @xyflow/react 实现节点库、卡片、嵌套 Group/Foreach、同层连线、复制粘贴、属性抽屉、${...} 真实引用补全、校验错误定位、旧 YAML 注释与字段保护、独立 sidecar 布局持久化，打通保存与启动。2026-10-16-0823-phase-6-workflow-editor.md
