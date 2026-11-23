/**
 * The composer: a field that grows (to 40 % of the view), markdown with a small toolbar, `@` people and
 * agents (and @channel, @here), `#` channels, `:` emoji; files pasted, dropped or picked, uploaded at once
 * into the archive (`board=chat`) and shown as chips with their progress (pictures as thumbnails), each
 * removable before sending. Enter sends, Shift+Enter breaks the line, ↑ in an empty field edits my last
 * message. What's typed is kept per channel (and thread) on this device until it's sent.
 */

import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { ChatAgentRef, ChatChannelView, ChatParty } from "@foundation/protocol";
import { uploadFile, type UploadedFile } from "../lib/api";
import { keys } from "../lib/keys";
import { PartyAvatar } from "./Avatar";
import { EmojiPicker } from "./EmojiPicker";
import { AttachFrom } from "./AttachFrom";
import { matchEmoji } from "./emoji";
import { applyCompletion, applyFormat, bytes, findTrigger, matchChannels, matchMentions, readDraft, writeDraft, type Format, type MentionOption, type Trigger } from "./logic";
import { IconClip, IconCode, IconHash, IconLink, IconList, IconLock, IconQuote, IconReact, IconSend } from "./Icons";

export interface ComposerHandle {
  addFiles(files: File[]): void;
  focus(): void;
}

export interface SentFile {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface ComposerProps {
  /** the channel (and thread) this composer writes to: its draft is kept under it */
  channel: string;
  root?: string | null;
  placeholder: string;
  people: ChatParty[];
  agents: ChatAgentRef[];
  channels: ChatChannelView[];
  meId?: string;
  onSend(text: string, files: SentFile[]): void;
  onTyping?(): void;
  /** ↑ in an empty field: edit my last message (true when there was one) */
  onEditLast?(): boolean;
  upload?: (file: File, onProgress: (f: number) => void) => Promise<UploadedFile>;
  /** why it can't send (archived, a viewer…): the field says so instead */
  disabled?: string;
  /** a fixture's text (the design page) */
  initial?: string;
  initialChips?: Chip[];
  autoFocus?: boolean;
  compact?: boolean;
  ref?: Ref<ComposerHandle>;
}

export interface Chip {
  key: string;
  name: string;
  size: number;
  mime: string;
  progress: number;
  /** the archive file, once it's there */
  id?: string;
  error?: string;
  thumb?: string;
}

const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

let chipN = 0;

export function Composer(p: ComposerProps) {
  const [text, setText] = useState(() => p.initial ?? readDraft(storage(), p.channel, p.root));
  const [chips, setChips] = useState<Chip[]>(p.initialChips ?? []);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [pick, setPick] = useState(0);
  const [emoji, setEmoji] = useState(false);
  const [drag, setDrag] = useState(false);
  const [from, setFrom] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const filePick = useRef<HTMLInputElement>(null);
  const draftFor = useRef({ channel: p.channel, root: p.root });

  // a new channel: its own draft
  useEffect(() => {
    if (draftFor.current.channel === p.channel && draftFor.current.root === p.root) return;
    draftFor.current = { channel: p.channel, root: p.root };
    setText(readDraft(storage(), p.channel, p.root));
    setChips([]);
    setTrigger(null);
    if (p.autoFocus !== false) requestAnimationFrame(() => field.current?.focus());
  }, [p.channel, p.root, p.autoFocus]);

  // kept as it's typed (a beat after)
  useEffect(() => {
    if (p.initial !== undefined) return;
    const t = setTimeout(() => writeDraft(storage(), draftFor.current.channel, text, draftFor.current.root), 250);
    return () => clearTimeout(t);
  }, [text, p.initial]);

  // the field grows with what's in it
  useEffect(() => {
    const t = field.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.min(Math.max(window.innerHeight * 0.4, 120), t.scrollHeight)}px`;
  }, [text]);

  useEffect(() => {
    if (p.autoFocus) field.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = (files: File[]) => {
    if (!files.length) return;
    const up = p.upload ?? ((f: File, on: (x: number) => void) => uploadFile(f, "chat", on));
    for (const f of files) {
      const key = `c${++chipN}`;
      const thumb = f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined;
      setChips((cs) => [...cs, { key, name: f.name || "pasted", size: f.size, mime: f.type || "application/octet-stream", progress: 0, thumb }]);
      up(f, (x) => setChips((cs) => cs.map((c) => (c.key === key ? { ...c, progress: x } : c))))
        .then((u) => setChips((cs) => cs.map((c) => (c.key === key ? { ...c, id: u.id, progress: 1, mime: u.mime || c.mime, size: u.size || c.size, name: u.name || c.name } : c))))
        .catch((e: Error) => setChips((cs) => cs.map((c) => (c.key === key ? { ...c, error: e.message } : c))));
    }
    field.current?.focus();
  };

  // a file already in the archive (from Vision, from an approved place): a chip that's ready
  const addUploaded = (u: UploadedFile) => {
    setChips((cs) => [...cs, { key: `c${++chipN}`, name: u.name, size: u.size, mime: u.mime || "application/octet-stream", progress: 1, id: u.id }]);
    field.current?.focus();
  };

  useImperativeHandle(p.ref, () => ({ addFiles, focus: () => field.current?.focus() }));

  const options = useMemo((): Array<{ key: string; label: string; detail?: string; insert: string; lead: React.ReactNode }> => {
    if (!trigger) return [];
    if (trigger.kind === "@")
      return matchMentions(trigger.query, p.people, p.agents, p.meId).map((o: MentionOption) => ({
        key: `${o.kind}:${o.id}`,
        label: o.name,
        detail: o.kind === "person" ? `@${o.handle}` : o.detail,
        insert: `@${o.handle}`,
        lead: o.kind === "special" ? <span className="chat-ac-glyph">@</span> : <PartyAvatar party={{ kind: o.kind === "agent" ? "agent" : "person", id: o.id, name: o.name, color: o.color }} size={20} />,
      }));
    if (trigger.kind === "#")
      return matchChannels(trigger.query, p.channels).map((c) => ({ key: c.id, label: c.name, detail: c.purpose || undefined, insert: `#${c.name}`, lead: <span className="chat-ac-glyph">{c.kind === "private" ? <IconLock /> : <IconHash />}</span> }));
    return matchEmoji(trigger.query).map((e) => ({ key: e.char, label: `:${e.names[0]}:`, insert: e.char, lead: <span className="chat-ac-emoji">{e.char}</span> }));
  }, [trigger, p.people, p.agents, p.channels, p.meId]);

