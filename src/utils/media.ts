/** Downscale a dropped image file to a compact data URL for in-cell storage. */
export async function imageFileToDataURL(file: File, maxDim = 512): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.toDataURL("image/webp", 0.85);
}

/** Open a URL in the OS browser (Tauri), falling back to window.open. */
export async function openExternal(url: string) {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

export function linkLabel(url: string): { label: string; kind: "drive" | "web" } {
  try {
    const u = new URL(url);
    if (/(^|\.)drive\.google\.com$/.test(u.hostname)) return { label: "Google Drive", kind: "drive" };
    if (/(^|\.)docs\.google\.com$/.test(u.hostname)) {
      const kind = u.pathname.startsWith("/spreadsheets")
        ? "Google Sheet"
        : u.pathname.startsWith("/presentation")
          ? "Google Slides"
          : "Google Doc";
      return { label: kind, kind: "drive" };
    }
    return { label: u.hostname.replace(/^www\./, ""), kind: "web" };
  } catch {
    return { label: url, kind: "web" };
  }
}
