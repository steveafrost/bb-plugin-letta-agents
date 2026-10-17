import { test } from "node:test";
import assert from "node:assert/strict";
import { agentTasks } from "./agent-tasks.ts";
const agents = [{ id: "jeeves", providerId: "letta", providerIds: ["old-letta"] }];
const thread = (id: string, providerId = "pi", parentThreadId: string | null = null) => ({
  id, providerId, parentThreadId, lifecycleOwnerThreadId: null as string | null,
  originKind: null as "fork" | null, isArchived: false,
});
test("tasks follow ancestry across providers, without nesting the ongoing chat", () => {
  const rows = [thread("chat", "old-letta"), thread("task", "pi", "chat"), thread("subtask", "omp", "task"), thread("unrelated")];
  assert.deepEqual(agentTasks(agents, rows).get("jeeves")?.map(t => t.id), ["task", "subtask"]);
});
test("lifecycle ownership identifies delegation; forks, archived tasks and cycles stay out", () => {
  const rows = [thread("chat", "letta"), { ...thread("owned"), lifecycleOwnerThreadId: "chat" }, { ...thread("fork", "pi", "chat"), originKind: "fork" as const }, { ...thread("archived", "pi", "chat"), isArchived: true }, thread("cycle-a", "pi", "cycle-b"), thread("cycle-b", "pi", "cycle-a"), thread("orphan", "pi", "missing")];
  assert.deepEqual(agentTasks(agents, rows).get("jeeves")?.map(t => t.id), ["owned"]);
});
