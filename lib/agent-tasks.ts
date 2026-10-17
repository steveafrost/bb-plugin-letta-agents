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
  const byProvider = new Map<string, string>();
  for (const agent of agents) {
    for (const provider of [agent.providerId, ...(agent.providerIds ?? [])]) {
      // Preserve roster-order precedence for overlapping aliases.
      if (!byProvider.has(provider)) byProvider.set(provider, agent.id);
    }
  }
  const parentId = (thread: T) => thread.lifecycleOwnerThreadId ?? (thread.originKind !== "fork" ? thread.parentThreadId : null);
  type Owner = { agentId: string; threadId: string } | null;
  const memo = new Map<string, Owner>();
  // Inclusive nearest owner, memoized iteratively to avoid deep-chain stack growth.
  const ownerOf = (id: string): Owner => {
    const path: string[] = [];
    const seen = new Set<string>();
    let current: string | null = id;
    let owner: Owner = null;
    while (current !== null) {
      if (memo.has(current)) { owner = memo.get(current)!; break; }
      if (seen.has(current)) break;
      const row = byId.get(current);
      if (!row) break;
      seen.add(current);
      path.push(current);
      const agentId = byProvider.get(row.providerId);
      if (agentId !== undefined) { owner = { agentId, threadId: row.id }; break; }
      current = parentId(row);
    }
    for (const visited of path) memo.set(visited, owner);
    return owner;
  };
  for (const thread of threads) {
    if (thread.isArchived) continue;
    const parent = parentId(thread);
    if (parent === null) continue;
    const owner = ownerOf(parent);
    // A traversal returning to its candidate must stop before counting itself.
    if (owner && owner.threadId !== thread.id) result.get(owner.agentId)!.push(thread);
  }
  return result;
}
