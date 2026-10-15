# 多模型 Agent 工作流引擎 · Handoff

Oct 13, 2026 · @Jili

## 背景与目标

要做的是一个通用的 agent 工作流引擎：用一份 YAML 定义 DAG，每个步骤独立指定模型（可跨公司）、thinking level、skill 和输入输出，每一步交给 pi 执行。

起点是 aipilot（Claude Code 和 Codex 上的文档驱动开发流程插件）。希望 spec-plan、dev-builder、reviewer 这类 skill 各自跑在最合适的模型上，比如 plan 和 review 用 Opus 5.5，实现用 Sonnet 5.5，review 也可以换成别家的模型。评估过 pi-flows、rayspec、relayflows、ccswarm、FleetQ 等开源项目后，决定自建。

核心需求：

- 自由创建步骤，用依赖关系连成 DAG
- 每步指定模型、thinking level、skill、输入和输出
- 步骤之间靠产物交接，支持循环、人工审批、条件分支
- 运行可追踪（日志、token、费用）、可续跑、代码修改可隔离

## 范围与非目标

v1 是一个单用户、本地运行的 CLI 工具，先跑通真实的 aipilot 流程，再决定要不要做 UI。

|  | v1 做 | v1 不做（以后再说） |
| --- | --- | --- |
| 定义 | YAML 定义 DAG、组节点循环、`when` 条件 | 任意表达式、`foreach` 动态扇出 |
| 执行 | 只读步骤并行、写步骤加锁串行 | 写步骤并行（独立 worktree 加 merge） |
| 运行时 | LocalRunner（进程内 pi SDK） | SandboxRunner（容器）放在第 2 阶段 |
| 界面 | CLI：run、resume、approve、reject | Web 运行查看器、画布编辑器 |
| 部署 | 单用户、单机 | 多用户、分布式执行 |

## 关键决策与理由

这些决定已经讨论过并定下来，接手时不必重新论证；如需推翻，请先看理由。

| 决策 | 选择 | 理由 | 放弃的选项 |
| --- | --- | --- | --- |
| 语言 | TypeScript（Node） | pi SDK 是 TS，UI 也是 TS，全程一种语言 | Java/Spring 编排加 pi 子进程：只有要接入现有 Java 体系时才值得 |
| 步骤运行时 | pi，藏在 `StepRunner` 接口后 | 多家模型、thinking level、skill 现成可用；接口隔离 SDK 的变动 | Claude Agent SDK（只支持 Claude）、直接调各家 API |
| 引擎 | 自建，约 1000 行 | DAG 很小，只需依赖、循环、审批 | LangGraph、Temporal（MVP 太重）、Dify/n8n（不贴合编码 agent） |
| 状态存储 | 运行目录里的文件 | 可直接查看、易调试、无需数据库 | SQLite，多用户时再引入 |
| 循环 | 组节点，整体重复 | 顶层图严格无环，「哪些步骤重跑」无需额外规则 | `back_to` 回边 |
| 步骤交接 | 产物文件，对话隔离、工作区共享 | 跨模型、跨公司切换时没有上下文兼容问题 | 共享对话历史 |
| 工具权限 | `repo: readonly / write` 开关 | 比工具白名单简单，不依赖 pi 的路径限制能力 | 每步工具白名单 |
| skill 加载 | 引擎读取 SKILL.md 注入系统提示 | 不依赖 pi 能否只加载指定 skill | pi 自动发现 |
| effort | 直接用 pi 的 thinking level | 少一层翻译 | 自定义档位再映射 |
| 条件 | 结构化条件（field、equals、all） | 不需要表达式求值器 | 表达式字符串 |

## 架构

引擎只依赖 `StepRunner` 接口；所有 pi 调用都在 runner 实现里，换运行时或升级 pi 只动这一层。

&#91;embedded content: 模块与依赖 · 引擎、StepRunner、三种 runner\]

产物校验、只读检查、git 检查点和预算都由引擎负责，runner 只管「用指定配置跑完一步并上报事件」。

### StepRunner 接口（草案）

```ts
interface StepRunner {
  runAgentStep(spec: AgentStepSpec, ctx: StepContext): Promise<StepResult>;
  runCommandStep(spec: CommandStepSpec, ctx: StepContext): Promise<StepResult>;
}

interface StepContext {
  runDir: string;              // .runs/<run-id>/steps/<step>/<round>/
  worktree: string;            // 本次运行的 git worktree
  feedback?: string[];         // 上一轮意见的产物路径
  onEvent(e: StepEvent): void; // 写 events.jsonl、累计费用
  signal: AbortSignal;         // 预算超限或用户中止
}

interface StepResult {
  status: 'succeeded' | 'failed';
  outputs: Record<string, string>; // 产物名 → 路径
  usage: { inputTokens: number; outputTokens: number; costUsd?: number };
  error?: string;
}
```

