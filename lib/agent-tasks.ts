type TaskThread = {
  id: string;
  providerId: string;
  parentThreadId: string | null;
  lifecycleOwnerThreadId: string | null;
  originKind: "fork" | null;
  isArchived: boolean;
};
type TaskAgent = { id: string; providerId: string; providerIds?: string[] };

/** Follow explicit delegation ancestry, even when a child uses another provider.
 * Forks are conversations, not dispatched tasks. Cycles and missing parents fail open.
 */
export function agentTasks<T extends TaskThread>(agents: readonly TaskAgent[], threads: readonly T[]): Map<string, T[]> {
  const byId = new Map(threads.map(thread => [thread.id, thread]));
  const result = new Map(agents.map(agent => [agent.id, [] as T[]]));
  for (const thread of threads) {
    if (thread.isArchived) continue;
    const seen = new Set([thread.id]);
    let current = thread;
    while (true) {
      const parentId = current.lifecycleOwnerThreadId ?? (current.originKind !== "fork" ? current.parentThreadId : null);
      if (!parentId || seen.has(parentId)) break;
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      const agent = agents.find(agent => parent.providerId === agent.providerId || agent.providerIds?.includes(parent.providerId));
      if (agent) {
        result.get(agent.id)!.push(thread);
        break;
      }
      current = parent;
    }
  }
  return result;
}
