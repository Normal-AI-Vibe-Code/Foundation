/**
 * Where Foundation is, in order: what the company's admin set for everyone
 * (chrome.storage.managed, from Chrome policy: managed_schema.json), then what
 * this person chose in the options (chrome.storage.sync, follows their Chrome
 * profile; localStorage when these pages are opened as plain pages), then the
 * address the build was made with.
 */
import { DEFAULT_URL } from "./config.js";

const chromeStore = globalThis.chrome?.storage?.sync;
const managedStore = globalThis.chrome?.storage?.managed;

/** the admin's address (Chrome policy), or null when none is set */
export async function managedUrl() {
  if (!managedStore) return null;
  try {
    const { foundationUrl: url } = await managedStore.get("foundationUrl");
    return url ? clean(url) : null;
  } catch {
    // no policy store on this platform, or a value that isn't an http(s) address: fall through
    return null;
  }
}

export async function foundationUrl() {
  const managed = await managedUrl();
  if (managed) return managed;
  let url;
  if (chromeStore) url = (await chromeStore.get("foundationUrl")).foundationUrl;
  else {
    try {
      url = localStorage.getItem("foundationUrl");
    } catch {
      /* no storage */
    }
  }
  return clean(url || DEFAULT_URL);
}

export async function setFoundationUrl(url) {
  const u = clean(url);
  if (chromeStore) await chromeStore.set({ foundationUrl: u });
  else localStorage.setItem("foundationUrl", u);
  return u;
}

/** an http(s) origin (and path, if Foundation is served under one), no trailing slash */
export function clean(url) {
  const u = new URL(String(url).trim());
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Foundation's address starts with http:// or https://");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** Today on Foundation, marked as opened from Chrome */
export const todayUrl = (base) => `${base}/?from=chrome#/today`;

export function night() {
  if (globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches) document.documentElement.classList.add("is-night");
}