### 运行目录

```
.runs/<run-id>/
  workflow.yaml          # 本次运行冻结的工作流副本
  state.json             # 每个节点的状态与当前轮次
  steps/<step>/<round>/
    task.md              # 实际发给模型的任务
    events.jsonl         # 模型调用、工具调用、token、费用
    out/                 # 本步产物
```

## 工作流定义

工作流是一份 YAML，是唯一的事实来源；`needs` 定义边，组节点定义循环，引擎在运行前做静态校验。

### 字段

| 字段 | 适用 | 说明 |
| --- | --- | --- |
| `id` | 所有步骤 | 全局唯一 |
| `needs` | 所有步骤 | 上游步骤 id 列表，定义 DAG 的边 |
| `model` | agent 步骤 | pi 的模型标识，如 `anthropic/claude-opus-5-5` |
| `thinking` | agent 步骤 | 直接用 pi 的 thinking level |
| `skills` | agent 步骤 | 要注入的 skill 名称列表 |
| `repo` | agent 步骤 | `readonly`（默认）或 `write` |
| `task` | agent 步骤 | 本步要做的事，支持 `{{...}}` 引用 |
| `outputs` | agent 步骤 | 产物声明：文件名，JSON 可附 schema |
| `run` | 命令步骤 | 要执行的命令，不调模型；退出码和日志自动成为产物 |
| `gate` | 所有步骤 | `approve`：完成后等人工批准 |
| `when` | 所有步骤 | 结构化条件，只能引用 JSON 产物的字段 |
| `group` | 组节点 | `until`、`max`、`on_exhausted`，内含子 `steps` |

引擎自动产生的产物不需要声明：写模式步骤的 `diff`、命令步骤的 `log` 和退出码。模板里 `{{out.<name>}}` 表示本步产物的写入路径，`{{<step>.<name>}}` 表示上游产物的路径。

### 示例

```yaml
name: feature-dev
inputs:
  requirement: { type: text }
max_parallel: 3
budget_usd: 8

steps:
  - id: plan
    model: anthropic/claude-opus-5-5
    thinking: high
    skills: [spec-plan]
    task: 根据 {{inputs.requirement}} 写方案到 {{out.plan}}，并把元数据写到 {{out.meta}}
    outputs:
      plan: { file: plan.md }
      meta: { file: meta.json, schema: schemas/plan-meta.json }
    gate: approve

  - id: impl-loop
    needs: [plan]
    group:
      until:
        all:
          - { field: review-logic.verdict.status, equals: approved }
          - { field: review-security.verdict.status, equals: approved }
      max: 2
      on_exhausted: gate
    steps:
      - id: build
        model: anthropic/claude-sonnet-5-5
        thinking: medium
        skills: [dev-builder]
        repo: write
        task: 按 {{plan.plan}} 实现

      - id: test
        needs: [build]
        run: ./gradlew test

      - id: review-logic
        needs: [test]
        model: anthropic/claude-opus-5-5
        thinking: high
        skills: [reviewer]
        task: 对照 {{plan.plan}} 审查 {{build.diff}}，测试结果见 {{test.log}}，结论写到 {{out.verdict}}
        outputs:
          verdict: { file: verdict.json, schema: schemas/verdict.json }

      - id: review-security
        needs: [test]
        model: openai/<model-id>
        thinking: high
        skills: [security-review]
        task: 从安全角度审查 {{build.diff}}，结论写到 {{out.verdict}}
        outputs:
          verdict: { file: verdict.json, schema: schemas/verdict.json }

  - id: docs
    needs: [impl-loop]
    when: { field: plan.meta.needs_docs, equals: true }
    model: anthropic/claude-sonnet-5-5
    thinking: low
    skills: [doc-writer]
    repo: write
    task: 根据本次改动更新文档
```

### 加载时的静态校验

- id 唯一，`needs` 引用的步骤存在，图无环
- `task` 和 `when` 引用的产物必须来自祖先节点；并行的兄弟节点互相引用会产生竞态，必须报错
- `when` 只能引用 JSON 类型产物的字段
- 组外步骤只能依赖整个组，不能依赖组内步骤
- `model` 和 `thinking` 必须是 pi 支持的组合

