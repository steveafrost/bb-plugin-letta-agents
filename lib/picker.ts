type PickerProvider = { id: string; displayName: string };

/** Escape a double-quoted CSS string, including controls and line separators. */
function escapeCssString(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0)!;
    if (code === 0) return "\uFFFD";
    if (character === '"' || character === "\\") return `\\${character}`;
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) {
      return `\\${code.toString(16)} `;
    }
    return character;
  }).join("");
}

/** Picker-only workaround: ambiguous names fail open, never hiding another provider. */
export function providerPickerCss(
  providers: readonly PickerProvider[],
  escape: (value: string) => string = escapeCssString,
): string {
  const owned = (provider: PickerProvider) => provider.id.startsWith("acp-letta-");
  const shared = new Set(providers.filter((provider) => !owned(provider)).map((provider) => provider.displayName));
  const names = new Set(providers.filter((provider) => owned(provider) && !shared.has(provider.displayName)).map((provider) => provider.displayName));
  const selectors = Array.from(names, (name) => `[role="dialog"] button.border-b-2[title="${escape(name)}"]`);
  return selectors.length ? `${selectors.join(",\n")} { display: none !important; }` : "";
}
