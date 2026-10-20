type PresenceThread = { id: string; isArchived: boolean };
type PresenceAgent = { chatThreadId: string | null };

/**
 * The threads allowed to drive an agent row's status dot: the agent's saved
 * chat — the exact thread clicking the row opens — plus the dispatched tasks
 * nested beneath it.
 *
 * Deliberately narrower than "every thread on the agent's provider". The
 * sidebar renders only the saved chat and its tasks, so a provider-owned
 * thread that is neither is invisible: its unread/working indicator would
 * show as a dot with no row to click and clear it. Provider identity is not
 * re-checked here because a saved chat may legitimately run on an aliased
 * provider after a migration.
 */
export function presenceThreads<T extends PresenceThread>(
  agent: PresenceAgent,
  threads: readonly T[],
  taskIds: ReadonlySet<string> | undefined,
): T[] {
  return threads.filter(thread =>
    !thread.isArchived && (thread.id === agent.chatThreadId || (taskIds?.has(thread.id) ?? false)),
  );
}
