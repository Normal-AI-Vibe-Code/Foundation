/**
 * The note editor: CodeMirror 6 bound straight to the note's shared Y.Text
 * (y-codemirror.next). Loaded only when someone opens a note for writing, so
 * a board of notes costs one rendered markdown block each and no editors.
 *
 * - Every keystroke is a Yjs insert/delete at its own position: two people
 *   typing into the very same word keep two whole runs, never interleaved
 *   letters (the CRDT orders runs, not characters).
 * - Someone else's words (a person's, or an agent's `update_card`) arrive as
 *   a CodeMirror change; your caret and selection are mapped through it and
 *   stay where you were writing.
 * - Undo is the board's per-note Y.UndoManager: only your own typing, kept
 *   while the board is open, ⌘Z / ⇧⌘Z / Ctrl+Y and the app menu's Edit → Undo
 *   (which arrives as a `historyUndo` input event).
 * - Other people's carets come from the board's awareness (`caret: {note,
 *   anchor, head}` as Yjs relative positions — the same shape the board has
 *   always published), drawn as decorations in their colour with their name.
 */

import { EditorSelection, EditorState, Prec, StateEffect, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { defineLanguageFacet, HighlightStyle, Language, LanguageSupport, syntaxHighlighting } from "@codemirror/language";
import { GFM, parser as markdownParser } from "@lezer/markdown";
import { tags as t } from "@lezer/highlight";
import { yCollab } from "y-codemirror.next";
import type * as Y from "yjs";

/** someone else writing here: their selection (from === to for a bare caret) */
export interface PeerCaret {
  clientId: number;
  name: string;
  color: string;
  from: number;
  to: number;
  head: number;
}

/** where other people's carets come from (the board's awareness, or a demo) */
export interface CaretSource {
  /** their carets now, as indexes into the shared text */
  get(): PeerCaret[];
  /** called whenever one moves; returns an unsubscribe */
  subscribe(fn: () => void): () => void;
  /** where I am writing (null: I stopped) */
  publish?(sel: { anchor: number; head: number } | null): void;
}

export interface NoteEditorOptions {
  ytext: Y.Text;
  /** the note's undo stack: only your own typing */
  undoManager: Y.UndoManager | false;
  carets?: CaretSource;
  /** Esc, ⌘↵ or focus leaving: back to the rendered note */
  onDone?(): void;
  /** where to put the caret on open (default: the end) */
  at?: number;
  focus?: boolean;
  readOnly?: boolean;
}

export interface NoteEditorHandle {
  view: EditorView;
  destroy(): void;
}

export function mountNoteEditor(parent: HTMLElement, o: NoteEditorOptions): NoteEditorHandle {
  const doc = o.ytext.toString();
  const at = Math.max(0, Math.min(o.at ?? doc.length, doc.length));
  const extensions: Extension[] = [
    yCollab(o.ytext, null, { undoManager: o.undoManager }),
    keymap.of([
      { key: "Escape", run: () => (o.onDone?.(), true) },
      { key: "Mod-Enter", run: () => (o.onDone?.(), true) },
      ...defaultKeymap,
    ]),
    EditorView.lineWrapping,
    // the card's bar sits over the top 42 px while writing: never scroll the caret under it
    EditorView.scrollMargins.of(() => ({ top: 42 })),
    EditorView.contentAttributes.of({ spellcheck: "false", "aria-label": "Note text", "aria-multiline": "true" }),
    // highlighting only: Enter types a newline (no list continuation rewriting lines someone else may be in)
    markdownSource,
    syntaxHighlighting(noteHighlight),
    EditorState.readOnly.of(!!o.readOnly),
    EditorView.editable.of(!o.readOnly),
  ];
  const um = o.undoManager;
  if (um)
    extensions.push(
      // ⌘Z / ⇧⌘Z / Ctrl+Y, read the way the textarea read them: a keymap would take Ctrl+Shift+"z"
      // (lower case, as some keyboards and drivers report it) for Ctrl+Z
      Prec.highest(
        EditorView.domEventHandlers({
          keydown: (e) => {
            if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
            const k = e.key.toLowerCase();
            if (k !== "z" && !(k === "y" && e.ctrlKey && !e.metaKey)) return false;
            e.preventDefault();
            if (k === "y" || e.shiftKey) um.redo();
            else um.undo();
            return true;
          },
        }),
      ),
    );
  if (o.carets) extensions.push(peerCarets(o.carets));
  if (o.onDone) {
    const done = o.onDone;
    extensions.push(
      EditorView.domEventHandlers({
        blur: (_e, view) => {
          // focus moving inside the editor (a widget) isn't leaving it
          queueMicrotask(() => !view.hasFocus && done());
          return false;
        },
      }),
    );
  }
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, selection: EditorSelection.cursor(at), extensions }),
  });
  if (import.meta.env?.DEV || import.meta.env?.VITE_E2E_HOOKS) (view.dom as unknown as { __view: EditorView }).__view = view;
  if (o.focus) {
    view.focus();
    view.dispatch({ effects: EditorView.scrollIntoView(at, { y: "nearest" }) });
  }
  return {
    view,
    destroy() {
      o.carets?.publish?.(null);
      view.destroy();
    },
  };
}

