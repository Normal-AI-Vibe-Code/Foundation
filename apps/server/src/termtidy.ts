/**
 * What a command prints, tidied for the built-in terminal (2026-11-18, Josh: "return values without so many
 * new lines, just provide spacing between the commands to help make it readable").
 *
 * A shell with no terminal pads what it prints: PowerShell puts a blank line before a table and two after it,
 * an error is wrapped in blank lines, and some tools end with several. On a real terminal that scrolls by; in
 * a pane it pushes the next prompt off the screen. So, per command:
 *
 *  - blank lines before its first line of output are dropped;
 *  - a run of blank lines inside its output becomes one (a table's header still stands apart from its rows);
 *  - blank lines after its last line are dropped.
 *
 * The spacing between commands is then the terminal's own, and the same every time: one empty line before
 * each prompt (shell/Tools.tsx). Nothing else is changed: every line that has anything on it arrives as it was
 * printed, in order, as soon as it is printed (a line still being written is shown as it grows, so a question
 * a program asks without a newline is seen).
 */

export class TermTidy {
  /** this command has printed a line with something on it */
  private started = false;
  /** blank lines held back: shown as one if more output follows, dropped if the command ends */
  private blanks = 0;
  /** a line that has begun on screen and not ended */
  private mid = false;
  /** whitespace at the start of a line, held until we know whether the line has anything on it */
  private held = "";

  /** a chunk as the shell printed it; returns what to show (every line ending as \r\n) */
  push(chunk: string): string {
    let out = "";
    const text = this.held + chunk.replace(/\r\n/g, "\n");
    this.held = "";
    const lines = text.split("\n");
    const tail = lines.pop() ?? "";
    for (const line of lines) {
      if (this.mid) {
        // the rest of a line already begun
        out += `${line}\r\n`;
        this.mid = false;
        continue;
      }
      if (!line.trim()) {
        if (this.started) this.blanks++;
        continue;
      }
      out += this.lead() + `${line}\r\n`;
    }
    if (tail) {
      if (this.mid) out += tail;
      else if (!tail.trim()) this.held = tail;
      else {
        out += this.lead() + tail;
        this.mid = true;
      }
    }
    return out;
  }

  /** the command ended: what is left to show, and whether it printed anything at all */
  end(): { text: string; printed: boolean } {
    const text = this.mid ? "\r\n" : "";
    const printed = this.started;
    this.started = this.mid = false;
    this.blanks = 0;
    this.held = "";
    return { text, printed };
  }

  /** before a line with something on it: the one blank line a run of them comes down to */
  private lead(): string {
    const gap = this.started && this.blanks > 0 ? "\r\n" : "";
    this.blanks = 0;
    this.started = true;
    return gap;
  }
}
