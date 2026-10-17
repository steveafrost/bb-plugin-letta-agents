import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

// Gates expose the exact await boundary without sleeps or production test hooks.
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out waiting for automatic synchronization")), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

async function successfulHost() {
  const directory = await mkdtemp(join(tmpdir(), "letta-server-test-"));
  const executable = join(directory, "fixture.cjs");
  // This is a Node fixture, never Docker. Accept only the two fixed commands
  // used by synchronization; emit an invented token, never read any token file.
  await writeFile(executable, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== "exec" || args[1] !== "letta") process.exit(2);
if (args[2] === "node" && args[3] === "-e") {
  process.stdout.write(JSON.stringify([{id:"agent-id",name:"Test",description:null,avatarVersion:1}]));
} else if (args[2] === "cat" && args[3] === "/root/.letta/app-server.token") {
  process.stdout.write("invented-test-token");
} else process.exit(2);
`, { mode: 0o700 });
  let customAgents = "[]";
  const host = createFakePluginHost({
    pluginId: "letta-agents",
    settings: { dockerExecutable: executable, container: "letta", projectId: "test-project", hostId: "test-host", environmentProviderId: "test-workspace" },
    sdk: {
      plugins: {
        getSettings: async () => ({ values: { customAgents } }),
        updateSettings: async input => { customAgents = String(input.values.customAgents); return { values: { customAgents } }; },
      },
      providers: { list: async () => JSON.parse(customAgents).map((agent: { id: string }) => ({ id: `acp-${agent.id}`, available: true })) },
      threads: {
        spawn: async input => makeThreadResponse({ id: "created-chat", providerId: input.providerId }),
        get: async () => makeThreadResponse({ id: "created-chat", providerId: `acp-${JSON.parse(customAgents)[0].id}` }),
      },
    },
  });
  // Exercise the official host's temporary SQLite lifecycle, not a live DB.
  host.bb.storage.database().exec("CREATE TABLE regression_fixture (id INTEGER PRIMARY KEY)");
  return {
    ...host,
    readAdapter: () => ({ values: { customAgents } }),
    async dispose() {
      try { await host.harness.lifecycle.dispose(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
}

async function savedHost(overrides: Parameters<typeof makeThreadResponse>[0] = {}) {
  const host = createFakePluginHost({ pluginId: "letta-agents", settings: { dockerExecutable: "/nonexistent/letta-test", container: "letta" }, sdk: { threads: { get: async () => makeThreadResponse({ id: "saved-chat", providerId: "acp-letta-existing", ...overrides }) } } });
  await host.bb.storage.kv.set("roster:v2", { source: "/nonexistent/letta-test:letta", roster: { agents: [{ id: "agent-id", name: "Test", description: null, avatarVersion: 1 }], fetchedAt: Date.now() } });
  await host.bb.storage.kv.set("provider-source:v2", "/nonexistent/letta-test:letta:ws://127.0.0.1:4500");
  await host.bb.storage.kv.set("provider-identities:v2", { "agent-id": "letta-existing" });
  await host.bb.storage.kv.set("provider-aliases:v2", { "agent-id": ["acp-letta-existing"] });
  await host.bb.storage.kv.set("chat-id:agent-id", "saved-chat");
  await plugin(host.bb);
  // Join the non-blocking initial sync before disposing this fixture. Cached-chat
  // RPCs otherwise finish before execFile's ENOENT settles, racing abort at teardown.
  await host.harness.behavior.runSchedule("roster-refresh");
  return host;
}

test("successful spawn survives failed chat KV persistence and sequential retry creates only one thread", async () => {
  const host = await successfulHost();
  const { bb, harness } = host;
  const set = bb.storage.kv.set.bind(bb.storage.kv);
  try {
    await plugin(bb);
    await harness.behavior.runSchedule("roster-refresh");
    assert.equal(harness.inspection.logEntries.filter(entry => entry.level === "info").length, 1);
    let failures = 0;
    bb.storage.kv.set = async (key, value) => {
      if (key === "chat-id:agent-id" && failures++ === 0) throw new Error("injected KV failure after spawn");
      return set(key, value);
    };
    await assert.rejects(harness.behavior.callRpc("chat_start", { agentId: "agent-id" }));
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1);
    assert.equal(await bb.storage.kv.get("chat-id:agent-id"), undefined);
    // Deliberately sequential: the first single-flight promise has rejected.
    assert.deepEqual(await harness.behavior.callRpc("chat_start", { agentId: "agent-id" }), { threadId: "created-chat" });
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 1);
    assert.deepEqual(harness.inspection.sdk.callsTo("threads.get"), [[{ threadId: "created-chat" }]]);
    assert.equal(await bb.storage.kv.get("chat-id:agent-id"), "created-chat");
  } finally {
    bb.storage.kv.set = set;
    await host.dispose();
  }
});

test("generation change during second adapter read prevents stale ACP update and automatically resynchronizes", async () => {
  const host = await successfulHost();
  const { bb, harness } = host;
  const secondRead = gate(), releaseOld = gate(), newRead = gate(), releaseNew = gate();
  let reads = 0;
  harness.inspection.sdk.stub("plugins.getSettings", async () => {
    reads++;
    if (reads === 2) { secondRead.resolve(); await releaseOld.promise; }
    if (reads === 3) { newRead.resolve(); await releaseNew.promise; }
    return host.readAdapter();
  });
  try {
    await plugin(bb);
    const initial = harness.behavior.runSchedule("roster-refresh");
    await within(secondRead.promise);
    await harness.behavior.setSettings({ allowUnrestricted: true });
    releaseOld.resolve();
    await within(initial);
    // No RPC/schedule triggers the next generation: the settings listener must.
    await within(newRead.promise);
    assert.equal(harness.inspection.sdk.callsTo("plugins.updateSettings").length, 0);
    assert.equal(await bb.storage.kv.get("roster:v2"), undefined);
    assert.equal(harness.inspection.logEntries.filter(entry => entry.level === "info").length, 0);
    releaseNew.resolve();
    await harness.behavior.runSchedule("roster-refresh");
    assert.equal(harness.inspection.sdk.callsTo("plugins.updateSettings").length, 1);
    const entries = JSON.parse(host.readAdapter().values.customAgents);
    assert.equal(entries[0].env.LETTA_ACP_PERMISSION_MODE, "unrestricted");
    assert.equal((await harness.behavior.callRpc("agents_list", null) as { stale: boolean }).stale, false);
  } finally {
    releaseOld.resolve(); releaseNew.resolve();
    await harness.behavior.runSchedule("roster-refresh");
    await host.dispose();
  }
});

for (const pausedKey of ["provider-source:v2", "provider-identities:v2", "provider-aliases:v2", "roster:v2"]) {
  test(`generation change during ${pausedKey} write never marks old generation ready and automatically synchronizes again`, async () => {
    const host = await successfulHost();
    const { bb, harness } = host;
    const writeReached = gate(), releaseWrite = gate(), newRead = gate(), releaseNew = gate();
    const set = bb.storage.kv.set.bind(bb.storage.kv);
    const writes: string[] = [];
    let paused = false, reads = 0;
    bb.storage.kv.set = async (key, value) => {
      writes.push(key);
      await set(key, value);
      if (key === pausedKey && !paused) {
        paused = true; writeReached.resolve(); await releaseWrite.promise;
      }
    };
    harness.inspection.sdk.stub("plugins.getSettings", async () => {
      if (++reads === 3) { newRead.resolve(); await releaseNew.promise; }
      return host.readAdapter();
    });
    try {
      await plugin(bb);
      const initial = harness.behavior.runSchedule("roster-refresh");
      await within(writeReached.promise);
      const oldWrites = [...writes];
      await harness.behavior.setSettings({ allowUnrestricted: true });
      releaseWrite.resolve();
      await within(initial);
      await within(newRead.promise);
      // The in-flight write itself may land; no later old-generation KV writes
      // or successful-sync publication may follow it. The fresh sync is gated.
      assert.deepEqual(writes, oldWrites);
      assert.equal(harness.inspection.logEntries.filter(entry => entry.level === "info").length, 0);
      assert.equal(harness.inspection.sdk.callsTo("plugins.updateSettings").length, 1);
      assert.equal(JSON.parse(host.readAdapter().values.customAgents)[0].env.LETTA_ACP_PERMISSION_MODE, "standard");
      // If the old generation incorrectly set ready=true after the final KV
      // write, agents_list would return the cached roster instead of joining
      // the blocked new synchronization. Drain a turn without a timing sleep.
      let settled = false;
      const listing = harness.behavior.callRpc("agents_list", null).finally(() => { settled = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      const publishedWhileBlocked = settled;
      releaseNew.resolve();
      await harness.behavior.runSchedule("roster-refresh");
      await listing;
      assert.equal(publishedWhileBlocked, false, "old generation must not publish ready while fresh synchronization is blocked");
      assert.equal(harness.inspection.sdk.callsTo("plugins.updateSettings").length, 2);
      assert.equal(JSON.parse(host.readAdapter().values.customAgents)[0].env.LETTA_ACP_PERMISSION_MODE, "unrestricted");
      assert.equal(harness.inspection.logEntries.filter(entry => entry.level === "info").length, 1);
      const result = await harness.behavior.callRpc("agents_list", null) as { stale: boolean; warning: string | null };
      assert.equal(result.stale, false);
      assert.equal(result.warning, null);
    } finally {
      releaseWrite.resolve(); releaseNew.resolve();
      await harness.behavior.runSchedule("roster-refresh");
      bb.storage.kv.set = set;
      await host.dispose();
    }
  });
}

test("saved conversation resumes with failed synchronization and empty targets", async () => {
  const { harness } = await savedHost();
  try {
    assert.ok(harness.inspection.logEntries.some(entry => entry.level === "warn" && entry.message.startsWith("Letta container command failed.")));
    assert.deepEqual(await harness.behavior.callRpc("chat_start", { agentId: "agent-id" }), { threadId: "saved-chat" });
    assert.equal(harness.inspection.sdk.callsTo("threads.get").length, 1);
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
    assert.equal(harness.inspection.sdk.callsTo("plugins.getSettings").length, 0);
    assert.equal(harness.inspection.sdk.callsTo("plugins.updateSettings").length, 0);
  } finally { await harness.lifecycle.dispose(); }
});

for (const status of [{}, { archivedAt: "2026-01-01T00:00:00Z" }, { deletedAt: "2026-01-01T00:00:00Z" }]) {
  test(`foreign saved conversation rejects before replacement: ${JSON.stringify(status)}`, async () => {
    const { harness } = await savedHost({ providerId: "foreign", ...status });
    try {
      await assert.rejects(harness.behavior.callRpc("chat_start", { agentId: "agent-id" }), /belongs to another provider/);
      assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
    } finally { await harness.lifecycle.dispose(); }
  });
}

test("uncertain saved lookup never creates replacement", async () => {
  const { harness } = await savedHost();
  harness.inspection.sdk.stub("threads.get", async () => { throw new Error("private SDK failure"); });
  try {
    await assert.rejects(harness.behavior.callRpc("chat_start", { agentId: "agent-id" }), /Cannot verify the saved chat/);
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  } finally { await harness.lifecycle.dispose(); }
});

for (const key of ["roster:v2", "provider-source:v2"]) {
  test(`saved conversation cannot resume from a mismatched source: ${key}`, async () => {
    const { bb, harness } = await savedHost();
    try {
      if (key === "roster:v2") {
        const cached = await bb.storage.kv.get<{ source: string; roster: unknown }>(key);
        assert.ok(cached);
        await bb.storage.kv.set(key, { ...cached, source: "/different/source:letta" });
      } else {
        await bb.storage.kv.set(key, "/different/source:letta:ws://127.0.0.1:4500");
      }
      await assert.rejects(harness.behavior.callRpc("chat_start", { agentId: "agent-id" }), /Letta container command failed/);
      assert.equal(harness.inspection.sdk.callsTo("threads.get").length, 0);
      assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
      assert.equal(harness.inspection.sdk.callsTo("plugins.updateSettings").length, 0);
    } finally { await harness.lifecycle.dispose(); }
  });
}

test("cold subprocess failure rejects safely, preserves ACP configuration and never spawns", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "letta-agents", settings: { dockerExecutable: "/nonexistent/letta-test-SENSITIVE_SECRET", container: "letta" } });
  await plugin(bb);
  try {
    await assert.rejects(harness.behavior.callRpc("agents_list", null), (error: Error) => {
      assert.ok(error.message.includes("withheld")); assert.ok(!error.message.includes("SENSITIVE_SECRET")); return true;
    });
    await assert.rejects(harness.behavior.callRpc("chat_start", { agentId: "agent-id" }));
    assert.equal(harness.inspection.sdk.callsTo("plugins.updateSettings").length, 0);
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
    assert.deepEqual(await harness.behavior.callRpc("avatar_get", { agentId: "../secret", version: 1 }), {url:null});
  } finally { await harness.lifecycle.dispose(); }
});
