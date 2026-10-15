import assert from "node:assert/strict";
import { test } from "node:test";
import { packageName } from "./index.ts";

test("runner package loads", () => {
  assert.equal(packageName, "@aipilotagent/runner");
});
