import { test } from "node:test";
import assert from "node:assert/strict";
import { presenceThreads } from "./agent-presence.ts";

const agent = { chatThreadId: "saved", providerId: "acp-letta-quant", providerIds: ["acp-letta-quant"] };
const thread = (id: string, providerId = "acp-letta-quant", isArchived = false) => ({ id, providerId, isArchived });
const ids = (rows: { id: string }[]) => rows.map(row => row.id);

test("only the saved chat and its dispatched tasks can drive the dot", () => {
  const rows = [thread("saved"), thread("task"), thread("orphan")];
  assert.deepEqual(ids(presenceThreads(agent, rows, new Set(["task"]))), ["saved", "task"]);
});

test("an orphan provider thread is ignored, matching the sidebar", () => {
  assert.deepEqual(ids(presenceThreads(agent, [thread("orphan")], new Set())), []);
});

test("archived saved chats and tasks are excluded", () => {
  const rows = [thread("saved", "acp-letta-quant", true), thread("task", "acp-letta-quant", true)];
  assert.deepEqual(ids(presenceThreads(agent, rows, new Set(["task"]))), []);
});

test("no saved chat yet still admits dispatched tasks", () => {
  const rows = [thread("saved"), thread("task")];
  assert.deepEqual(ids(presenceThreads({ ...agent, chatThreadId: null }, rows, new Set(["task"]))), ["task"]);
});

test("an unset task set never matches every thread", () => {
  assert.deepEqual(ids(presenceThreads(agent, [thread("saved"), thread("orphan")], undefined)), ["saved"]);
});

test("the saved chat still has to belong to the agent's own providers", () => {
  const rows = [thread("saved", "acp-letta-scooter")];
  assert.deepEqual(ids(presenceThreads(agent, rows, new Set())), []);
});

test("a saved chat on a migrated provider alias is admitted", () => {
  const migrated = { ...agent, providerIds: ["acp-letta-quant", "acp-letta-old-quant"] };
  assert.deepEqual(ids(presenceThreads(migrated, [thread("saved", "acp-letta-old-quant")], new Set())), ["saved"]);
});

test("a dispatched task is admitted on another provider, as chat_start allows", () => {
  assert.deepEqual(ids(presenceThreads(agent, [thread("task", "pi")], new Set(["task"]))), ["task"]);
});
