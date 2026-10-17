import test from "node:test";
import assert from "node:assert/strict";
import { providerPickerCss } from "./picker.ts";
test("picker hides only Letta names within scoped dialog selector", () => {
  const css = providerPickerCss([{ id: "pi", displayName: "Pi" }, { id: "acp-letta-id-1", displayName: "Jeeves" }]);
  assert.equal(css, '[role="dialog"] button.border-b-2[title="Jeeves"] { display: none !important; }');
  assert.equal(providerPickerCss([]), "");
});
test("shared display names fail open", () => {
  assert.equal(providerPickerCss([{ id: "pi", displayName: "Same" }, { id: "acp-letta-id-1", displayName: "Same" }]), "");
});
test("fallback escapes quotes, backslashes and controls without CSS global", () => {
  const css = providerPickerCss([{ id: "acp-letta-id", displayName: 'a"\\\n\u0000' }]);
  assert.ok(css.includes('a\\"\\\\\\a �')); assert.ok(!css.includes("\n"));
  assert.ok(providerPickerCss([{ id: "acp-letta-id", displayName: "x" }], () => "escaped").includes('title="escaped"'));
});
