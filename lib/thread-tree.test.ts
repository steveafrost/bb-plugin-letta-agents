import { test } from "node:test";
import assert from "node:assert/strict";
import { splitPinnedRoots, threadTree, visibleThreadRows } from "./thread-tree.ts";
const row = (id: string, parentThreadId: string | null = null) => ({ id, parentThreadId });

test("children and grandchildren nest regardless of input order", () => {
  const tree = threadTree([row("grandchild", "child"), row("root"), row("child", "root"), row("other")]);
  assert.deepEqual(tree.roots.map(t => t.id), ["root", "other"]);
  assert.deepEqual(visibleThreadRows(tree.roots, tree.children, new Set(["root", "child"])).map(r => [r.thread.id, r.depth]), [["root", 0], ["child", 1], ["grandchild", 2], ["other", 0]]);
});
test("collapse hides descendants while retaining independent child disclosure", () => {
  const tree = threadTree([row("root"), row("child", "root"), row("grandchild", "child")]);
  const ids = (expanded: string[]) => visibleThreadRows(tree.roots, tree.children, new Set(expanded)).map(r => r.thread.id);
  assert.deepEqual(ids([]), ["root"]);
  assert.deepEqual(ids(["root"]), ["root", "child"]);
  assert.deepEqual(ids(["child"]), ["root"]);
  assert.deepEqual(ids(["root", "child"]), ["root", "child", "grandchild"]);
});
test("missing, filtered, and self parents stay reachable as roots", () => {
  const tree = threadTree([row("orphan", "missing"), row("self", "self")]);
  assert.deepEqual(tree.roots.map(t => t.id), ["orphan", "self"]);
});
test("cycles break without dropping or duplicating conversations", () => {
  const input = [row("a", "b"), row("b", "c"), row("c", "a"), row("d", "b")];
  const tree = threadTree(input);
  const rows = visibleThreadRows(tree.roots, tree.children, new Set(input.map(t => t.id)));
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map(r => r.thread.id)).size, 4);
});
test("deep delegation uses iterative traversal", () => {
  const input = Array.from({ length: 10000 }, (_, i) => row(String(i), i ? String(i - 1) : null));
  const tree = threadTree(input);
  assert.equal(visibleThreadRows(tree.roots, tree.children, new Set(input.map(t => t.id))).length, 10000);
});

const pinRow = (id: string, pinnedAt: number | null, pinSortKey: string | null = null, createdAt = 0) =>
  ({ id, parentThreadId: null, pinnedAt, pinSortKey, createdAt });

test("pinned roots sort by manual key, then newest pin, then newest thread, then id", () => {
  const roots = [
    pinRow("older", 1),
    pinRow("newer", 2),
    pinRow("keyed-b", 1, "b"),
    pinRow("keyed-a", 1, "a"),
    pinRow("tie-b", 5, null, 1),
    pinRow("tie-a", 5, null, 1),
  ];
  const { pinned, rest } = splitPinnedRoots(roots);
  assert.deepEqual(pinned.map(r => r.id), ["tie-a", "tie-b", "newer", "keyed-a", "keyed-b", "older"]);
  assert.deepEqual(rest, []);
});
test("a manual key is ignored against an unkeyed pin, which falls back to pinnedAt", () => {
  const { pinned } = splitPinnedRoots([pinRow("keyed", 1, "a"), pinRow("unkeyed", 9)]);
  assert.deepEqual(pinned.map(r => r.id), ["unkeyed", "keyed"]);
});
test("unpinned roots stay in input order and leave the pinned section empty", () => {
  const { pinned, rest } = splitPinnedRoots([pinRow("b", null), pinRow("a", null)]);
  assert.deepEqual(pinned, []);
  assert.deepEqual(rest.map(r => r.id), ["b", "a"]);
});
test("a pinned root takes its subtree out of the ordinary list", () => {
  const tree = threadTree([
    { id: "pinned", parentThreadId: null, pinnedAt: 1, pinSortKey: null, createdAt: 0 },
    { id: "child", parentThreadId: "pinned", pinnedAt: null, pinSortKey: null, createdAt: 0 },
    { id: "plain", parentThreadId: null, pinnedAt: null, pinSortKey: null, createdAt: 0 },
  ]);
  const { pinned, rest } = splitPinnedRoots(tree.roots);
  assert.deepEqual(rest.map(r => r.id), ["plain"]);
  const rows = (roots: typeof tree.roots) => visibleThreadRows(roots, tree.children, new Set(["pinned"]));
  assert.deepEqual(rows(pinned).map(r => [r.thread.id, r.depth]), [["pinned", 0], ["child", 1]]);
  assert.deepEqual(rows(rest).map(r => r.thread.id), ["plain"]);
});
