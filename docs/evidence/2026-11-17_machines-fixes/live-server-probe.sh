#!/bin/sh
# What a running Foundation server knows about machines' desktops, asked without signing in (nothing is changed):
# a route the server has answers 401 "sign in first"; one it doesn't have answers its router's 404 {"error":"not found"}.
#   sh live-server-probe.sh [server] [app page]
S=${1:-http://localhost:4410}
A=${2:-http://localhost:31440}
echo "# $S, $(date -u +%Y-%m-%dT%H:%MZ)"
for p in "POST /api/boards/company/machines/x/stop" "POST /api/boards/company/machines/x/desktop" "POST /api/boards/company/machines/x/agents" "GET /api/prefs" "POST /api/boards/company/machines/x/no-such-route"; do
  m=${p%% *}
  u=${p#* }
  printf '%-50s -> ' "$p"
  curl -s -m 5 -w ' (%{http_code})\n' -X "$m" "$S$u"
done
for s in tty vnc; do
  printf '%-50s -> ' "WS   /machines/company/x/$s (upgrade)"
  curl -s -m 5 -o /dev/null -w '%{http_code}\n' -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "$S/machines/company/x/$s"
done
echo
echo "# the installed app's own page, $A"
curl -s -m 5 -o /dev/null -w 'GET  /desktop.html -> %{http_code} %{content_type} %{size_download} bytes\n' "$A/desktop.html"
J=$(curl -s -m 5 "$A/desktop.html" | grep -o '/assets/desktop-[^"]*\.js' | head -n 1)
curl -s -m 5 -o /dev/null -w "GET  $J -> %{http_code} %{content_type} %{size_download} bytes\n" "$A$J"
