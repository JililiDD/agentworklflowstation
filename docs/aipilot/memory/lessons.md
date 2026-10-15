# Lessons

## 2026-10-14 pi 的凭证和计费

- pi 用 `/login` 登录，凭证保存在 `~/.pi/agent/auth.json`。pi 不复用 Claude Code、Codex 或 Gemini CLI 的登录。
- 凭证的解析顺序是：CLI 的 `--api-key` 参数、`auth.json`、环境变量、`models.json` 中的自定义提供方。
- Claude Pro/Max 可以通过 pi 登录。第三方工具的用量从 extra usage 中扣除，按 token 计费，不计入订阅额度。
- ChatGPT Plus/Pro 可以通过 Codex 登录，这是 OpenAI 官方认可的方式。
- pi 不支持 Google 的订阅登录。Google 只能用 Gemini API key，环境变量是 `GEMINI_API_KEY`。
- 来源：本机 pi 0.84.3 的 `docs/providers.md`。升级到 1.2.0 后需要复查。
