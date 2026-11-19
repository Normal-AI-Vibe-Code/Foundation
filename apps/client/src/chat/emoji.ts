/**
 * The emoji ChatForm offers: a curated set of the common ones, in four groups, each with the names it's
 * found by (Slack's shortcodes first, so `:+1:` and `:tada:` work as they always have). No dependency: a
 * reaction is the emoji itself, and anything brought in from Slack that has no character stays a
 * `:shortcode:` (protocol `slackEmoji`). The recent ones are kept on this device.
 */

export interface Emoji {
  char: string;
  names: string[];
}

export interface EmojiGroup {
  id: string;
  name: string;
  emoji: Emoji[];
}

const e = (char: string, ...names: string[]): Emoji => ({ char, names });

export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    id: "faces",
    name: "Faces",
    emoji: [
      e("😀", "grinning", "smile"),
      e("😄", "smile", "happy"),
      e("😁", "grin"),
      e("😂", "joy", "laughing"),
      e("🤣", "rofl"),
      e("😅", "sweat_smile"),
      e("🙂", "slightly_smiling_face"),
      e("😉", "wink"),
      e("😊", "blush"),
      e("😍", "heart_eyes"),
      e("🥰", "smiling_face_with_hearts"),
      e("😎", "sunglasses", "cool"),
      e("🤓", "nerd_face"),
      e("🤔", "thinking_face", "thinking"),
      e("🤨", "raised_eyebrow"),
      e("😐", "neutral_face"),
      e("😶", "no_mouth"),
      e("🙄", "roll_eyes"),
      e("😬", "grimacing"),
      e("😴", "sleeping"),
      e("😮", "open_mouth", "wow"),
      e("😱", "scream"),
      e("😢", "cry"),
      e("😭", "sob"),
      e("😤", "triumph"),
      e("😡", "rage", "angry"),
      e("🤯", "exploding_head", "mind_blown"),
      e("🥳", "partying_face", "party"),
      e("😇", "innocent"),
      e("🤖", "robot_face", "robot"),
    ],
  },
  {
    id: "hands",
    name: "Hands and people",
    emoji: [
      e("👍", "+1", "thumbsup", "yes"),
      e("👎", "-1", "thumbsdown", "no"),
      e("👌", "ok_hand", "ok"),
      e("✌️", "v", "peace"),
      e("🤞", "crossed_fingers"),
      e("👏", "clap"),
      e("🙌", "raised_hands"),
      e("🙏", "pray", "thanks"),
      e("👋", "wave", "hello"),
      e("💪", "muscle", "strong"),
      e("☝️", "point_up"),
      e("👉", "point_right"),
      e("👀", "eyes", "looking"),
      e("🫡", "saluting_face", "salute"),
      e("🤝", "handshake", "deal"),
      e("✍️", "writing_hand"),
    ],
  },
  {
    id: "things",
    name: "Work and things",
    emoji: [
      e("🎉", "tada", "celebrate"),
      e("🚀", "rocket", "ship"),
      e("🔥", "fire", "lit"),
      e("✨", "sparkles"),
      e("⭐", "star"),
      e("💡", "bulb", "idea"),
      e("🐛", "bug"),
      e("🔧", "wrench", "fix"),
      e("🛠️", "hammer_and_wrench", "tools"),
      e("⚙️", "gear"),
      e("📦", "package", "box"),
      e("📝", "memo", "note"),
      e("📌", "pushpin", "pin"),
      e("📎", "paperclip"),
      e("📅", "calendar"),
      e("⏰", "alarm_clock"),
      e("🔗", "link"),
      e("🔒", "lock"),
      e("📈", "chart_with_upwards_trend", "up"),
      e("📉", "chart_with_downwards_trend", "down"),
      e("🧪", "test_tube", "test"),
      e("🧩", "jigsaw", "puzzle"),
      e("🖨️", "printer", "print"),
      e("☕", "coffee"),
      e("🍕", "pizza"),
      e("🏁", "checkered_flag", "finish"),
    ],
  },
  {
    id: "symbols",
    name: "Symbols",
    emoji: [
      e("✅", "white_check_mark", "done", "check"),
      e("✔️", "heavy_check_mark"),
      e("❌", "x", "cross"),
      e("⚠️", "warning"),
      e("❓", "question"),
      e("❗", "exclamation"),
      e("💯", "100"),
      e("❤️", "heart", "love"),
      e("💜", "purple_heart"),
      e("💔", "broken_heart"),
      e("⚡", "zap", "fast"),
      e("🆗", "ok_button"),
      e("➕", "heavy_plus_sign", "plus"),
      e("➖", "heavy_minus_sign", "minus"),
      e("🔁", "repeat"),
      e("👆", "point_up_2", "this"),
    ],
  },
];

export const ALL_EMOJI: Emoji[] = EMOJI_GROUPS.flatMap((g) => g.emoji);

/** the emoji a `:name` asks for: a name's start beats its middle; at most `limit` */
export function matchEmoji(query: string, limit = 8): Emoji[] {
  const q = query.toLowerCase().replace(/^:|:$/g, "");
  if (!q) return ALL_EMOJI.slice(0, limit);
  const scored: Array<{ e: Emoji; s: number }> = [];
  for (const em of ALL_EMOJI) {
    let s = 0;
    for (const n of em.names) {
      if (n === q) s = Math.max(s, 3);
      else if (n.startsWith(q)) s = Math.max(s, 2);
      else if (n.includes(q)) s = Math.max(s, 1);
    }
    if (s) scored.push({ e: em, s });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.e);
}

/** an emoji's first name, for a roll-over (":thumbsup:") */
export function emojiName(char: string): string {
  const em = ALL_EMOJI.find((x) => x.char === char);
  return em ? `:${em.names[0]}:` : char;
}

export const RECENTS_MAX = 16;

/** the one just used goes first; nothing twice; at most RECENTS_MAX */
export function pushRecent(recent: string[], char: string, max = RECENTS_MAX): string[] {
  return [char, ...recent.filter((c) => c !== char)].slice(0, max);
}

const RECENT_KEY = "chatform-emoji-recent";

export function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENTS_MAX) : [];
  } catch {
    return [];
  }
}

export function saveRecent(char: string): string[] {
  const next = pushRecent(loadRecents(), char);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* private window: recents last as long as the page */ }
  return next;
}
