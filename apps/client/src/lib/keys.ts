/**
 * Shortcut labels for the platform we're on. The key handlers already take
 * either modifier (`e.metaKey || e.ctrlKey`); only what we print differs:
 * `⌘K` on a Mac, `Ctrl+K` on Windows and Linux.
 *
 * Detection reads `navigator.userAgentData.platform` (Chromium, so WebView2)
 * and falls back to `navigator.platform` (WebKit, so Safari, WKWebView and
 * WebKitGTK), which every webview Tauri uses still fills in.
 */

type Nav = Pick<Navigator, "platform"> & { userAgentData?: { platform?: string } };

export function detectMac(nav: Nav | null | undefined = globalThis.navigator): boolean {
  if (!nav) return false;
  const platform = nav.userAgentData?.platform || nav.platform || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export const IS_MAC = detectMac();

/** the top bar's commands button: the ⌘ key itself on a Mac, a neutral list glyph elsewhere */
export const COMMANDS_GLYPH = IS_MAC ? "⌘" : "≡";

type Mod = "ctrl" | "alt" | "shift" | "mod";
// the order each platform writes modifiers in: ⌃⌥⇧⌘ on a Mac, Ctrl+Alt+Shift elsewhere
const ORDER_MAC: Mod[] = ["ctrl", "alt", "shift", "mod"];
const ORDER_PC: Mod[] = ["ctrl", "mod", "alt", "shift"];
const MAC: Record<Mod, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", mod: "⌘" };
const PC: Record<Mod, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", mod: "Ctrl" };
const NAMED_PC: Record<string, string> = { enter: "Enter", "↵": "Enter" };
const NAMED_MAC: Record<string, string> = { enter: "↵" };

/**
 * `keys("mod+K")` → `⌘K` / `Ctrl+K`; `keys("shift+mod+Z")` → `⇧⌘Z` / `Ctrl+Shift+Z`;
 * `keys("mod+enter")` → `⌘↵` / `Ctrl+Enter`. `mod` is ⌘ on a Mac and Ctrl elsewhere.
 */
export function keys(combo: string, mac = IS_MAC): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => p.trim().toLowerCase() as Mod));
  if (mac) return ORDER_MAC.filter((m) => mods.has(m)).map((m) => MAC[m]).join("") + (NAMED_MAC[key.toLowerCase()] ?? key);
  // "ctrl+mod" is still one Ctrl on a PC
  const names = [...new Set(ORDER_PC.filter((m) => mods.has(m)).map((m) => PC[m]))];
  return [...names, NAMED_PC[key.toLowerCase()] ?? key].join("+");
}
