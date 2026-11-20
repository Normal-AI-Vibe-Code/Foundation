// A stand-in cloudflared for checks (machines-kiri.spec.ts): it says a quick tunnel's link the way cloudflared
// does, on stderr, and stays until it's ended. Nothing goes to Cloudflare.
const url = process.argv[process.argv.indexOf("--url") + 1] ?? "?";
const name = `standin-${Math.random().toString(36).slice(2, 8)}`;
process.stderr.write(`INF Requesting new quick Tunnel on trycloudflare.com...\nINF +--------------------------------------------------------------------------------------------+\nINF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\nINF |  https://${name}.trycloudflare.com                                     |\nINF +--------------------------------------------------------------------------------------------+\nINF (stand-in for ${url})\n`);
setInterval(() => {}, 1 << 30);
