import { test } from "node:test";
import assert from "node:assert/strict";
import { presenceThreads } from "./agent-presence.ts";

const thread = (id: string, isArchived = false) => ({ id, isArchived });
const agent = { chatThreadId: "saved" };

test("only the saved chat and its dispatched tasks can drive the dot", () => {
  const rows = [thread("saved"), thread("task"), thread("orphan")];
  const ids = new Set(["task"]);
  assert.deepEqual(presenceThreads(agent, rows, ids).map(t => t.id), ["saved", "task"]);
});

test("an orphan provider thread is ignored, matching the sidebar", () => {
  assert.deepEqual(presenceThreads(agent, [thread("orphan")], new Set()).map(t => t.id), []);
});

test("archived saved chats and tasks are excluded", () => {
  const rows = [thread("saved", true), thread("task", true)];
  assert.deepEqual(presenceThreads(agent, rows, new Set(["task"])).map(t => t.id), []);
});

test("no saved chat yet still admits dispatched tasks", () => {
  const rows = [thread("saved"), thread("task")];
  assert.deepEqual(presenceThreads({ chatThreadId: null }, rows, new Set(["task"])).map(t => t.id), ["task"]);
});

test("an unset task set never matches every thread", () => {
  assert.deepEqual(presenceThreads(agent, [thread("saved"), thread("orphan")], undefined).map(t => t.id), ["saved"]);
});
