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
