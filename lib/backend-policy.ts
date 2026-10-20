import { createHash } from "node:crypto";

export type AgentRecord = { id: string; name: string; description: string | null; avatarVersion: number };
export type CustomAgent = { id: string; displayName?: string; env?: Record<string, string>; [key: string]: unknown };
export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export const stableId = (id: string) => `letta-id-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
export function validContainer(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) throw new Error("Invalid Docker container name.");
  return value;
}
export function validAgentId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value)) throw new Error("Invalid Letta agent ID.");
  return value;
}
/**
 * A stored BB thread reference. The saved-chat keys are plugin KV rows, i.e.
 * mutable state on disk, and the value crosses into the RPC boundary and then
 * into a link the sidebar matches against live thread IDs. A malformed or stale
 * value must never be able to widen a dot's scope, so it is constrained here
 * and dropped (not thrown) at the call site.
 *
 * Single source for the pattern: the RPC contract validates against it and
 * validThreadId coerces with it, so the boundary and the resolver cannot drift.
 */
export const THREAD_ID_PATTERN = /^thr_[a-z0-9]{6,64}$/;
export function validThreadId(value: string): string | null {
  return THREAD_ID_PATTERN.test(value) ? value : null;
}
export function validEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid Letta WebSocket URL."); }
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error("Use a ws:// or wss:// URL without credentials, query or fragment.");
  return value;
}
/** Preserve established providers by immutable backend ID, never by display name alone. */
export function identities(agents: AgentRecord[], current: CustomAgent[], saved: Record<string, string>, endpoint?: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  const used = new Set<string>();
  for (const agent of agents) {
    validAgentId(agent.id);
    if (Object.hasOwn(result, agent.id)) throw new Error("Duplicate agent ID in roster.");
    const matches = current.filter(entry => entry.id.startsWith("letta-") && entry.env?.LETTA_AGENT_ID === agent.id && entry.env?.LETTA_ACP_BACKEND === "remote");
    if (matches.length > 1) throw new Error("Duplicate Letta providers; resolve aliases before synchronization.");
    if (endpoint && matches.some(entry => entry.env?.LETTA_APP_SERVER_URL !== endpoint)) throw new Error("Provider endpoint differs; explicit migration required.");
    const stored = Object.hasOwn(saved, agent.id) ? saved[agent.id] : undefined;
    if (stored !== undefined && (typeof stored !== "string" || !/^letta-[a-zA-Z0-9_-]{1,199}$/.test(stored))) throw new Error("Invalid Letta saved provider identity.");
    if (stored && matches[0] && stored !== matches[0].id) throw new Error("Provider identity differs; explicit migration required.");
    const id = stored ?? matches[0]?.id ?? stableId(agent.id);
    if (used.has(id)) throw new Error("Provider identity collision; sync stopped.");
    if (current.some(entry => entry.id === id && entry.env?.LETTA_AGENT_ID !== agent.id)) throw new Error("Provider ID belongs to another agent; sync stopped.");
    used.add(id); result[agent.id] = id;
  }
  return result;
}
/** Do not delete absent agents automatically: transient/incomplete rosters must not destroy providers. */
export function mergeProviders(current: CustomAgent[], desired: CustomAgent[], owned: Set<string>): CustomAgent[] {
  const replacements = new Map(desired.map(entry => [entry.id, entry]));
  for (const entry of desired) if (current.some(old => old.id === entry.id) && !owned.has(entry.id)) throw new Error("Refusing to overwrite an unowned ACP provider.");
  const result = current.map(entry => {
    const replacement = replacements.get(entry.id);
    return replacement ? { ...entry, ...replacement, env: { ...entry.env, ...replacement.env } } : entry;
  });
  const existing = new Set(current.map(entry => entry.id));
  return [...result, ...desired.filter(entry => !existing.has(entry.id))];
}
export function singleFlight<K, V>(work: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const pending = new Map<K, Promise<V>>();
  return key => {
    const existing = pending.get(key); if (existing) return existing;
    const promise = Promise.resolve().then(() => work(key)).finally(() => pending.delete(key));
    pending.set(key, promise); return promise;
  };
}
