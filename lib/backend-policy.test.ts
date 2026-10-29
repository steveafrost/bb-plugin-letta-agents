import test from "node:test";
import assert from "node:assert/strict";
import { identities, mergeProviders, parseStringArray, singleFlight, stableId, validAcpCommand, validAgentId, validContainer, validEndpoint } from "./backend-policy.ts";
const agent = (id: string, name = "same") => ({ id, name, description: null, avatarVersion: 1 });
const legacy = { id: "letta-old", env: { LETTA_AGENT_ID: "agent-1", LETTA_ACP_BACKEND: "remote" } };
test("container and agent command arguments reject shell syntax and options", () => {
  for (const value of ["; touch /tmp/x", "$(id)", "-it", "x\ny", "../foo"]) {
    assert.throws(() => validContainer(value)); assert.throws(() => validAgentId(value));
  }
  assert.equal(validContainer("letta-code_1"), "letta-code_1");
});
test("endpoint accepts only credential-free websocket URLs", () => {
  assert.equal(validEndpoint("wss://example.test:4500"), "wss://example.test:4500");
  for (const value of ["https://example.test", "ws://user:secret@host", "ws://host?token=secret", "bad"]) assert.throws(() => validEndpoint(value));
});
test("identity survives rename; duplicate names have distinct immutable IDs", () => {
  assert.equal(identities([agent("agent-1", "renamed")], [legacy], {})["agent-1"], "letta-old");
  const ids = identities([agent("agent-1"), agent("agent-2")], [], {});
  assert.notEqual(ids["agent-1"], ids["agent-2"]);
  assert.equal(ids["agent-1"], stableId("agent-1"));
  assert.equal(identities([agent("agent-1", "again")], [], ids)["agent-1"], ids["agent-1"]);
});
test("duplicate IDs and ownership collisions stop synchronization", () => {
  assert.throws(() => identities([agent("agent-1"), agent("agent-1")], [], {}));
  assert.throws(() => identities([agent("agent-1")], [{ id: "reserved" }], { "agent-1": "reserved" }));
});
test("duplicate aliases and foreign endpoints block provider adoption", () => {
  const endpoint = "ws://example.test:4500";
  const owned = { ...legacy, env: { ...legacy.env, LETTA_APP_SERVER_URL: endpoint } };
  assert.equal(identities([agent("agent-1")], [owned], {}, endpoint)["agent-1"], legacy.id);
  assert.throws(() => identities([agent("agent-1")], [owned, { ...owned, id: "letta-duplicate" }], {}, endpoint), /Duplicate Letta providers/);
  assert.throws(() => identities([agent("agent-1")], [owned], {}, "ws://other.test:4500"), /Provider endpoint differs/);
});
test("merge preserves unrelated and missing agents including order and opaque fields", () => {
  const other = { id: "omp", displayName: "OMP", command: "omp", extra: { preserve: true } };
  const absent = { id: "letta-absent", env: { LETTA_AGENT_ID: "agent-absent" } };
  const next = { ...legacy, displayName: "Renamed" };
  const merged = mergeProviders([other, legacy, absent], [next], new Set([legacy.id]));
  assert.deepEqual(merged, [other, next, absent]); assert.equal(merged[0], other);
  assert.throws(() => mergeProviders([other], [{ id: "omp", command: "bad" }], new Set()));
});
test("single flight shares simultaneous chats and releases lock on success/error", async () => {
  let calls = 0;
  const work = singleFlight(async (id: string) => { calls++; await new Promise(resolve => setImmediate(resolve)); if (id === "bad") throw new Error("failure"); return id; });
  assert.deepEqual(await Promise.all([work("agent"), work("agent"), work("other")]), ["agent", "agent", "other"]); assert.equal(calls, 2);
  await work("agent"); assert.equal(calls, 3);
  await assert.rejects(work("bad")); await assert.rejects(work("bad")); assert.equal(calls, 5);
});

test("saved identities ignore inherited properties and validate own values", () => {
  for (const id of ["constructor", "toString", "hasOwnProperty"]) {
    const ids = identities([agent(id)], [], {});
    assert.equal(ids[id], stableId(id));
    assert.equal(JSON.parse(JSON.stringify(ids))[id], stableId(id));
  }
  for (const value of [null, 123, {}, "", "foreign", "letta- bad"]) {
    assert.throws(() => identities([agent("agent-1")], [], { "agent-1": value } as any), /Invalid Letta saved provider identity/);
  }
  assert.equal(identities([agent("agent-1")], [], { "agent-1": "letta-established" })["agent-1"], "letta-established");
});
test("saved identity disagreement requires explicit migration", () => {
  assert.throws(() => identities([agent("agent-1")], [legacy], { "agent-1": "letta-established" }), /Provider identity differs/);
});
test("updated providers retain opaque settings and environment fields", () => {
  const original = { ...legacy, opaque: { keep: true }, env: { ...legacy.env, CUSTOM: "keep" } };
  const merged = mergeProviders([original], [{ ...legacy, displayName: "New" }], new Set([legacy.id]));
  assert.deepEqual(merged[0], { ...original, displayName: "New" });
});

test("ACP argument settings parse only as JSON arrays of usable strings", () => {
  assert.deepEqual(parseStringArray("", "ACP agent arguments"), []);
  assert.deepEqual(parseStringArray("   ", "ACP agent arguments"), []);
  assert.deepEqual(parseStringArray('["-y","@letta-ai/letta-acp@0.1.10"]', "ACP agent arguments"), ["-y", "@letta-ai/letta-acp@0.1.10"]);
  // Not JSON, not an array, or an array holding anything unusable all fail closed
  // with the same stable prefix, so safeError can surface it without leaking.
  const invalid = ["npx", "{}", '"a"', "[null]", "[1]", '[""]', '["a\\u0000b"]', '["a\\nb"]', "["];
  for (const value of invalid) {
    assert.throws(() => parseStringArray(value, "ACP agent arguments"), (error: Error) => {
      assert.ok(error.message.startsWith("Invalid ACP setting: ACP agent arguments "), `unexpected message: ${error.message}`);
      return true;
    });
  }
});
test("ACP command rejects empty values and control characters", () => {
  assert.equal(validAcpCommand(" npx "), "npx");
  assert.equal(validAcpCommand("/usr/local/bin/letta-acp"), "/usr/local/bin/letta-acp");
  for (const value of ["", "   ", "npx\nrm -rf /", "npx\u0000"]) {
    assert.throws(() => validAcpCommand(value), (error: Error) => error.message.startsWith("Invalid ACP setting: the ACP agent command "));
  }
});
