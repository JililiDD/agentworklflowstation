import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AuthManager } from "./auth-manager.ts";

let tempDir: string;
let authPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "aipilot-auth-test-"));
  authPath = join(tempDir, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({
      anthropic: { type: "api_key", key: "sk-ant-test" },
      codexJ: {
        type: "oauth",
        access: "secret-access-token",
        refresh: "secret-refresh-token",
        expires: 99999999,
      },
    }),
  );
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test("AuthManager lists non-sensitive provider metadata without exposing secrets", async () => {
  const manager = new AuthManager({ authPath });
  const providers = await manager.listProviders();

  assert.equal(providers.length, 2);
  const ant = providers.find((p) => p.providerId === "anthropic");
  assert.equal(ant?.type, "api_key");
  assert.equal(ant?.configured, true);
  assert.equal(ant ? "key" in ant : false, false);

  const codex = providers.find((p) => p.providerId === "codexJ");
  assert.equal(codex?.type, "oauth");
  assert.equal(codex?.configured, true);
  assert.equal(codex ? "access" in codex : false, false);
  assert.equal(codex ? "refresh" in codex : false, false);
});

test("AuthManager sets API key and logs out cleanly", async () => {
  const manager = new AuthManager({ authPath });

  await manager.setApiKey("google", "gemini-secret-key");
  let providers = await manager.listProviders();
  assert.equal(
    providers.some((p) => p.providerId === "google"),
    true,
  );

  // Check file on disk
  const onDisk = JSON.parse(await readFile(authPath, "utf8"));
  assert.equal(onDisk.google?.key, "gemini-secret-key");

  // Logout removes provider
  await manager.logout("anthropic");
  providers = await manager.listProviders();
  assert.equal(
    providers.some((p) => p.providerId === "anthropic"),
    false,
  );
  const afterLogout = JSON.parse(await readFile(authPath, "utf8"));
  assert.equal(afterLogout.anthropic, undefined);
  assert.equal(afterLogout.google?.key, "gemini-secret-key");
});

test("AuthManager login handles events, user prompts, responses, and completion", async () => {
  // Fake ModelRuntime with mock login flow
  let loginCalled = false;
  const mockRuntime = {
    async login(
      _providerId: string,
      _authType: string,
      interaction: {
        notify: (e: Record<string, unknown>) => void;
        prompt: (p: Record<string, unknown>) => Promise<string>;
      },
    ): Promise<Record<string, unknown>> {
      loginCalled = true;
      interaction.notify({
        type: "auth_url",
        url: "https://auth.example.com/oauth/authorize?client_id=123",
        instructions: "Please visit URL and authenticate",
      });
      interaction.notify({
        type: "progress",
        message: "Waiting for user authorization...",
      });

      // Request user code
      const code = await interaction.prompt({
        type: "manual_code",
        message: "Enter the code shown in your browser",
      });

      if (code !== "valid-code") {
        throw new Error("invalid authorization code");
      }

      return {
        type: "oauth",
        access: "secret-token",
        refresh: "secret-refresh",
        expires: 1000,
      };
    },
  } as unknown as ModelRuntime;

  const manager = new AuthManager({ authPath, runtime: mockRuntime });

  const initial = await manager.startLogin("test-provider", "oauth");
  assert.equal(initial.provider, "test-provider");
  assert.equal(initial.authType, "oauth");

  // Wait for session to enter waiting_user_input
  for (let i = 0; i < 20; i++) {
    const s = manager.getLoginSession(initial.loginId);
    if (s?.status === "waiting_user_input") break;
    await new Promise((r) => setTimeout(r, 10));
  }

  const waiting = manager.getLoginSession(initial.loginId);
  assert.equal(waiting?.status, "waiting_user_input");
  assert.equal(waiting?.currentPrompt?.type, "manual_code");
  assert.equal(waiting?.events.length, 2);
  assert.equal(
    waiting?.events[0]?.url,
    "https://auth.example.com/oauth/authorize?client_id=123",
  );

  // Submit response
  await manager.respondLogin(initial.loginId, "valid-code");

  // Wait for completion
  for (let i = 0; i < 20; i++) {
    const s = manager.getLoginSession(initial.loginId);
    if (s?.status === "completed") break;
    await new Promise((r) => setTimeout(r, 10));
  }

  const completed = manager.getLoginSession(initial.loginId);
  assert.equal(completed?.status, "completed");
  assert.equal(loginCalled, true);
  // Ensure token is NOT leaked in login state
  assert.equal(completed ? "access" in completed : false, false);
  assert.equal(completed ? "token" in completed : false, false);
});

test("AuthManager cancels active login flow cleanly", async () => {
  const _cancelled = false;
  const mockRuntime = {
    async login(
      _providerId: string,
      _authType: string,
      interaction: {
        notify: (e: Record<string, unknown>) => void;
        prompt: (p: Record<string, unknown>) => Promise<string>;
      },
      _options?: unknown,
    ): Promise<Record<string, unknown>> {
      interaction.notify({ type: "progress", message: "starting" });
      await interaction.prompt({
        type: "text",
        message: "Enter input",
      });
      return { type: "api_key", key: "foo" };
    },
  } as unknown as ModelRuntime;

  const manager = new AuthManager({ authPath, runtime: mockRuntime });
  const session = await manager.startLogin("provider-cancel", "api_key");

  for (let i = 0; i < 20; i++) {
    const s = manager.getLoginSession(session.loginId);
    if (s?.status === "waiting_user_input") break;
    await new Promise((r) => setTimeout(r, 10));
  }

  await manager.cancelLogin(session.loginId);

  const final = manager.getLoginSession(session.loginId);
  assert.equal(final?.status, "cancelled");
});
