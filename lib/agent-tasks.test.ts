import { test } from "node:test";
import assert from "node:assert/strict";
import { agentTasks } from "./agent-tasks.ts";

test("deep ancestry is iterative and memoized, with archived ancestors eligible", () => {
  const root = { ...thread("root", "letta"), isArchived: true };
  const rows = [root, ...Array.from({ length: 20_000 }, (_, i) => thread(`t${i}`, "pi", i ? `t${i - 1}` : "root"))];
  assert.equal(agentTasks(agents, rows).get("jeeves")?.length, 20_000);
  assert.equal(agentTasks(agents, [...rows].reverse()).get("jeeves")?.length, 20_000);
});

test("nearest owner and lifecycle precedence win over conflicting parent ancestry", () => {
  const roster = [...agents, { id: "second", providerId: "other" }];
  const rows = [thread("a", "letta"), thread("b", "other", "a"), thread("child", "pi", "b"),
    { ...thread("owned", "pi", "a"), lifecycleOwnerThreadId: "b" },
    { ...thread("missing", "pi", "a"), lifecycleOwnerThreadId: "absent" }];
  const result = agentTasks(roster, rows);
  assert.deepEqual(result.get("jeeves")?.map(t => t.id), ["b"]);
  assert.deepEqual(result.get("second")?.map(t => t.id), ["child", "owned"]);
});

test("forks stop parent traversal, but explicit lifecycle ownership crosses forks", () => {
  const rows = [thread("root", "letta"), { ...thread("fork", "pi", "root"), originKind: "fork" as const },
    thread("child", "pi", "fork"), { ...thread("owned-fork", "pi", "root"), originKind: "fork" as const, lifecycleOwnerThreadId: "root" }];
  assert.deepEqual(agentTasks(agents, rows).get("jeeves")?.map(t => t.id), ["owned-fork"]);
});

test("cycles preserve candidate exclusion and nearest ownership in either input order", () => {
  const rows = [thread("a", "letta", "b"), thread("b", "pi", "a"), thread("c", "pi", "b"),
    thread("self", "letta", "self"), thread("x", "pi", "y"), thread("y", "pi", "x")];
  for (const ordered of [rows, [...rows].reverse()]) {
    assert.deepEqual(agentTasks(agents, ordered).get("jeeves")?.map(t => t.id).sort(), ["b", "c"]);
  }
});
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