  const look = (t: HTMLTextAreaElement) => {
    const tr = t.selectionStart === t.selectionEnd ? findTrigger(t.value, t.selectionStart) : null;
    setTrigger((was) => (was?.kind === tr?.kind && was?.query === tr?.query && was?.start === tr?.start ? was : tr));
    if (!tr) setPick(0);
  };

  const complete = (i: number) => {
    const t = field.current;
    const o = options[i];
    if (!t || !trigger || !o) return;
    const next = applyCompletion(t.value, trigger, o.insert, t.selectionStart);
    setText(next.text);
    setTrigger(null);
    requestAnimationFrame(() => {
      t.focus();
      t.setSelectionRange(next.caret, next.caret);
    });
  };

  const format = (f: Format) => {
    const t = field.current;
    if (!t) return;
    const next = applyFormat(t.value, t.selectionStart, t.selectionEnd, f);
    setText(next.text);
    requestAnimationFrame(() => {
      t.focus();
      t.setSelectionRange(next.start, next.end);
    });
  };

  const insert = (s: string) => {
    const t = field.current;
    if (!t) return setText((x) => x + s);
    const a = t.selectionStart, b = t.selectionEnd;
    const next = t.value.slice(0, a) + s + t.value.slice(b);
    setText(next);
    requestAnimationFrame(() => {
      t.focus();
      t.setSelectionRange(a + s.length, a + s.length);
    });
  };

  const busy = chips.some((c) => !c.id && !c.error);
  const ready = chips.filter((c) => c.id);
  const can = !p.disabled && !busy && (text.trim().length > 0 || ready.length > 0);

