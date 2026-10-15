# Lessons

## 2026-10-15 Node strip-types 的语法边界

- Node 26 的 `--experimental-strip-types` 不支持 TypeScript 构造函数参数属性。TypeScript 类型检查可以通过，但运行测试和开发脚本时会报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。需要显式声明字段，在构造函数体中赋值。
- Phase 1 的命令节点只过滤子进程的环境变量，不能阻止同一用户的子进程通过文件路径读取凭证。真正的文件隔离留到工作区或沙箱阶段。

## 2026-10-15 pi 1.3.0 的凭证隔离与刷新

- `ModelRuntime.create({ credentials })` 可接收按提供方过滤的 CredentialStore，`readStoredCredential(provider)` 可只返回所选凭证。pi SDK 未在包公共入口导出可持久化的 `AuthStorage` 实现。
- Phase 1 runner 用内存中的单提供方 CredentialStore 隔离会话；OAuth 刷新只更新本次会话的内存副本。如果提供方轮换 refresh token，下一次从原 auth.json 读取的旧 token 可能失效。后续凭证持久化方案需要保留跨进程串行写入语义，不能直接覆盖 auth.json。
- 这个隔离只限制 pi ModelRuntime 获得的凭证，并不是 OS 沙箱。真实模型仍有文件读取能力，不能据此保证它无法读取工作目录外的敏感文件；后续安全边界需要单独验证。

## 2026-10-15 pi 1.3.0 SDK 能力

- SDK 默认不加载 `~/.pi/agent/extensions`。ChatGPT 多账号扩展 `codex-accounts` 必须通过 `DefaultResourceLoader.additionalExtensionPaths` 加载，否则只有 `openai-codex` 模型，没有 `codexJ` 凭证。
- `createAgentSession({ tools })` 是允许名单。自定义工具也必须写进这个名单，否则不会出现。
- `SettingsManager.inMemory({ retry: { enabled: false } })` 可以关掉 pi 内置重试。
- `message_end` 事件带 `usage`。Anthropic 有单价。Codex 订阅模型的单价是 0。
- Node 26 可以用 `node --experimental-strip-types` 直接跑 TypeScript。
- 本机 Codex 最便宜的模型是 `codexJ/gpt-6-luna`，不是计划里的 `gpt-5.6-luna`。
- 来源：`spikes/pi-capabilities.ts` 在 1.3.0 上的运行记录。

## 2026-10-15 Google 订阅经 antigravity

- 本机 Google Gemini 订阅经 `antigravity` oauth 可用。模型标识形如 `antigravity/gemini-3.7-flash`。
- 这取代 2026-10-14 条目中「pi 不支持 Google 的订阅登录」这一句。该条其余内容不变。
- Phase 1 仍不验证 Google。见 `memory/decisions.md` 同日条目。

## 2026-10-14 pi 的凭证和计费

- pi 用 `/login` 登录，凭证保存在 `~/.pi/agent/auth.json`。pi 不复用 Claude Code、Codex 或 Gemini CLI 的登录。
- 凭证的解析顺序是：CLI 的 `--api-key` 参数、`auth.json`、环境变量、`models.json` 中的自定义提供方。
- Claude Pro/Max 可以通过 pi 登录。第三方工具的用量从 extra usage 中扣除，按 token 计费，不计入订阅额度。
- ChatGPT Plus/Pro 可以通过 Codex 登录，这是 OpenAI 官方认可的方式。
- pi 不支持 Google 的订阅登录。Google 只能用 Gemini API key，环境变量是 `GEMINI_API_KEY`。
- 来源：本机 pi 0.84.3 的 `docs/providers.md`。升级到 1.2.0 后需要复查。
