import assert from "node:assert/strict";
import { test } from "node:test";
import { costUsdFromUsage, usageWithCost } from "./cost.ts";

test("computes cost from token counts and rates", () => {
  const cost = costUsdFromUsage(
    { inputTokens: 1000, outputTokens: 500 },
    { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
  );
  assert.equal(cost, 0.0035);
});

test("omits cost when rates are missing", () => {
  const usage = usageWithCost(
    { inputTokens: 10, outputTokens: 2, costUsd: 0 },
    undefined,
  );
  assert.equal("costUsd" in usage, false);
});

test("omits cost when catalog rates are zero", () => {
  const cost = costUsdFromUsage(
    { inputTokens: 10, outputTokens: 2 },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  assert.equal(cost, undefined);
});