  const sendNow = () => {
    if (!can) return;
    p.onSend(
      text.trim(),
      ready.map((c) => ({ id: c.id!, name: c.name, mime: c.mime, size: c.size })),
    );
    chips.forEach((c) => c.thumb && URL.revokeObjectURL(c.thumb));
    setText("");
    setChips([]);
    setTrigger(null);
    writeDraft(storage(), p.channel, "", p.root);
  };

  return (
    <div
      className={`chat-compose${drag ? " is-drop" : ""}${p.disabled ? " is-disabled" : ""}${p.compact ? " is-compact" : ""}`}
      onDragOver={(e) => {
        if (p.disabled || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        if (p.disabled || !e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setDrag(false);
        addFiles([...e.dataTransfer.files]);
      }}
      data-chat-composer={p.root ? "thread" : "channel"}
    >
      <AnimatePresence>
        {trigger && options.length > 0 && (
          <motion.div
            id={`chat-ac-${p.root ? "thread" : "channel"}`}
            className="chat-ac"
            role="listbox"
            aria-label={trigger.kind === "@" ? "People and agents" : trigger.kind === "#" ? "Channels" : "Emoji"}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 2 }}
            transition={{ type: "spring", stiffness: 520, damping: 40 }}
          >
            <div className="chat-ac-head">{trigger.kind === "@" ? "People and agents" : trigger.kind === "#" ? "Channels" : "Emoji"}</div>
            {options.map((o, i) => (
              <button
                key={o.key}
                id={`chat-ac-${p.root ? "thread" : "channel"}-${i}`}
                type="button"
                role="option"
                aria-selected={i === pick}
                className={`chat-ac-row${i === pick ? " is-on" : ""}`}
                onMouseEnter={() => setPick(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  complete(i);
                }}
              >
                {o.lead}
                <span className="chat-ac-label">{o.label}</span>
                {o.detail && <span className={`chat-ac-detail${o.detail === "Agent" ? " is-agent" : ""}`}>{o.detail}</span>}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      {chips.length > 0 && (
        <div className="chat-chips">
          {chips.map((c) => (
            <div key={c.key} className={`chat-chip${c.error ? " is-bad" : ""}${c.id ? " is-done" : ""}`} data-chip={c.name}>
              {c.thumb ? <img className="chat-chip-thumb" src={c.thumb} alt="" /> : <span className="chat-chip-thumb is-file">{c.name.split(".").pop()?.toUpperCase().slice(0, 4)}</span>}
              <span className="chat-chip-text">
                <span className="chat-chip-name" title={c.name}>{c.name}</span>
                <span className="chat-chip-meta" role={c.error ? "alert" : undefined} title={c.error || undefined}>
                  {c.error ? c.error : c.id ? bytes(c.size) : `${Math.round(c.progress * 100)} %`}
                </span>
              </span>
              <button
                type="button"
                className="chat-chip-x"
                onClick={() => {
                  if (c.thumb) URL.revokeObjectURL(c.thumb);
                  setChips((cs) => cs.filter((x) => x.key !== c.key));
                }}
                aria-label={`Remove ${c.name}`}
                data-tip="Remove"
              >
                ✕
              </button>
              {!c.id && !c.error && <span className="chat-chip-bar" style={{ transform: `scaleX(${Math.max(0.04, c.progress)})` }} />}
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={field}
        className="chat-compose-field"
        rows={1}
        value={text}
        disabled={!!p.disabled}
        placeholder={p.disabled ?? p.placeholder}
        aria-label={p.placeholder}
        aria-autocomplete={trigger && options.length > 0 ? "list" : undefined}
        aria-controls={trigger && options.length > 0 ? `chat-ac-${p.root ? "thread" : "channel"}` : undefined}
        aria-activedescendant={trigger && options[pick] ? `chat-ac-${p.root ? "thread" : "channel"}-${pick}` : undefined}
        onChange={(e) => {
          setText(e.target.value);
          look(e.target);
          if (e.target.value) p.onTyping?.();
        }}
        onSelect={(e) => look(e.currentTarget)}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length) {
            e.preventDefault();
            addFiles(files);
          }
        }}
        onKeyDown={(e) => {
          // nothing typed here is the shell's (V, P, ⌘I…)
          e.stopPropagation();
          const mod = e.metaKey || e.ctrlKey;
          if (trigger && options.length) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              return setPick((i) => (i + 1) % options.length);
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              return setPick((i) => (i - 1 + options.length) % options.length);
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              return complete(pick);
            }
            if (e.key === "Escape") {
              e.preventDefault();
              return setTrigger(null);
            }
          }
          if (mod && e.key.toLowerCase() === "b") {
            e.preventDefault();
            return format("bold");
          }
          if (mod && e.key.toLowerCase() === "i") {
            e.preventDefault();
            return format("italic");
          }
          if (mod && e.shiftKey && e.key.toLowerCase() === "x") {
            e.preventDefault();
            return format("strike");
          }
          if (mod && e.key.toLowerCase() === "u") {
            e.preventDefault();
            return filePick.current?.click();
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            return sendNow();
          }
          if (e.key === "ArrowUp" && !text && !chips.length && p.onEditLast) {
            if (p.onEditLast()) e.preventDefault();
          }
        }}
      />
      <div className="chat-compose-foot">
        <div className="chat-compose-tools" role="toolbar" aria-label="Formatting">
          <ToolBtn tip="Bold" kbd={keys("mod+B")} onClick={() => format("bold")}>
            <b>B</b>
          </ToolBtn>
          <ToolBtn tip="Italic" kbd={keys("mod+I")} onClick={() => format("italic")}>
            <i>I</i>
          </ToolBtn>
          <ToolBtn tip="Strikethrough" kbd={keys("shift+mod+X")} onClick={() => format("strike")}>
            <s>S</s>
          </ToolBtn>
          <ToolBtn tip="Code" onClick={() => format("code")}>
            <IconCode />
          </ToolBtn>
          <ToolBtn tip="Link" onClick={() => format("link")}>
            <IconLink />
          </ToolBtn>
          <ToolBtn tip="List" onClick={() => format("list")}>
            <IconList />
          </ToolBtn>
          <ToolBtn tip="Quote" onClick={() => format("quote")}>
            <IconQuote />
          </ToolBtn>
        </div>
        <span className="chat-compose-gap" />
        <ToolBtn tip="Attach files" kbd={keys("mod+U")} onClick={() => filePick.current?.click()} label="Attach files">
          <IconClip />
        </ToolBtn>
        <ToolBtn tip="Attach from Vision or this computer's approved folders" onClick={() => setFrom((x) => !x)} on={from} label="Attach from…">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M2.5 9.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3M8 2.5v7M5 6.5l3 3 3-3" />
          </svg>
        </ToolBtn>
        <div className="chat-compose-emoji">
          <ToolBtn tip="Emoji" onClick={() => setEmoji((x) => !x)} on={emoji} label="Emoji">
            <IconReact />
          </ToolBtn>
          {emoji && (
            <EmojiPicker
              className="is-over-composer"
              onClose={() => setEmoji(false)}
              onPick={(c) => {
                setEmoji(false);
                insert(c);
              }}
            />
          )}
        </div>
        <button type="button" className={`chat-send${can ? " is-ready" : ""}`} onClick={sendNow} disabled={!can} data-tip={busy ? "Waiting for the files to land" : "Send"} data-kbd="Enter" aria-label="Send">
          <IconSend />
        </button>
      </div>
      <input
        ref={filePick}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
      {drag && <div className="chat-drop-hint">Drop to attach</div>}
      {from && <AttachFrom onPicked={addUploaded} onClose={() => setFrom(false)} />}
    </div>
  );
}

function ToolBtn({ tip, kbd, onClick, children, on, label }: { tip: string; kbd?: string; onClick(): void; children: React.ReactNode; on?: boolean; label?: string }) {
  return (
    <button type="button" className={`chat-tool${on ? " is-on" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={onClick} data-tip={tip} data-kbd={kbd} aria-label={label ?? tip}>
      {children}
    </button>
  );
}
