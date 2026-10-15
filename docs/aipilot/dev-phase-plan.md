# Development Phase Roadmap

## Source Documents

- product-spec.md Version 1, 2026-10-13
- design-spec.md Version 1, 2026-10-13
- memory/decisions.md：技术选择和测试策略
- 参考输入（只读）：`docs/多模型 Agent 工作流引擎 · Handoff.md`。它的阶段表早于范围变化，本路线图取代它。

## Phases

### Phase 1: 单节点运行时  [merged]

- Goal: 验证 pi 的关键能力，让 runner 层能独立运行单个 agent 节点和单个命令节点。
- Verifiable outcome: 开发脚本用指定的模型、thinking level 和 skill 运行一个 agent 节点，并写出 task.md、events.jsonl 和产物。节点能在终端中途提问，并收到回答。命令节点写出日志和退出码。Claude 订阅和 ChatGPT 订阅的模型各跑通一次。
- Depends on: none
- Enables: 第 2 阶段按验证过的能力定下 StepRunner 接口，包括提问、产物修正和事件。第 3 阶段接入这个 runner。
- Work-item: 2026-10-14-0947-phase-1-single-node-runtime.md

### Phase 2: 调度核心  [merged]

- Goal: 实现工作流模型、加载时校验和调度器，覆盖产品规格中的全部控制结构。
- Verifiable outcome: FakeRunner 测试覆盖这些行为：依赖、条件和跳过传播、审批和拒绝、组节点循环、顺序 foreach、任意嵌套、写入互斥、节点失败和中止。开发脚本对一个示例工作流输出每个节点的状态变化。
- Depends on: Phase 1
- Enables: 第 3 阶段在验证过的状态模型上实现持久化和续跑。第 6 阶段复用校验逻辑。
- Work-item: 2026-10-15-1811-phase-2-scheduling-core.md

### Phase 3: 持久化、工作区与真实运行  [merged]

- Goal: 让运行在独立的 git worktree 上执行，状态写到磁盘，并支持中止、续跑和崩溃恢复。
- Verifiable outcome: 开发脚本用真实模型，在一个示例 git 仓库上运行多节点工作流。运行中途杀掉进程，续跑后已成功的节点不重跑。只读节点的改动被撤销。可写节点生成检查点和 diff。费用超出预算时，运行停止。
- Depends on: Phase 2
- Enables: 第 4 阶段的服务有可靠的运行可以启动和控制。
- Work-item: 2026-10-15-1917-phase-3-durable-workspace.md

### Phase 4: 本地服务  [planned]

- Goal: 用 CLI 启动本地服务，并通过接口管理工作流库、设置和运行。
- Verifiable outcome: 接口测试覆盖这些操作：读取工作流库、保存设置、启动运行、接收实时事件、回答问题、批准、拒绝、中止和续跑。服务只接受本机访问。凭证不出现在日志和事件中。
- Depends on: Phase 3
- Enables: 第 5 阶段的界面只需要调用验证过的接口。
- Work-item:

### Phase 5: 运行视图  [planned]

- Goal: 在浏览器界面中启动、查看和操作运行。
- Verifiable outcome: 在设置页配置 skill 来源和凭证。选择工作流库中手写的 YAML 和目标仓库，启动运行。界面实时显示节点状态，能在抽屉中回答问题、批准和拒绝，Inbox 显示等待项，运行可以中止和续跑。Playwright 测试覆盖这些流程。
- Depends on: Phase 4
- Enables: 第 6 阶段复用画布渲染、嵌套框、抽屉和界面框架。
- Work-item:

### Phase 6: 工作流编辑器  [planned]

- Goal: 在画布上搭建、校验和保存工作流，不再手写 YAML。
- Verifiable outcome: 在编辑器中搭出一个含嵌套组节点和 foreach 的工作流。看到校验错误并修正。保存后，能在运行视图中启动它。Playwright 测试覆盖创建、连接、嵌套、校验和保存。
- Depends on: Phase 5
- Enables: 第 7 阶段用编辑器搭建验收工作流。
- Work-item:

### Phase 7: 示例工作流验收  [planned]

