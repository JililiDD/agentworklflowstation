# Lessons

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
