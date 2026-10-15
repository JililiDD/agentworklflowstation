import assert from "node:assert/strict";
import { test } from "node:test";
import { loadNodeDefinition, NodeDefinitionError } from "./load-definition.ts";

const validAgent = {
  kind: "agent",
  model: "anthropic/claude-haiku-5-5",
  thinkingLevel: "low",
  task: "Write ok",
  interactive: false,
  outputs: ["result.txt"],
};

test("loads a valid agent definition", () => {
  const definition = loadNodeDefinition(JSON.stringify(validAgent));
  assert.equal(definition.kind, "agent");
  if (definition.kind !== "agent") {
    throw new Error("expected agent");
  }
  assert.equal(definition.model, validAgent.model);
  assert.equal(definition.thinkingLevel, "low");
});

test("rejects a missing model", () => {
  const { model: _model, ...rest } = validAgent;
  assert.throws(
    () => loadNodeDefinition(JSON.stringify(rest)),
    (error: unknown) =>
      error instanceof NodeDefinitionError &&
      error.message === "model is required",
  );
});

test("rejects an unknown thinking level", () => {
  assert.throws(
    () =>
      loadNodeDefinition(
        JSON.stringify({ ...validAgent, thinkingLevel: "ultra" }),
      ),
    (error: unknown) =>
      error instanceof NodeDefinitionError &&
      error.message === "unknown thinking level: ultra",
  );
});

test("rejects an unknown node type", () => {
  assert.throws(
    () => loadNodeDefinition(JSON.stringify({ kind: "widget" })),
    (error: unknown) =>
      error instanceof NodeDefinitionError &&
      error.message === "unknown node type: widget",
  );
});
