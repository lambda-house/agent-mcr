#!/bin/bash
# A stand-in for an agent in the cockpit demo (scripts/cockpit-demo/run.sh).
# The demo's home folder has this file on its PATH as `claude`, so the demo
# harness starts it where it would start Claude Code. It calls no model and
# reads no account: it reports states through the harness's own hook command
# and publishes sample cockpit data through the harness's own tools, as an
# agent would, and then waits for keys.
bin="${COCKPIT_DEMO_BIN:?run it through scripts/cockpit-demo/run.sh}"
me="${AGENT_MCR_SESSION:-}"
sid=""; last=""
while [ $# -gt 0 ]; do
  [ "$1" = "--session-id" ] && sid="${2:-}"
  last="$1"; shift
done
hook() { printf '{"session_id":"%s","hook_event_name":"%s"%s}' "$sid" "$1" "${2:-}" | "$bin" --harness-hook "$1" >/dev/null 2>&1; }
tool() { "$bin" --harness-tool "$1" "$2" 2>&1; }
# The first "id" of a tool's answer
id_of() { sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' | head -1; }
# The id of the report a `report` call made
report_of() { grep -o '"r[0-9a-f]\{6,\}"' | head -1 | tr -d '"'; }
say() { printf '%s\n' "$*"; }

# An executor is told its part in its first task. Only a session without such a
# task, in the Supervisor's folder, plays the Supervisor: its executors start in
# that same folder, and must never start executors of their own in turn.
role="${last#demo:}"
if [ "$role" = "$last" ]; then
  role=""
  [ "$(basename "$PWD")" = "supervisor" ] && role="supervisor"
fi

say "Cockpit demo agent (${role:-idle}). No model is called here; this is a script."
hook SessionStart
hook UserPromptSubmit

case "$role" in
supervisor)
  say "Starting four executors..."
  builder=$(tool executor_create '{"name":"Store load","role":"implementer of MCR-99","task":"demo:builder"}' | id_of)
  panel=$(tool executor_create '{"name":"Cockpit panel","role":"implementer of MCR-96","task":"demo:panel"}' | id_of)
  tool executor_create '{"name":"Reviewer","role":"reviewer","task":"demo:reviewer"}' >/dev/null
  tool executor_create '{"name":"Docs","role":"writer","task":"demo:docs"}' >/dev/null
  tool set_status '{"text":"four executors run; waiting for the owner on two points"}' >/dev/null
  # The executors publish their own tracks; the Supervisor adds the order and a question of its own
  n=0
  until tool cockpit_read '{}' | grep -q '"id": *"panel"' || [ $n -ge 30 ]; do n=$((n+1)); /bin/sleep 1; done
  # `order` is the Supervisor's alone, so this call goes through its own server
  "$bin" --supervisor-tool cockpit_publish "{\"order\":[{\"by\":\"$builder\",\"id\":\"store\"},{\"by\":\"$panel\",\"id\":\"panel\"}],\"actions\":[{\"id\":\"next-slice\",\"title\":\"Choose the slice after the panel\",\"kind\":\"decision\",\"options\":[\"MCR-97 click actions\",\"MCR-98 Board removal\"],\"recommended\":\"MCR-97 click actions\",\"why\":\"The Board can go only when the cockpit shows the reports and has its actions.\",\"risk\":\"reversible\",\"urgency\":\"whenever\",\"source\":[\"MCR-94\"]}]}" 2>&1
  hook Stop
  ;;
builder)
  tool set_status '{"text":"MCR-99 reviewed; waits for the merge word"}' >/dev/null
  tool wait_register '{"kind":"pipeline","on":"CI run on mcr-99-store-load","ref":"mcr-99-store-load","expect_hours":0.5}' >/dev/null
  report=$(tool report '{"kind":"needs_human","text":"MCR-99 is approved by the reviewer. Merge needs your word typed here."}' | report_of)
  tool cockpit_publish "{\"tracks\":[{\"id\":\"store\",\"title\":\"Store load never loses the state file\",\"refs\":[\"MCR-99\"],\"state\":\"waiting_human\",\"line\":\"reviewed and approved; merge waits for your word\",\"items\":[{\"id\":\"fix\",\"title\":\"keep an unread file aside\",\"ref\":\"MCR-99\",\"owner\":\"$me\",\"state\":\"done\"},{\"id\":\"ci\",\"title\":\"Linux and Windows jobs\",\"owner\":\"$me\",\"state\":\"waiting\"},{\"id\":\"merge\",\"title\":\"merge to main\",\"ref\":\"MCR-99\",\"owner\":\"human\",\"state\":\"waiting\",\"waitsOn\":{\"kind\":\"human\",\"what\":\"your word\"},\"next\":\"build, then your service restart\"}]}],\"actions\":[{\"id\":\"merge-word\",\"track\":\"store\",\"item\":\"merge\",\"title\":\"Give the word to merge MCR-99\",\"kind\":\"typed_word\",\"where\":{\"session\":\"$me\"},\"say\":\"merge MCR-99\",\"why\":\"Review is done; nothing else is open on this branch.\",\"blocks\":[\"merge\"],\"risk\":\"irreversible\",\"urgency\":\"today\",\"source\":[\"$report\",\"MCR-99\"]}]}"
  hook Stop
  ;;
panel)
  tool set_status '{"text":"MCR-96: panel drawn, tests being written"}' >/dev/null
  tool cockpit_publish "{\"tracks\":[{\"id\":\"panel\",\"title\":\"Cockpit panel over the Supervisor terminal\",\"refs\":[\"MCR-96\",\"MCR-94\"],\"state\":\"moving\",\"line\":\"panel drawn; tests for ordering and stale marks in work\",\"items\":[{\"id\":\"view\",\"title\":\"needs-you rows and tracks\",\"ref\":\"MCR-96\",\"owner\":\"$me\",\"state\":\"review\"},{\"id\":\"tests\",\"title\":\"ordering, join, stale marks\",\"owner\":\"$me\",\"state\":\"doing\",\"next\":\"hand in for review\"}]}],\"actions\":[{\"id\":\"look\",\"track\":\"panel\",\"title\":\"Look at the panel in the demo window\",\"kind\":\"live_check\",\"detail\":\"Open the Supervisor session and compare the rows with the session list on the left.\",\"where\":{\"command\":\"scripts/cockpit-demo/run.sh\"},\"risk\":\"reversible\",\"urgency\":\"whenever\",\"source\":[\"MCR-96\"]}]}"
  ;;
reviewer)
  tool set_status '{"text":"reviewing mcr-99-store-load"}' >/dev/null
  say ""
  say "  Bash command: cargo test -- --test-threads=1"
  say "  Do you want to proceed?  1. Yes   2. No"
  hook Notification ',"notification_type":"permission_prompt","message":"Claude needs your permission to use Bash"'
  ;;
docs)
  tool cockpit_publish '{"tracks":[{"id":"docs","title":"Design note for the cockpit","refs":["MCR-94"],"state":"parked","line":"parked until the panel is reviewed"}]}'
  say "This one ends now, so its track shows as published by a session that ended."
  /bin/sleep 3
  exit 0
  ;;
esac

say ""
say "(Keys typed here go nowhere. Close the session from its row menu.)"
while IFS= read -r line; do say "(demo agent: nothing is run or sent)"; done