/**
 * Markdown (with GitHub tables and strikethrough) for highlighting, straight from
 * the Lezer parser: @codemirror/lang-markdown would bring HTML, CSS and
 * JavaScript along for embedded blocks, three times the size of the editor.
 */
const markdownSource = new LanguageSupport(new Language(defineLanguageFacet(), markdownParser.configure(GFM), [], "markdown"));

/** markdown while you write: structure in weight and tone, never a raw colour (classes are in App.css) */
const noteHighlight = HighlightStyle.define([
  { tag: t.heading, class: "md-h" },
  { tag: t.strong, class: "md-strong" },
  { tag: t.emphasis, class: "md-em" },
  { tag: t.strikethrough, class: "md-strike" },
  { tag: [t.link, t.url], class: "md-link" },
  { tag: t.monospace, class: "md-code" },
  { tag: t.quote, class: "md-quote" },
  { tag: [t.processingInstruction, t.contentSeparator, t.labelName, t.meta], class: "md-mark" },
]);

// ---------- other people's carets ----------

const caretsMoved = StateEffect.define<null>();

class CaretWidget extends WidgetType {
  constructor(readonly c: PeerCaret) {
    super();
  }
  /** a new place is a new widget, so the name shows again each time they move */
  eq(o: CaretWidget) {
    return o.c.clientId === this.c.clientId && o.c.head === this.c.head && o.c.name === this.c.name && o.c.color === this.c.color;
  }
  toDOM() {
    const bar = document.createElement("span");
    bar.className = "note-caret";
    bar.style.setProperty("--peer", this.c.color);
    const name = document.createElement("span");
    name.className = "note-caret-name";
    name.textContent = this.c.name;
    bar.appendChild(name);
    return bar;
  }
  ignoreEvent() {
    return true;
  }
}

function caretDecorations(carets: PeerCaret[], length: number): DecorationSet {
  const out = [];
  for (const c of carets) {
    const from = Math.min(c.from, length);
    const to = Math.min(c.to, length);
    if (to > from) out.push(Decoration.mark({ class: "note-peer-sel", attributes: { style: `--peer: ${c.color}` } }).range(from, to));
    out.push(Decoration.widget({ widget: new CaretWidget(c), side: 1 }).range(Math.min(c.head, length)));
  }
  return Decoration.set(out, true);
}

function peerCarets(source: CaretSource): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private off: () => void;
      private raf = 0;
      private gone = false;
      constructor(readonly view: EditorView) {
        this.decorations = caretDecorations(source.get(), view.state.doc.length);
        // never dispatch from inside another update: wait for the microtask
        this.off = source.subscribe(() => queueMicrotask(() => !this.gone && this.view.dispatch({ effects: caretsMoved.of(null) })));
        this.publish();
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(caretsMoved)))) this.decorations = caretDecorations(source.get(), u.state.doc.length);
        if (u.selectionSet || u.focusChanged || u.docChanged) this.publish();
      }
      /** tell the others where I'm writing, at most once a frame */
      publish() {
        if (!source.publish || this.raf) return;
        this.raf = requestAnimationFrame(() => {
          this.raf = 0;
          if (this.gone || !this.view.hasFocus) return;
          const { anchor, head } = this.view.state.selection.main;
          source.publish!({ anchor, head });
        });
      }
      destroy() {
        this.gone = true;
        cancelAnimationFrame(this.raf);
        this.off();
      }
    },
    { decorations: (v) => v.decorations },
  );
}