- Goal: 只用平台能力，搭建并跑通 aipilot 和小说两个示例工作流。
- Verifiable outcome: 两个示例工作流在真实仓库上从头跑到尾。运行摘要记录耗时、费用和人工介入次数。工作流库为空时，空状态中能打开这两个示例。
- Depends on: Phase 6
- Enables: 无。这是最后一个阶段。
- Work-item:

## Testing Strategy

- 自动化测试不调用真实模型。引擎、runner 和服务的测试都用 FakeRunner，结果确定，也不花钱。
- git 工作区的测试在临时创建的 git 仓库上运行。
- 界面的核心流程用 Playwright 做自动化测试。Playwright 测试使用 FakeRunner 驱动的运行。核心流程包括：
  - 编辑器：创建、连接、嵌套、校验和保存；
  - 运行视图：查看状态、审批、拒绝、回答问题、中止和续跑。
- 真实模型只在每个阶段的手动验收中运行。验收运行不设费用上限。
- 验收使用 Claude 订阅和 ChatGPT 订阅。没有 Anthropic API key。Google 暂不使用。
- 真实模型的运行优先使用各家便宜的模型。
- 测试分为两档：
  - 快速档：单元测试、lint 和类型检查。
  - 完整档：构建改动涉及的每个包，并运行这些包的全部测试。
- 第 1 阶段搭好项目脚手架后，确定这两档的具体命令，记入 `memory/decisions.md`。

## Review Strategy

- **runner 和节点运行时：** 凭证不能进入日志、事件或产物。事件要完整，token 和费用要能累计。所有 pi 调用都只出现在 runner 层。
- **调度核心：** 每一种状态转换都有测试。测试要能在规则改变时失败，不能只是把代码跑一遍。嵌套的组合要覆盖到。
- **持久化和工作区：** 写入顺序是先提交 git 检查点，再原子写入状态文件。续跑以 git 为准。被 git 忽略的文件不算改动。
- **本地服务：** 只接受本机访问。接口输入要在边界处校验。
- **界面：** 对照 design-spec.md 的 D-n 检查，亮色和暗色两套主题都要检查，还要检查键盘焦点和对比度。
- **全部阶段：** 引擎和节点执行的代码不出现任何具体工作流或领域的逻辑（AC-88）。

## Risks and Fallbacks

| 风险 | 应对或退路 |
| --- | --- |
| pi 的关键能力尚未验证：按会话设置模型和 thinking、关闭自动发现、注册提问工具、事件中的用量、同一会话内修正产物 | 第 1 阶段先做验证。退路沿用 handoff：用子进程调用 pi CLI；结构化结果改为写文件加 schema 校验；用量由 runner 自己累计。 |
| Claude 订阅经 pi 使用时，从 extra usage 中按 token 计费。pi 不支持 Google 的订阅登录 | 第 1 阶段确认 Claude 账号的 extra usage 和两家凭证。Google 暂不使用。如果 Claude 不可用，退路是申请 Anthropic API key。 |
| 假设：费用一律按"token 数 × 公开单价"计算。ChatGPT 订阅不按 token 计费，它的费用只是折算值 | 第 1 阶段确定单价来源时一并处理。 |
| 调度器的状态组合太多：任意嵌套、foreach、审批和续跑会互相影响 | 用 FakeRunner 做穷举式测试。如果调度器的实际工作量超过估算的 2 倍，按 decisions.md 改用 Mastra 或 LangGraph.js。 |
| 同一个 skill 在不同模型上表现不一 | 用产物 schema 校验，失败时让模型修正。第 7 阶段为关键节点保留小组回归用例。 |
| aipilot 的 skill 需要访谈用户，还会读取兄弟 skill 的文件 | 用交互式节点、`instructions` 字段和 skill 来源目录可读（AC-29）来适配。第 7 阶段验证。 |
| 画布太复杂：嵌套框、连线上的产物标签可能互相遮挡 | 第 6 阶段选择现成的画布库。标签遮挡和列表项很多的情况，按 design-spec 的 Q-2 和 Q-3 在实现后检查。 |
| 项目目录还不是 git 仓库 | 第 1 阶段拆解计划时，先初始化 git 仓库和项目脚手架。 |
