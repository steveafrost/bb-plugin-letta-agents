import { test } from "node:test";
import assert from "node:assert/strict";
import { threadTree, visibleThreadRows } from "./thread-tree.ts";
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
