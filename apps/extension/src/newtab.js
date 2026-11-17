// Every new tab is Today: go to Foundation's Today page (its own origin, so the person's sign-in applies).
import { foundationUrl, night, todayUrl } from "./store.js";

night();
const base = await foundationUrl();
document.getElementById("where").textContent = base;
location.replace(todayUrl(base));
