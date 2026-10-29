type Thread = { id: string; parentThreadId: string | null };

/** Build a forest from visible rows only. Missing parents become roots; break
 * malformed cycles deterministically so every conversation remains reachable. */
export function threadTree<T extends Thread>(threads: readonly T[]) {
  const byId = new Map(threads.map(thread => [thread.id, thread]));
  const parents = new Map(threads.map(thread => [thread.id,
    thread.parentThreadId !== thread.id && byId.has(thread.parentThreadId ?? "")
      ? thread.parentThreadId : null]));
  const done = new Set<string>();
  for (const thread of threads) {
    const path = new Set<string>();
    let id: string | null = thread.id;
    while (id !== null && !done.has(id)) {
      if (path.has(id)) { parents.set(id, null); break; }
      path.add(id);
      id = parents.get(id) ?? null;
    }
    for (const visited of path) done.add(visited);
  }
  const roots: T[] = [];
  const children = new Map<string, T[]>();
  for (const thread of threads) {
    const parent = parents.get(thread.id);
    if (parent == null) roots.push(thread);
    else {
      const siblings = children.get(parent) ?? [];
      siblings.push(thread);
      children.set(parent, siblings);
    }
  }
  return { roots, children, parents };
}

export function visibleThreadRows<T extends Thread>(roots: readonly T[], children: ReadonlyMap<string, readonly T[]>, expanded: ReadonlySet<string>) {
  const rows: { thread: T; depth: number }[] = [];
  const stack = roots.map(thread => ({ thread, depth: 0 })).reverse();
  while (stack.length) {
    const row = stack.pop()!;
    rows.push(row);
    if (expanded.has(row.thread.id)) {
      const descendants = children.get(row.thread.id) ?? [];
      for (let i = descendants.length - 1; i >= 0; i--) stack.push({ thread: descendants[i]!, depth: row.depth + 1 });
    }
  }
  return rows;
}

type Pinnable = { id: string; pinnedAt: number | null; pinSortKey: string | null; createdAt: number };

/**
 * bb's pinned order: a manual `pinSortKey` (lexicographic) when both rows have
 * one, then newest pin first, then newest thread, then id. The id tiebreak
 * keeps the order total, so re-renders never reshuffle equal rows.
 */
export function comparePinned(a: Pinnable, b: Pinnable): number {
  if (a.pinSortKey !== null && b.pinSortKey !== null) {
    const byKey = a.pinSortKey < b.pinSortKey ? -1 : a.pinSortKey > b.pinSortKey ? 1 : 0;
    if (byKey !== 0) return byKey;
  }
  const byPin = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
  if (byPin !== 0) return byPin;
  const byCreated = b.createdAt - a.createdAt;
  if (byCreated !== 0) return byCreated;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Partition tree roots into bb's Pinned section (ordered by `comparePinned`)
 * and everything else. Roots carry their descendants, so dropping a pinned
 * root from the ordinary list also drops its subtree: an unpinned child of a
 * pinned thread never reappears below its section.
 */
export function splitPinnedRoots<T extends Pinnable>(roots: readonly T[]) {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const root of roots) (root.pinnedAt === null ? rest : pinned).push(root);
  return { pinned: pinned.sort(comparePinned), rest };
}
