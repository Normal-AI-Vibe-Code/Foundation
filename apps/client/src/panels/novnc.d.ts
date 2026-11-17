/** noVNC's RFB client (MPL-2.0), the parts desktopFrame.ts uses. noVNC ships no types. */
declare module "@novnc/novnc/core/rfb.js" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: { shared?: boolean; credentials?: { password?: string }; wsProtocols?: string[] });
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    background: string;
    disconnect(): void;
    focus(): void;
    blur(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    /** sets the machine's clipboard (x11vnc puts it on the X selection) */
    clipboardPasteFrom(text: string): void;
  }
}

declare module "@novnc/novnc/core/input/keysymdef.js" {
  /** a Unicode code point's X keysym */
  const keysyms: { lookup(codepoint: number): number };
  export default keysyms;
}
