import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileCredentialStore, scopedCredentials } from "./pi-session.ts";

test("credential store exposes only the chosen provider, including after refresh", async () => {
  const lookedUp: string[] = [];
  const store = scopedCredentials("codexJ", (provider) => {
    lookedUp.push(provider);
    return {
      type: "oauth",
      access: "fake-access",
      refresh: "fake-refresh",
      expires: 1,
    };
  });
  assert.deepEqual(lookedUp, ["codexJ"]);
  assert.equal(await store.read("anthropic"), undefined);
  assert.deepEqual(await store.list(), [
    { providerId: "codexJ", type: "oauth" },
  ]);
  await assert.rejects(() => store.modify("anthropic", async () => undefined));
  await store.modify("codexJ", async (previous) => ({
    type: "oauth",
    access: "refreshed-access",
    refresh: "refreshed-refresh",
    expires: 100,
    previousType: previous?.type,
  }));
  assert.equal((await store.read("codexJ"))?.type, "oauth");
  assert.equal(await store.read("anthropic"), undefined);
});

test("createFileCredentialStore locks authPath, handles concurrent modifications and preserves unselected providers", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "aipilot-auth-test-"));
  const authPath = join(tempDir, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({
      anthropic: { type: "api_key", key: "sk-ant" },
      openai: { type: "api_key", key: "sk-oai" },
    }),
  );

  const baseStore = createFileCredentialStore(authPath);
  const scopedAnthropic = scopedCredentials("anthropic", baseStore);

  // Scoped store exposes only anthropic
  assert.equal((await scopedAnthropic.read("anthropic"))?.type, "api_key");
  assert.equal(await scopedAnthropic.read("openai"), undefined);
  assert.deepEqual(await scopedAnthropic.list(), [
    { providerId: "anthropic", type: "api_key" },
  ]);

  // Cannot modify another provider through scoped store
  await assert.rejects(
    () => scopedAnthropic.modify("openai", async () => undefined),
    /outside this node/,
  );

  // Concurrent modification on base store and scoped store
  await Promise.all([
    scopedAnthropic.modify(
      "anthropic",
      async (cur: Record<string, unknown> = {}) => ({
        ...cur,
        key: "sk-ant-refreshed",
      }),
    ),
    baseStore.modify("openai", async (cur: Record<string, unknown> = {}) => ({
      ...cur,
      key: "sk-oai-refreshed",
    })),
    baseStore.modify("codexJ", async () => ({
      type: "oauth",
      access: "acc1",
      refresh: "ref1",
      expires: 1000,
    })),
  ]);

  // On-disk file contains all three providers
  const onDisk = JSON.parse(await readFile(authPath, "utf8"));
  assert.equal(onDisk.anthropic?.key, "sk-ant-refreshed");
  assert.equal(onDisk.openai?.key, "sk-oai-refreshed");
  assert.equal(onDisk.codexJ?.access, "acc1");

  // Delete via baseStore
  await baseStore.delete("codexJ");
  const afterDelete = JSON.parse(await readFile(authPath, "utf8"));
  assert.equal(afterDelete.codexJ, undefined);
  assert.equal(afterDelete.anthropic?.key, "sk-ant-refreshed");

  await rm(tempDir, { recursive: true, force: true });
});
