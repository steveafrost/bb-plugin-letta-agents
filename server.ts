import { execFile } from "node:child_process";
import { delimiter, dirname } from "node:path";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { identities, mergeProviders, singleFlight, slug, THREAD_ID_PATTERN, validAgentId, validContainer, validEndpoint, validThreadId, type AgentRecord, type CustomAgent } from "./lib/backend-policy.ts";
const execute = promisify(execFile);
const agentSchema = z.object({ id: z.string(), name: z.string().min(1), description: z.string().nullable().default(null), avatarVersion: z.number().int().default(1) });
const rosterSchema = z.object({ agents: z.array(agentSchema).max(500), fetchedAt: z.number() });
type Roster = z.infer<typeof rosterSchema>;
const customSchema = z.array(z.object({ id: z.string(), env: z.record(z.string(), z.string()).optional() }).passthrough());
export const rpcContract = defineRpcContract({
  // chatThreadId is the saved conversation the agent row opens; the sidebar uses
  // it to scope the row's status dot to threads it actually renders. The pattern
  // keeps a stale or hand-edited KV value from crossing the RPC boundary at all;
  // a value that does not match is reported as null, never as a wildcard.
  agents_list: { input: z.null(), output: z.object({ agents: z.array(z.object({ id: z.string(), name: z.string(), providerId: z.string(), providerIds: z.array(z.string()), description: z.string(), avatarVersion: z.number().int(), chatThreadId: z.string().regex(THREAD_ID_PATTERN).nullable() })), stale: z.boolean(), warning: z.string().nullable() }) },
  avatar_get: { input: z.object({ agentId: z.string(), version: z.number().int() }), output: z.object({ url: z.string().nullable() }) },
  chat_start: { input: z.object({ agentId: z.string() }), output: z.object({ threadId: z.string() }) },
});
// Fixed script: no configuration or roster values are ever inserted into shell source.
const ROSTER_SCRIPT = 'const fs=require("fs");const p="/root/.letta/lc-local-backend/agents";process.stdout.write(JSON.stringify(fs.readdirSync(p).filter(x=>x.endsWith(".json")).map(x=>JSON.parse(fs.readFileSync(p+"/"+x,"utf8")))));';
export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    appServerUrl: { type: "string", label: "Letta app-server URL", description: "Reachable from the ACP execution host. Use wss:// outside a trusted local network.", default: "ws://127.0.0.1:4500" },
    container: { type: "string", label: "Letta container", description: "Local Docker container running letta-code. Docker and Node in the container are required.", default: "letta" },
    dockerExecutable: { type: "string", label: "Docker executable", description: "Executable name on PATH or absolute path; not a shell command.", default: "docker" },
    projectId: { type: "string", label: "Chat project ID", description: "Required. Select an existing BB project using bb project list.", default: "" },
    hostId: { type: "string", label: "Chat host ID", description: "Required. Existing host for the workspace and ACP process.", default: "" },
    environmentProviderId: { type: "string", label: "Workspace provider ID", description: "Required. Installed environment provider; e.g. personal-workspace where installed.", default: "" },
    allowUnrestricted: { type: "boolean", label: "Allow unrestricted agent tools", description: "Opt-in: grants full BB permissions and unrestricted Letta tool execution. Off uses standard approvals. Existing sessions keep their current permissions.", default: false },
    showAgentsInProviderPicker: { type: "boolean", label: "Show agents in provider picker", description: "UI-only. Providers remain enabled for the Bots sidebar.", default: false },
  });
  let disposed = false;
  let generation = 0;
  let lastSync = 0;
  let warning: string | null = null;
  let ready = false;
  const controllers = new Set<AbortController>();
  // Retain successful creations across transient KV failures (within this runtime).
  const pendingChats = new Map<string, string>();
  async function docker(args: string[], binary = false): Promise<Buffer> {
    const config = await settings.get();
    const executable = config.dockerExecutable.trim();
    if (!executable || executable.startsWith("-") || /[\r\n\0]/.test(executable)) throw new Error("Configure a Docker executable, not a shell command.");
    const controller = new AbortController(); controllers.add(controller);
    if (disposed) controller.abort();
    try {
      const result = await execute(executable, ["exec", validContainer(config.container), ...args], { timeout: 20_000, maxBuffer: binary ? 1024 * 1024 : 2 * 1024 * 1024, encoding: "buffer", signal: controller.signal, env: { ...process.env, PATH: [dirname(process.execPath), process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter) } });
      return result.stdout;
    } catch { throw new Error("Letta container command failed. Check Docker, container access and required files. Command output is withheld to protect credentials."); }
    finally { controllers.delete(controller); }
  }
  async function cachedRoster(): Promise<Roster | null> {
    const config = await settings.get();
    const cached = await bb.storage.kv.get<{ source: string; roster: Roster }>("roster:v2");
    if (cached?.source !== `${config.dockerExecutable}:${config.container}`) return null;
    const parsed = rosterSchema.safeParse(cached.roster); return parsed.success ? parsed.data : null;
  }
  async function adapterEntries(): Promise<CustomAgent[]> {
    const result = await bb.sdk.plugins.getSettings({ pluginId: "bb--provider-acp-next" });
    const value = result.values.customAgents;
    return customSchema.parse(typeof value === "string" ? JSON.parse(value || "[]") : value ?? []) as CustomAgent[];
  }
  const refresh = singleFlight(async (_key: string): Promise<Roster> => {
    const epoch = generation;
    ready = false;
    try {
      const config = await settings.get();
      validEndpoint(config.appServerUrl);
      const agents = rosterSchema.shape.agents.parse(JSON.parse((await docker(["node", "-e", ROSTER_SCRIPT])).toString("utf8")));
      const roster: Roster = { agents, fetchedAt: Date.now() };
      const token = (await docker(["cat", "/root/.letta/app-server.token"])).toString("utf8").trim();
      if (!token || /[\r\n\0]/.test(token)) throw new Error("Letta token is empty or malformed.");
      const current = await adapterEntries();
      const saved = await bb.storage.kv.get<Record<string, string>>("provider-identities:v2") ?? {};
      const source = `${config.dockerExecutable}:${config.container}:${config.appServerUrl}`;
      const previousSource = await bb.storage.kv.get<string>("provider-source:v2");
      if (previousSource && previousSource !== source) throw new Error("Provider source differs; explicit migration required.");
      const ids = identities(agents, current, saved, config.appServerUrl);
      const desired = agents.map(agent => ({ id: ids[agent.id]!, displayName: agent.name, command: "npx", args: ["-y", "@letta-ai/letta-acp@0.1.10"], env: { LETTA_ACP_BACKEND: "remote", LETTA_APP_SERVER_URL: config.appServerUrl, LETTA_AGENT_ID: agent.id, LETTA_APP_SERVER_TOKEN: token, LETTA_ACP_PERMISSION_MODE: config.allowUnrestricted ? "unrestricted" : "standard" } }));
      const owned = new Set(current.filter(entry => entry.id.startsWith("letta-") && entry.env?.LETTA_ACP_BACKEND === "remote" && agents.some(agent => agent.id === entry.env?.LETTA_AGENT_ID)).map(entry => entry.id));
      // Absent providers remain untouched, including permissions; explicit cleanup
      // is required for retained unrestricted entries (see README).
      const next = mergeProviders(current, desired, owned);
      if (epoch !== generation || disposed) throw new Error("Settings changed; retry roster synchronization.");
      // Re-read immediately before writing. The public API has no CAS; do not
      // overwrite a concurrent adapter edit detected during this synchronization.
      if (JSON.stringify(await adapterEntries()) !== JSON.stringify(current)) throw new Error("ACP settings changed during sync; retry.");
      if (epoch !== generation || disposed) throw new Error("Settings changed; retry roster synchronization.");
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        try { await bb.sdk.plugins.updateSettings({ pluginId: "bb--provider-acp-next", values: { customAgents: JSON.stringify(next) } }); }
        catch { throw new Error("Unable to update ACP settings. Details withheld to protect credentials."); }
      }
      if (epoch !== generation || disposed) throw new Error("Settings changed; retry roster synchronization.");
      await bb.storage.kv.set("provider-source:v2", source);
      if (epoch !== generation || disposed) throw new Error("Settings changed; retry roster synchronization.");
      await bb.storage.kv.set("provider-identities:v2", { ...saved, ...ids });
      if (epoch !== generation || disposed) throw new Error("Settings changed; retry roster synchronization.");
      await bb.storage.kv.set("provider-aliases:v2", Object.fromEntries(agents.map(agent => [agent.id, [...new Set([`acp-${ids[agent.id]}`, ...current.filter(entry => entry.id.startsWith("letta-") && entry.env?.LETTA_AGENT_ID === agent.id && entry.env?.LETTA_ACP_BACKEND === "remote").map(entry => `acp-${entry.id}`)])]])));
      if (epoch !== generation || disposed) throw new Error("Settings changed; retry roster synchronization.");
      await bb.storage.kv.set("roster:v2", { source: `${config.dockerExecutable}:${config.container}`, roster });
      if (epoch !== generation || disposed) throw new Error("Settings changed; retry roster synchronization.");
      ready = true; warning = null; lastSync = Date.now();
      bb.log.info(`Synchronized ${agents.length} Letta providers; unrelated ACP entries preserved.`);
      return roster;
    } catch (error) {
      warning = safeError(error);
      bb.log.warn(warning);
      throw new Error(warning);
    }
  });
  // Never surface arbitrary SDK/subprocess exception text: it may include settings.
  function safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : "";
    const safePrefixes = ["Letta container command failed.", "Letta token is empty", "Settings changed;", "ACP settings changed", "Unable to update ACP settings.", "Provider identity collision", "Provider identity differs;", "Provider ID belongs", "Refusing to overwrite", "Duplicate agent ID", "Duplicate Letta providers;", "Provider endpoint differs;", "Provider source differs;", "Invalid Letta", "Invalid Docker", "Use a ws://", "Configure a Docker"];
    return safePrefixes.some(prefix => message.startsWith(prefix)) ? message : "Letta synchronization failed. Check the ACP adapter, endpoint configuration and roster format. Details withheld.";
  }
  async function roster(): Promise<Roster> {
    const cached = await cachedRoster();
    if (!ready || !cached || Date.now() - lastSync > 60_000) return refresh("sync");
    return cached;
  }
  // The saved conversation for one agent: the current reference first, then the
  // two historical name-based keys. Shared by chat_start and agents_list so the
  // sidebar's dot scopes to the same thread a click opens.
  //
  // This resolves the pointer only. chat_start treats it as a claim: it loads the
  // thread and rejects a provider mismatch before resuming. agents_list skips that
  // per-agent SDK lookup on every poll, so it reports providerIds with the id and
  // presenceThreads re-checks ownership before drawing a dot.
  async function savedChatId(agent: AgentRecord, ids: Record<string, string>, rosterAgents: AgentRecord[]): Promise<string | undefined> {
    const pending = pendingChats.get(agent.id);
    if (pending) return pending;
    const current = await bb.storage.kv.get<string>(`chat-id:${agent.id}`);
    if (current) return current;
    const byIdentity = await bb.storage.kv.get<string>(`chat:${ids[agent.id]}`);
    if (byIdentity) return byIdentity;
    return rosterAgents.filter(other => slug(other.name) === slug(agent.name)).length === 1
      ? await bb.storage.kv.get<string>(`chat:letta-${slug(agent.name)}`)
      : undefined;
  }
  const startChat = singleFlight(async (rawId: string) => {
    const epoch = generation;
    const config = await settings.get();
    const source = `${config.dockerExecutable}:${config.container}:${config.appServerUrl}`;
    // Resuming a verified conversation must not depend on Docker/ACP availability.
    // Cached display data is usable only for its previously synchronized source.
    let current = await cachedRoster();
    const savedSource = await bb.storage.kv.get<string>("provider-source:v2");
    if (!current || savedSource !== source) current = await roster();
    if (epoch !== generation || disposed) throw new Error("Settings changed; retry roster synchronization.");
    const matches = current.agents.filter(agent => agent.id === rawId);
    if (matches.length !== 1) throw new Error("Agent is missing or ambiguous. Refresh the roster.");
    const agent = matches[0]!;
    const ids = await bb.storage.kv.get<Record<string, string>>("provider-identities:v2") ?? {};
    const identity = Object.hasOwn(ids, agent.id) ? ids[agent.id] : undefined;
    if (typeof identity !== "string" || !/^letta-[a-zA-Z0-9_-]{1,199}$/.test(identity)) throw new Error("Invalid Letta saved provider identity.");
    const providerId = `acp-${identity}`;
    const key = `chat-id:${agent.id}`;
    const existing = await savedChatId(agent, ids, current.agents);
    if (existing) {
      // Transport/auth/not-found errors do NOT imply deletion. Surface a safe
      // error rather than spawning a duplicate on an uncertain lookup.
      let thread;
      try { thread = await bb.sdk.threads.get({ threadId: existing }); }
      catch { throw new Error("Cannot verify the saved chat. Retry later; no duplicate chat was created."); }
      const aliases = await bb.storage.kv.get<Record<string, string[]>>("provider-aliases:v2") ?? {};
      const accepted = Object.hasOwn(aliases, agent.id) ? aliases[agent.id] : [providerId];
      if (!Array.isArray(accepted) || !accepted.includes(thread.providerId)) throw new Error("Saved chat belongs to another provider. No replacement was created.");
      if (epoch !== generation || disposed) throw new Error("Settings changed; retry roster synchronization.");
      if (!thread.archivedAt && !thread.deletedAt) {
        pendingChats.set(agent.id, thread.id);
        await bb.storage.kv.set(key, thread.id); pendingChats.delete(agent.id);
        return { threadId: thread.id };
      }
    }
    // New/replacement chats still require successful current-generation synchronization.
    await roster();
    if (epoch !== generation || disposed) throw new Error("Settings changed; retry roster synchronization.");
    if (!config.projectId || !config.hostId || !config.environmentProviderId) throw new Error("Configure chat project ID, host ID and workspace provider ID in Letta Agents settings before starting a chat.");
    const providers = await bb.sdk.providers.list({ hostId: config.hostId });
    if (!providers.some(provider => provider.id === providerId && provider.available)) throw new Error("Letta provider is not available yet. Enable the ACP adapter/provider and retry.");
    if (epoch !== generation || disposed) throw new Error("Settings changed; retry roster synchronization.");
    let thread;
    try {
      thread = await bb.sdk.threads.spawn({ providerId, permissionMode: config.allowUnrestricted ? "full" : "auto", projectId: config.projectId, title: `${agent.name} (Letta)`, environment: { type: "provider", environmentProviderId: config.environmentProviderId, inputs: {}, machine: { type: "existing", hostId: config.hostId } }, prompt: "Say hello and briefly remind me what you do." });
    } catch { throw new Error("Could not start the Letta chat. Check project, host, workspace provider and ACP readiness. Details withheld."); }
    pendingChats.set(agent.id, thread.id);
    await bb.storage.kv.set(key, thread.id);
    pendingChats.delete(agent.id);
    return { threadId: thread.id };
  });
  bb.rpc.register(rpcContract, {
    agents_list: async () => {
      let value: Roster;
      try { value = await roster(); } catch { const cached = await cachedRoster(); if (!cached) throw new Error(warning ?? "Letta is not ready. Check settings and retry."); value = cached; }
      const ids = await bb.storage.kv.get<Record<string, string>>("provider-identities:v2") ?? {};
      const aliases = await bb.storage.kv.get<Record<string, string[]>>("provider-aliases:v2") ?? {};
      // Resolve each agent's saved chat exactly as chat_start does, so a row's dot
      // can be scoped to the thread clicking it opens.
      const chats = await Promise.all(value.agents.map(agent => savedChatId(agent, ids, value.agents)));
      return { agents: value.agents.map((agent, index) => ({ id: agent.id, name: agent.name, providerId: `acp-${ids[agent.id]}`, providerIds: aliases[agent.id] ?? [`acp-${ids[agent.id]}`], description: agent.description ?? "", avatarVersion: agent.avatarVersion, chatThreadId: validThreadId(chats[index] ?? "") })), stale: !ready, warning };
    },
    avatar_get: async ({ agentId }) => {
      try {
        const value = await cachedRoster();
        const agent = value?.agents.find(agent => agent.id === agentId);
        if (!agent) return { url: null };
        const bytes = await docker(["cat", `/root/.letta/lc-local-backend/avatars/${validAgentId(agent.id)}-128.png`], true);
        if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return { url: null };
        return { url: `data:image/png;base64,${bytes.toString("base64")}` };
      } catch { return { url: null }; }
    },
    chat_start: ({ agentId }) => startChat(agentId),
  });
  bb.background.schedule("roster-refresh", "*/5 * * * *", async () => { try { await refresh("sync"); } catch { /* stale roster retained; safe warning already logged */ } });
  settings.onChange((next, prev) => {
    if (["container", "dockerExecutable", "appServerUrl", "allowUnrestricted", "projectId", "hostId", "environmentProviderId"].some(key => next[key as keyof typeof next] !== prev[key as keyof typeof prev])) {
      generation++; ready = false; lastSync = 0;
      const requested = generation;
      void refresh("sync").catch(() => {}).finally(() => {
        // A settings event can join old in-flight work. Run again after it settles.
        if (generation >= requested && !ready && !disposed) void refresh("sync").catch(() => {});
      });
    }
  });
  bb.onDispose(() => { disposed = true; generation++; for (const controller of controllers) controller.abort(); });
  // Initial sync is non-blocking so unavailable Docker never prevents settings/RPC loading.
  void refresh("sync").catch(() => {});
}
