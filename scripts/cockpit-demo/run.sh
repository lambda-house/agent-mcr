#!/bin/bash
# The cockpit (MCR-96) in a window of its own, next to your live Agent MCR and
# without touching it:
#
#   scripts/cockpit-demo/run.sh          build, start, open the window
#   scripts/cockpit-demo/run.sh open     the same without building again
#   scripts/cockpit-demo/run.sh stop     end the demo's sessions and processes
#
# What keeps it apart from the live app:
#   - its own home folder (/tmp/mcr-cockpit-demo), so its own config folder,
#     store (harness-state.json) and sockets;
#   - its own runner and harness service, started here as plain processes of
#     this debug build. launchd is not asked, and the code refuses to take
#     over a launchd label another copy runs;
#   - a clean environment (env -i), because a terminal hosted by the live app
#     carries AGENT_MCR_HARNESS, which points tools at the live service;
#   - another app identifier and window title, so it is not taken for the
#     running app by the single-instance check or by you.
#   - `claude` in the demo is scripts/cockpit-demo/agent.sh: no model, no
#     account, no cost.
#
# In the window: click "Supervisor" at the top of the Live list. Its stand-in
# starts four executors, which publish sample tracks with cockpit_publish.
set -eu
repo="$(cd "$(dirname "$0")/../.." && pwd)"
demo="${COCKPIT_DEMO_HOME:-/tmp/mcr-cockpit-demo}"
bin="$demo/agent-mcr-demo"
clean() { env -i HOME="$demo" PATH="$demo/bin:/usr/bin:/bin:/usr/sbin:/sbin" SHELL=/bin/zsh USER="$(id -un)" LOGNAME="$(id -un)" LANG=en_US.UTF-8 TERM=xterm-256color COCKPIT_DEMO_BIN="$bin" "$@"; }
config="$demo/Library/Application Support/agent-mcr"

if [ "${1:-start}" = "stop" ]; then
  [ -x "$bin" ] && clean "$bin" --stop-background || true
  for f in "$demo"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; done
  rm -f "$demo"/*.pid
  echo "Demo stopped. Its folder stays: $demo"
  exit 0
fi

if [ "${1:-start}" != "open" ]; then
  [ -d "$repo/node_modules" ] || { echo "Run npm install in $repo first"; exit 1; }
  (cd "$repo" && npm run build >/dev/null)
  (cd "$repo/src-tauri" && TAURI_CONFIG='{"identifier":"cc.lambdahouse.agent-mcr.demo","productName":"Agent MCR demo","app":{"windows":[{"title":"COCKPIT DEMO - separate home, not your live app","width":1400,"height":900,"minWidth":1024,"minHeight":768,"resizable":true}]}}' cargo build)
  mkdir -p "$demo/bin" "$config"
  # A copy, so a later build does not replace the program the demo's runner, service and window are
  if ! cmp -s "$repo/src-tauri/target/debug/agent-mcr" "$bin"; then
    clean "$bin" --stop-background >/dev/null 2>&1 || true
    cp "$repo/src-tauri/target/debug/agent-mcr" "$bin"
  fi
  cp "$repo/scripts/cockpit-demo/agent.sh" "$demo/bin/claude"
  chmod +x "$demo/bin/claude"
  printf 'export PATH="$HOME/bin:/usr/bin:/bin:/usr/sbin:/sbin"\nexport COCKPIT_DEMO_BIN="%s"\n' "$bin" > "$demo/.zshenv"
  : > "$demo/.zshrc"
fi

if ! [ -S "$config/runner.sock" ] || ! kill -0 "$(cat "$demo/runner.pid" 2>/dev/null)" 2>/dev/null; then
  rm -f "$config/runner.sock"
  clean nohup "$bin" --runner >> "$demo/runner.out" 2>&1 &
  echo $! > "$demo/runner.pid"
  n=0; until [ -S "$config/runner.sock" ] || [ $n -ge 50 ]; do n=$((n+1)); /bin/sleep 0.1; done
fi
if ! [ -S "$config/harness.sock" ] || ! kill -0 "$(cat "$demo/harness.pid" 2>/dev/null)" 2>/dev/null; then
  rm -f "$config/harness.sock"
  clean nohup "$bin" --harness >> "$demo/harness.out" 2>&1 &
  echo $! > "$demo/harness.pid"
  n=0; until [ -S "$config/harness.sock" ] || [ $n -ge 50 ]; do n=$((n+1)); /bin/sleep 0.1; done
fi
[ -S "$config/runner.sock" ] && [ -S "$config/harness.sock" ] || { echo "The demo's runner or service did not start; see $demo/*.out"; exit 1; }

echo "Demo home: $demo"
# For a check without a window
[ "${1:-start}" = "services" ] && exit 0
echo "Opening the window. Click Supervisor at the top of the Live list."
clean "$bin" >> "$demo/app.out" 2>&1 &
echo $! > "$demo/app.pid"
echo "To end it: $0 stop"
