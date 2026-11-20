/** QMP and guest-agent JSON channels. IDs match replies; events never satisfy a request. */
import type { Readable, Writable } from "node:stream";

export class VmChannel {
  private serial = 0;
  private buffer = "";
  private pending = new Map<number, { resolve: (x: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private greeting: Promise<void>;
  private greeted!: () => void;
  private closed = false;
  constructor(input: Readable, private output: Writable, private qmp = false) {
    this.greeting = new Promise((resolve) => { this.greeted = resolve; });
    if (!qmp) this.greeted();
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.read(chunk));
    input.on("end", () => this.close());
    input.on("error", () => this.close());
    output.on("error", () => this.close());
  }
  private read(chunk: string) {
    this.buffer += chunk.replace(/[\xff\ufffd]/g, "");
    if (this.buffer.length > 4 * 1024 * 1024) return this.close();
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.QMP) { this.greeted(); continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.desc ?? "The VM refused the command"));
      else p.resolve(msg.return);
    }
  }
  async ready() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.greeting, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("QEMU did not open its control channel")), 8000); })]);
    } finally { clearTimeout(timer); }
    if (this.qmp) await this.call("qmp_capabilities");
  }
  call(execute: string, args?: object, timeout = 5000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("The VM connection is closed"));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`The VM did not answer ${execute}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.output.write(JSON.stringify({ execute, ...(args ? { arguments: args } : {}), id }) + "\n", (error) => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }
  close() {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("The VM connection closed")); }
    this.pending.clear();
  }
}