## 执行语义

每个步骤是一次独立的 agent 运行：对话隔离，代码工作区共享，靠产物交接；调度器是 Kahn 算法加并发池，所有状态落盘。

### 单个 agent 步骤

1. 渲染 `task`；如果是重跑（组循环或审批被拒），附上「上一轮意见」及其产物路径。
2. 创建 pi 会话：设置模型和 thinking level，注入 skill，按 `repo` 模式给工具（readonly：read 加只写产物目录；write：全部工具）。
3. 运行，事件写入 `events.jsonl`，累计 token 和费用，超出预算立即中止。
4. 校验产物（存在、符合 schema）；不合格就在同一会话里要求修正，最多 2 次。
5. readonly 步骤检查 worktree 无改动，有改动就回滚并判失败；write 步骤提交 git 检查点，生成 `diff`。
6. 写入状态，交回调度器。

API 报错（限流、超时）由 runner 按退避策略重试，和第 4 步的产物修正分开计数。

### 调度器主循环

1. 找出上游全部完成、自己仍在等待的节点，放进就绪队列。
2. 在 `max_parallel`、写锁、剩余预算的约束下启动节点；写步骤同一时间只能有一个。
3. 节点结束后更新状态，写入 `state.json`。
4. 根据结果处理下游，回到第 1 步，直到没有可运行的节点。

### 节点状态

| 状态 | 含义 | 之后 |
| --- | --- | --- |
| pending | 等待上游 | 上游完成后进入就绪队列 |
| running | 执行中 | succeeded、failed 或 waiting\_approval |
| waiting\_approval | 完成，等待人工 | approve 后为 succeeded；reject 后带意见重跑 |
| succeeded | 成功 | 下游可启动 |
| failed | 失败 | 不再启动新节点，运行可续跑 |
| skipped | `when` 不满足，或上游全部跳过 | 跳过向下传播 |

### 组节点、审批、失败

- 组节点每轮完整执行组内子图，结束后检查 `until`：满足则组成功；不满足且未到 `max` 则开下一轮，并把本轮各 review 的产物作为意见注入下一轮的 build；用尽次数按 `on_exhausted` 转人工审批。
- 审批只阻塞自己的下游，其他分支照常推进。
- 某步失败后，已在运行的兄弟节点跑完，不再启动新节点，整个运行标记为失败。
- 续跑：先把 worktree 恢复到最后一个检查点，再从第一个未完成的节点开始；已成功的步骤不重跑。
- 崩溃一致性：先提交 git 检查点，再原子写 `state.json`（写临时文件后 rename）；续跑时以 git 为准校验状态。

## 安全与隔离

pi 本身几乎没有安全模型（扩展和 skill 可以执行任意命令），所以隔离由引擎负责，分两级。

| 级别 | 适用 | 做法 |
| --- | --- | --- |
| 本地模式（v1） | 自己使用、可信的 skill | 每次运行一个独立 git worktree；readonly 步骤结束后检查 worktree 无改动；关闭 pi 的扩展和 skill 自动发现 |
| 沙箱模式（第 2 阶段） | 给别人用、不可信的 skill | 每次运行一个容器，挂载 worktree；runner 在容器内以子进程运行 pi，通过 stdout 的 JSONL 与引擎通信；网络只放行模型 API 和包仓库（需要出口代理） |

其他要求：

- 密钥只注入本次运行用到的 provider，不写进日志和事件流。
- 命令步骤（`run`）和 agent 步骤走同一个 runner，沙箱模式下同样在容器里执行。
- 不安装来源不明的 pi package；需要的能力优先在引擎里实现。

## 实施计划与估时

第 1 阶段约 3 周可得到可用的 CLI，全部完成约 2 个月全职工作量；估算按一位熟悉 TypeScript 的工程师借助 Claude Code 计，误差约 ±50%，业余时间推进时日历时间约为 3 到 4 倍。

