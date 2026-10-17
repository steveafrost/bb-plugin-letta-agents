import test from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

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
