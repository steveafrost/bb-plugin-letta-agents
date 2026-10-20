type PresenceThread = { id: string; providerId: string; isArchived: boolean };
type PresenceAgent = { chatThreadId: string | null; providerId: string; providerIds?: string[] };

function ownsProvider(agent: PresenceAgent, thread: PresenceThread): boolean {
  return thread.providerId === agent.providerId || (agent.providerIds?.includes(thread.providerId) ?? false);
}

/**
 * The threads allowed to drive an agent row's status dot: the agent's saved
 * chat — the exact thread clicking the row opens — plus the dispatched tasks
 * nested beneath it.
 *
 * Deliberately narrower than "every thread on the agent's provider". The
 * sidebar renders only the saved chat and its tasks, so a provider-owned
 * thread that is neither is invisible: its unread/working indicator would
 * show as a dot with no row to click and clear it.
 *
 * The saved chat must still pass the same ownership test a task does. A
 * `chatThreadId` that survived a provider migration, or points at a thread
 * that is missing from this list, earns no dot rather than silently widening
 * the scope back to provider identity.
 */
export function presenceThreads<T extends PresenceThread>(
  agent: PresenceAgent,
  threads: readonly T[],
  taskIds: ReadonlySet<string> | undefined,
): T[] {
  return threads.filter(thread => {
    if (thread.isArchived) return false;
    if (taskIds?.has(thread.id)) return true;
    return thread.id === agent.chatThreadId && ownsProvider(agent, thread);
  });
}
