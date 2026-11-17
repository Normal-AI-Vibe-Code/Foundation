import { clean, foundationUrl, managedUrl, night, setFoundationUrl } from "./store.js";

night();
const input = document.getElementById("url");
const said = document.getElementById("said");
input.value = await foundationUrl();
// set by the company's admin for everyone: shown, not changed here
if (await managedUrl()) {
  input.disabled = true;
  document.querySelector("#form button").hidden = true;
  said.textContent = "Set by your company's administrator for everyone.";
}
document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const url = clean(input.value);
    const origin = `${new URL(url).origin}/*`;
    // localhost is granted at install; anywhere else, Chrome asks the person once
    const perms = globalThis.chrome?.permissions;
    if (perms && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
      const ok = await perms.request({ origins: [origin] });
      if (!ok) return (said.textContent = "Chrome didn't allow it, so the popup can't show your day. New tabs will still open Today.");
    }
    await setFoundationUrl(url);
    said.textContent = `Saved. New tabs open ${url}.`;
  } catch (err) {
    said.textContent = err.message;
  }
});
