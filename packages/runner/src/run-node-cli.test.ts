import assert from "node:assert/strict";
import { test } from "node:test";
import { askInTerminal } from "./run-node-cli.ts";

test("prints numbered choices and returns the selected id and text", async () => {
  const lines: string[] = [];
  const prompts: string[] = [];
  const replies = ["3", "2"];
  const answer = await askInTerminal(
    {
      prompt: "Pick a format",
      options: [
        { id: "txt", label: "Text" },
        { id: "md", label: "Markdown" },
      ],
    },
    async (prompt) => {
      prompts.push(prompt);
      return replies.shift() ?? "";
    },
    (line) => {
      lines.push(line);
    },
  );
  assert.deepEqual(answer, { text: "Markdown", optionId: "md" });
  assert.match(
    lines.join(""),
    /Question: Pick a format\n1\. Text\n2\. Markdown/,
  );
  assert.match(lines.join(""), /Choose a listed number/);
  assert.deepEqual(prompts, ["Answer: ", "Answer: "]);
});

test("accepts free-form answers when no choices are supplied", async () => {
  const answer = await askInTerminal(
    { prompt: "Why?", options: [] },
    async () => "Because it is short",
    () => {},
  );
  assert.deepEqual(answer, { text: "Because it is short" });
});
