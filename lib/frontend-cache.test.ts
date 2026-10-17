import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the actual module-local pure cache/scheduler without loading BB/React.
function cache() {
  const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
  const start = source.indexOf("let rosterSnapshot:");
  const end = source.indexOf("/** Agent roster + optional avatars.");
  const code = ts.transpile(source.slice(start, end) + `
    globalThis.api = { requestAvatar, pumpAvatars, snapshotAvatars,
      roster: (rows) => { rosterSnapshot = rows; }, prune: (ids) => {
        for (const id of avatarCache.keys()) if (!ids.includes(id)) avatarCache.delete(id);
      }, size: () => avatarCache.size };`, { target: ts.ScriptTarget.ES2022 });
  const context: any = { Date: { now: () => context.now }, now: 0 };
  runInNewContext(code, context);
  return { api: context.api, context };
}
const agent = (id = "a", avatarVersion = 1) => ({ id, avatarVersion });

test("chat completion obeys latest intent, active navigation and synchronous per-agent dedupe", async () => {
  const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
  const callback = source.slice(source.indexOf("  const openAgentChat = useCallback("), source.indexOf("  const tasksByAgent = useMemo"));
  const calls: Array<{ id: string; resolve: (value: { threadId: string }) => void }> = [];
  const navigated: string[] = [];
  const context: any = {
    useCallback: (fn: unknown) => fn, mounted: { current: true }, pending: { current: new Set() },
    intent: { current: 0 }, active: { current: "original" }, setStarting: () => {}, setError: () => {},
    props: { activeThreadId: "original", onNavigate: () => {} },
    navigate: { toThread: (id: string) => navigated.push(id) },
    rpc: { call: (_: string, args: { agentId: string }) => new Promise(resolve => calls.push({ id: args.agentId, resolve })) },
  };
  runInNewContext(ts.transpile(callback + "globalThis.open = openAgentChat;", { target: ts.ScriptTarget.ES2022 }), context);
  const a = context.open(agent("a"));
  await context.open(agent("a"));
  const b = context.open(agent("b"));
  assert.equal(calls.length, 2);
  calls[1]!.resolve({ threadId: "b-chat" }); await b;
  calls[0]!.resolve({ threadId: "a-chat" }); await a;
  assert.deepEqual(navigated, ["b-chat"]);
  const manual = context.open(agent("a"));
  context.intent.current++; // Row/manual intent, even before active prop update.
  calls[2]!.resolve({ threadId: "a-chat" }); await manual;
  assert.deepEqual(navigated, ["b-chat"]);
  const external = context.open(agent("a"));
  context.active.current = "external";
  calls[3]!.resolve({ threadId: "a-chat" }); await external;
  assert.deepEqual(navigated, ["b-chat"]);
});

test("avatar successes cache by ID/version; null removes old image and retries after TTL", async () => {
  const { api, context } = cache();
  const row = agent();
  api.roster([row]);
  let reads = 0;
  const get = async () => { reads++; return { url: "image" }; };
  const first = api.requestAvatar(row, get); api.pumpAvatars(); await first;
  assert.equal(api.snapshotAvatars().a, "image");
  assert.equal(api.requestAvatar(row, get), undefined);
  assert.equal(reads, 1);
  const changed = agent("a", 2); api.roster([changed]);
  const second = api.requestAvatar(changed, async () => ({ url: null }));
  assert.equal(api.snapshotAvatars().a, undefined);
  api.pumpAvatars(); await second;
  assert.equal(api.snapshotAvatars().a, undefined);
  assert.equal(api.requestAvatar(changed, get), undefined);
  context.now = 30_001;
  const retry = api.requestAvatar(changed, get); api.pumpAvatars(); await retry;
  assert.equal(api.snapshotAvatars().a, "image");
  api.prune([]); api.roster([]);
  assert.equal(api.size(), 0);
  assert.equal(Object.keys(api.snapshotAvatars()).length, 0);
});

test("four-worker scheduling deduplicates slow jobs across repeated polls and caches failures briefly", async () => {
  const { api, context } = cache();
  let active = 0, peak = 0, reads = 0;
  const releases: Array<() => void> = [];
  const rows = Array.from({ length: 12 }, (_, i) => agent(String(i)));
  const get = () => { reads++; active++; peak = Math.max(peak, active); return new Promise(resolve => {
    releases.push(() => { active--; resolve({ url: "image" }); });
  }); };
  const jobs = rows.map(row => api.requestAvatar(row, get)); api.pumpAvatars();
  for (let poll = 0; poll < 10; poll++) {
    rows.forEach((row, i) => assert.equal(api.requestAvatar(row, get), jobs[i]));
    api.pumpAvatars();
  }
  assert.equal(reads, 4);
  for (let batch = 0; batch < 3; batch++) {
    releases.splice(0).forEach(release => release());
    await new Promise(resolve => setImmediate(resolve));
  }
  await Promise.all(jobs);
  assert.equal(reads, 12); assert.equal(peak, 4);
  const bad = agent("bad");
  const failed = api.requestAvatar(bad, async () => { throw new Error("offline"); });
  api.pumpAvatars(); await failed;
  assert.equal(api.requestAvatar(bad, get), undefined);
  context.now = 30_001;
  assert.ok(api.requestAvatar(bad, get));
});
