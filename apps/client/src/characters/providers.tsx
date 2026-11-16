/**
 * Whose model an agent is: Claude, ChatGPT (Codex), Kimi, DeepSeek, Gemini… An agent on the council
 * wears a small mark of it at its top right, and Settings lists it beside each connected agent.
 *
 * The marks are drawn here in the ink, as monograms on a raised bead: the vendors' own logos and
 * colours stay out of the chrome (as Slack's do on the Slack mark).
 */

export type Provider = "claude" | "chatgpt" | "kimi" | "deepseek" | "gemini" | "grok" | "cursor" | "local" | "agent";

export const PROVIDER_NAME: Record<Provider, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  kimi: "Kimi",
  deepseek: "DeepSeek",
  gemini: "Gemini",
  grok: "Grok",
  cursor: "Cursor",
  local: "A local model",
  agent: "An agent",
};

/** from what an agent says about itself: its driver, a preset it was added from, or (last) its name */
export function providerOf(a: { name?: string; driver?: string; added?: { preset?: string } | null; provider?: string }): Provider {
  if (a.provider && a.provider in PROVIDER_NAME) return a.provider as Provider;
  const preset = a.added?.preset?.toLowerCase();
  if (preset === "kimi" || preset === "deepseek") return preset;
  const d = (a.driver ?? "").toLowerCase();
  if (d.includes("codex") || d.includes("openai")) return "chatgpt";
  if (d.includes("antigravity") || d.includes("gemini")) return "gemini";
  if (d.includes("grok")) return "grok";
  if (d.includes("cursor")) return "cursor";
  if (d.includes("claude")) return "claude";
  const n = (a.name ?? "").toLowerCase();
  if (n.startsWith("kimi")) return "kimi";
  if (n.startsWith("deepseek")) return "deepseek";
  if (n.startsWith("codex") || n.includes("gpt")) return "chatgpt";
  if (n.startsWith("gemini") || n.startsWith("antigravity")) return "gemini";
  if (n.startsWith("grok")) return "grok";
  if (n.startsWith("cursor")) return "cursor";
  if (n.startsWith("claude")) return "claude";
  return "agent";
}

function Glyph({ provider }: { provider: Provider }) {
  const s = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (provider) {
    case "claude": // a burst of rays
      return <path {...s} d="M8 2.2v11.6M2.2 8h11.6M3.9 3.9l8.2 8.2M12.1 3.9l-8.2 8.2" />;
    case "chatgpt": // a six-sided knot
      return (
        <>
          <path {...s} d="M8 2.2l5 2.9v5.8l-5 2.9-5-2.9V5.1z" />
          <path {...s} d="M8 5.4l2.3 1.3v2.6L8 10.6 5.7 9.3V6.7z" />
        </>
      );
    case "kimi": // K, with a moon's dot
      return (
        <>
          <path {...s} d="M4.6 3v10M4.6 8.4L10.4 3M6.9 6.6l3.9 6.4" />
          <circle cx="12.6" cy="3.6" r="1" fill="currentColor" />
        </>
      );
    case "deepseek": // a whale's back and tail
      return <path {...s} d="M2.4 9.2c1.6 2.6 5.6 3.4 8.4 1.2 1.4-1.1 2-2.6 2-4.4M12.8 6c-.9-.2-1.7-.9-2-1.9M12.8 6c.6-.6 1.4-.9 2-.7M5.6 8.2h.1" />;
    case "gemini": // a four-point star
      return <path {...s} d="M8 2c.4 3.4 2.6 5.6 6 6-3.4.4-5.6 2.6-6 6-.4-3.4-2.6-5.6-6-6 3.4-.4 5.6-2.6 6-6z" />;
    case "grok": // a slashed ring
      return (
        <>
          <circle {...s} cx="8" cy="8" r="4.6" />
          <path {...s} d="M12.8 3.2L3.2 12.8" />
        </>
      );
    case "cursor": // a pointer
      return <path {...s} d="M4 2.6l8.4 5.2-3.6.9-1.4 3.7z" />;
    case "local": // a computer
      return <path {...s} d="M2.8 3.6h10.4v6.6H2.8zM6 12.8h4M8 10.2v2.6" />;
    default: // the agent's spark
      return <path fill="currentColor" d="M8 2.4l1.5 4.1 4.1 1.5-4.1 1.5L8 13.6 6.5 9.5 2.4 8l4.1-1.5z" />;
  }
}

/** the bead: `where` adds a word to its label (cloud or this computer) */
export function ProviderMark({ provider, where, size = 18 }: { provider: Provider; where?: "cloud" | "local"; size?: number }) {
  const label = `${PROVIDER_NAME[provider]}${where === "local" ? " · on this computer" : where === "cloud" ? " · in the cloud" : ""}`;
  return (
    <span className="provider-mark" data-provider={provider} data-tip={label} role="img" aria-label={label} style={{ width: size, height: size }}>
      <svg viewBox="0 0 16 16" width={size - 6} height={size - 6} aria-hidden>
        <Glyph provider={provider} />
      </svg>
    </span>
  );
}
