import assert from "node:assert/strict";
import { test } from "node:test";
import { scopedCredentials } from "./pi-session.ts";

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