| 阶段 | 模块 | 难度 | 估时（人天） | 主要难点 |
| --- | --- | --- | --- | --- |
| 1 CLI MVP | Schema、加载、静态校验 | 低到中 | 2–3 | 祖先引用、组边界、模板解析 |
| 1 | 调度器 | 中 | 3–5 | 组循环、跳过传播、写锁、审批暂停组合后的状态正确性 |
| 1 | 运行目录、检查点、续跑 | 中 | 2–3 | 崩溃时 git 与 state.json 不一致；未跟踪文件等边界 |
| 1 | LocalRunner（pi SDK） | 中，不确定性最高 | 3–5 | SDK 能力待验证；事件、费用、产物修正 |
| 1 | 命令步骤、只读检查、CLI | 低 | 2–3 | 体力活 |
| 2 可运营 | SandboxRunner | 中到高 | 3–5 | rootless Podman 权限映射、网络白名单、清理 |
| 2 | Web 运行查看器 | 中 | 4–6 | 实时事件、产物展示、审批按钮 |
| 3 编辑器 | 画布编辑器 | 高 | 7–10 | 组节点布局、表单联动、YAML 往返保留注释 |
| 4 增强 | 写分支独立 worktree 加 merge | 中到高 | 3–5 | 冲突处理 |
| 4 | `foreach` 动态扇出 | 中 | 3–5 | 运行时生成节点与静态校验冲突 |

推进原则：

- 第一天就写 FakeRunner：不调模型，按脚本返回产物和事件。调度器、循环、跳过、续跑全部用它测试，快、免费、确定。
- 每个阶段结束都要能用；第 1 阶段结束就用它跑真实的 aipilot 流程。
- 画布编辑器在第 2 阶段用过一段时间后再决定做不做，YAML 加运行查看器可能已经够用。
- 所有 pi 调用只出现在 runner 适配器里。

## 未验证假设与第一周验证清单

设计建立在几条关于 pi SDK 的假设上，都还没实测；第一周先写一个验证脚本逐项确认，每项都有退路，`StepRunner` 接口之上的设计不受影响。

- [ ] 会话级设置模型和 thinking level，跨 provider 的认证可配置。退路：子进程调用 pi CLI，用参数指定。
- [ ] 能关闭 skill 自动发现，或只加载指定 skill。退路：用 CLI 的关闭选项，由引擎注入 SKILL.md。
- [ ] 能限定工具集，并注册自定义工具（用于提交结构化结果）。退路：readonly 靠事后 git 检查；结构化结果改为写文件加 schema 校验。
- [ ] 事件流带 token 用量，能据此计算费用。退路：从 provider 返回的 usage 自行累计，单价放在配置里。
- [ ] 同一会话能继续发送修正指令（用于产物修正）。退路：开新会话，附上失败原因。
- [ ] 确认当前正确的包名（见过 `@mariozechner/...` 和 `@earendil-works/...` 两种）和 SDK 的会话创建方式。

## 风险与开放问题

最大的风险不在代码，而在 agent 能否稳定交出合格产物；这部分只能在真实使用中持续打磨。

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 同一 skill 在不同模型上表现不一 | review 格式出错、build 偏离方案 | 产物 schema 校验加修正重试；每个步骤保留一小组回归用例 |
| pi SDK 快速演进 | 升级时接口变化 | 所有调用限制在 runner 适配器内；锁定版本 |
| 循环和并行导致费用失控 | 一次运行花费过高 | `budget_usd` 启动前预估、运行中超限中止；组节点设 `max` |
| 崩溃导致 git 与状态不一致 | 续跑出错 | 固定写入顺序，续跑以 git 为准，写测试覆盖 |
| 沙箱网络配置复杂 | 第 2 阶段延期 | 本地模式先满足自用，沙箱按需推进 |

开放问题：

- 编排层用 TypeScript 还是 Java/Spring？当前选 TS；如果这个工具要接入现有 Java 服务，应改为 Java 编排加 pi 子进程。
- 画布编辑器是否需要，等第 2 阶段用过后再定。
- 模型单价从 pi 的模型元数据读取还是自己维护，取决于验证结果。

## 接手后的下一步

按顺序做，前两项完成前不写调度器以外的业务代码。

- [ ] 写 pi SDK 验证脚本，跑完上面的验证清单，记录每项结论
- [ ] 用 Zod 写 workflow schema 和加载时的静态校验，配单元测试（无环、祖先引用、组边界）
- [ ] 定义 `StepRunner` 接口，实现 FakeRunner
- [ ] 实现调度器，用 FakeRunner 覆盖并行、写锁、组循环、跳过、审批、失败、续跑
- [ ] 实现 LocalRunner 和命令步骤
- [ ] 实现 CLI（run、resume、approve、reject）
- [ ] 用 aipilot 的 spec-plan、dev-builder、reviewer 跑通示例工作流，记录耗时、费用、手工介入次数
