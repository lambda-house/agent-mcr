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
#     this debug build. launchd is not asked;
#   - launchd labels belong to the user, not to a home folder: a demo that
#     registered a LaunchAgent would take the live app's label whenever the
#     live runner is not running. So the demo home's Library/LaunchAgents is a
#     regular file (the program cannot create its plist there and stops before
#     it calls launchctl), and its background permission says "stopped". If the
#     demo's processes have ended, the window asks to allow background
#     processes: do not allow it there, run this script again instead;
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
# The same in the background, as the program itself and not a shell around it:
# the pid kept in a file is then the program's, which `ours` can check
spawn() { out="$1"; shift; ( exec env -i HOME="$demo" PATH="$demo/bin:/usr/bin:/bin:/usr/sbin:/sbin" SHELL=/bin/zsh USER="$(id -un)" LOGNAME="$(id -un)" LANG=en_US.UTF-8 TERM=xterm-256color COCKPIT_DEMO_BIN="$bin" "$@" >> "$out" 2>&1 ) & }
config="$demo/Library/Application Support/agent-mcr"

# The demo home is never the person's own home or anything in it (their app
# support folder is): the real home comes from the user database, not from $HOME.
real_home="$(cd "$(eval echo "~$(id -un)")" && pwd -P)"
case "$demo" in /*) ;; *) echo "COCKPIT_DEMO_HOME must be an absolute path"; exit 1;; esac
mkdir -p "$(dirname "$demo")"
demo_real="$(cd "$(dirname "$demo")" && pwd -P)/$(basename "$demo")"
case "$demo_real/" in
  "$real_home/"*|"/") echo "Refused: the demo home ($demo_real) must be outside your home folder ($real_home)"; exit 1;;
esac
case "$real_home/" in "$demo_real/"*) echo "Refused: the demo home ($demo_real) must not hold your home folder"; exit 1;; esac

# Whether a pid is a process of the demo's own program
ours() { case "$(ps -p "$1" -o command= 2>/dev/null)" in "$bin"|"$bin "*) return 0;; *) return 1;; esac; }
pid_in() { cat "$demo/$1.pid" 2>/dev/null || echo 0; }
running() { p="$(pid_in "$1")"; [ "$p" -gt 0 ] 2>/dev/null && ours "$p"; }

if [ "${1:-start}" = "stop" ]; then
  [ -x "$bin" ] && clean "$bin" --stop-background || true
  # A pid file may be old and its number another program's by now
  for name in app harness runner; do running "$name" && kill "$(pid_in "$name")" 2>/dev/null || true; done
  # And what an earlier run left without a pid file: only processes of the demo's own program path
  pkill -f "^$bin( --runner| --harness)?\$" 2>/dev/null || true
  rm -f "$demo"/*.pid
  echo "Demo stopped. Its folder stays: $demo"
  exit 0
fi

# Before anything of the demo starts: no LaunchAgent can be written from this home
mkdir -p "$demo/Library" "$config"
if [ -d "$demo/Library/LaunchAgents" ]; then
  echo "Refused: $demo/Library/LaunchAgents is a folder. Remove the demo home and start again."; exit 1
fi
[ -f "$demo/Library/LaunchAgents" ] || echo "A file on purpose: the cockpit demo must never register a LaunchAgent." > "$demo/Library/LaunchAgents"
echo stopped > "$config/background.state"

if [ "${1:-start}" != "open" ]; then
  [ -d "$repo/node_modules" ] || { echo "Run npm install in $repo first"; exit 1; }
  (cd "$repo" && npm run build >/dev/null)
  # TAURI_CONFIG replaces the window list whole, so the demo's window is the
  # app's own (with the macOS title bar of tauri.macos.conf.json) under another title
  window_config="$(cd "$repo/src-tauri" && node -e '
    const fs = require("fs");
    const file = fs.existsSync("tauri.macos.conf.json") && process.platform === "darwin" ? "tauri.macos.conf.json" : "tauri.conf.json";
    const w = JSON.parse(fs.readFileSync(file, "utf8")).app.windows[0];
    process.stdout.write(JSON.stringify({ ...w, title: "COCKPIT DEMO - separate home, not your live app" }));
  ')"
  (cd "$repo/src-tauri" && TAURI_CONFIG="{\"identifier\":\"cc.lambdahouse.agent-mcr.demo\",\"productName\":\"Agent MCR demo\",\"app\":{\"windows\":[$window_config]}}" cargo build)
  mkdir -p "$demo/bin" "$config"
  # A copy, so a later build does not replace the program the demo's runner, service and window are
  if ! cmp -s "$repo/src-tauri/target/debug/agent-mcr" "$bin"; then
    clean "$bin" --stop-background >/dev/null 2>&1 || true
    # A new file, not the old one written over: macOS kills a program whose
    # file changed under the signature it remembers
    rm -f "$bin"
    cp "$repo/src-tauri/target/debug/agent-mcr" "$bin"
  fi
  cp "$repo/scripts/cockpit-demo/agent.sh" "$demo/bin/claude"
  chmod +x "$demo/bin/claude"
  printf 'export PATH="$HOME/bin:/usr/bin:/bin:/usr/sbin:/sbin"\nexport COCKPIT_DEMO_BIN="%s"\n' "$bin" > "$demo/.zshenv"
  : > "$demo/.zshrc"
fi

# A unit is started only when none of the demo's runs: a pid file that is
# missing or old must not make a second one take the socket from the first
any() { pgrep -f "^$bin $1\$" >/dev/null 2>&1; }
if ! any --runner; then
  rm -f "$config/runner.sock"
  spawn "$demo/runner.out" nohup "$bin" --runner
  echo $! > "$demo/runner.pid"
  n=0; until [ -S "$config/runner.sock" ] || [ $n -ge 50 ]; do n=$((n+1)); /bin/sleep 0.1; done
fi
if ! any --harness; then
  rm -f "$config/harness.sock"
  spawn "$demo/harness.out" nohup "$bin" --harness
  echo $! > "$demo/harness.pid"
  n=0; until [ -S "$config/harness.sock" ] || [ $n -ge 50 ]; do n=$((n+1)); /bin/sleep 0.1; done
fi
[ -S "$config/runner.sock" ] && [ -S "$config/harness.sock" ] || { echo "The demo's runner or service did not start; see $demo/*.out"; exit 1; }

echo "Demo home: $demo"
# For a check without a window
[ "${1:-start}" = "services" ] && exit 0
if running app || pgrep -f "^$bin\$" >/dev/null 2>&1; then
  echo "The demo window is already open. Click Supervisor at the top of its Live list."
else
  echo "Opening the window. Click Supervisor at the top of the Live list."
  spawn "$demo/app.out" "$bin"
  echo $! > "$demo/app.pid"
fi
echo "To end it: $0 stop"
