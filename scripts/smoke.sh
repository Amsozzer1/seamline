#!/usr/bin/env bash
# End-to-end checks against a running server: state-machine conflicts, the scripted
# fault, concurrent retries, and the SSE stream. Usage: scripts/smoke.sh [base_url]
# Resets the demo data before and after, so it is safe to run against the public demo.
set -euo pipefail
BASE="${1:-http://localhost:3001}"
pass=0
fail() { echo "FAIL: $*"; exit 1; }
ok() { echo "ok   $*"; pass=$((pass + 1)); }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

curl -sf -X POST "$BASE/api/demo/reset" >/dev/null
REV=$(curl -sf "$BASE/api/panels" | json "[p for p in d if p['name'].startswith('MP-101')][0]['revision_id']")
PANEL=$(curl -sf "$BASE/api/panels" | json "[p for p in d if p['name'].startswith('MP-101')][0]['id']")

# --- revision state machine ---
[ "$(code -X PUT "$BASE/api/revisions/$REV" -H 'content-type: application/json' -d '{"spec":{"name":"x"},"steps":[]}')" = 422 ] && ok "bad plan -> 422" || fail "bad plan"
BODY=$(mktemp)
curl -sf "$BASE/api/revisions/$REV" | json "json.dumps({'spec': {**d['spec'], 'name': 'Smoke test panel'}, 'steps': d['steps']})" >"$BODY"
STEPS=$(json "json.dumps(d['steps'])" <"$BODY")
[ "$(code -X PUT "$BASE/api/revisions/$REV" -H 'content-type: application/json' -d @"$BODY")" = 409 ] && ok "edit released -> 409" || fail "edit released"
[ "$(code -X POST "$BASE/api/revisions/$REV/release")" = 409 ] && ok "release released -> 409" || fail "release released"
[ "$(code -X POST "$BASE/api/revisions/$REV/revise")" = 409 ] && ok "revise locked sample -> 409" || fail "revise locked"
[ "$(code "$BASE/api/revisions/not-a-uuid")" = 404 ] && ok "bad uuid -> 404" || fail "bad uuid"

DUP=$(curl -sf -X POST "$BASE/api/panels/$PANEL/duplicate" | json "d['revision_id']")
[ "$(code -X PUT "$BASE/api/revisions/$DUP" -H 'content-type: application/json' -d @"$BODY")" = 200 ] && ok "edit duplicate draft -> 200" || fail "edit draft"
[ "$(code -X POST "$BASE/api/revisions/$DUP/runs" -H 'content-type: application/json' -d '{}')" = 409 ] && ok "run a draft -> 409" || fail "run draft"
[ "$(code -X POST "$BASE/api/revisions/$DUP/release")" = 200 ] && ok "release draft -> 200" || fail "release draft"
[ "$(code -X POST "$BASE/api/revisions/$DUP/revise")" = 201 ] && ok "revise -> new draft" || fail "revise"
[ "$(code -X POST "$BASE/api/revisions/$DUP/revise")" = 409 ] && ok "second draft -> 409" || fail "second draft"

# --- run: scripted fault, concurrent retry, completion ---
RUN=$(curl -sf -X POST "$BASE/api/revisions/$REV/runs" -H 'content-type: application/json' -d '{"speed":10}' | json "d['run_id']")
LIVE=$(mktemp)
curl -sN --max-time 6 "$BASE/api/runs/$RUN/stream" >"$LIVE" || true &
[ "$(code -X POST "$BASE/api/revisions/$REV/runs" -H 'content-type: application/json' -d '{"speed":10}')" = 409 ] && ok "second run while running -> 409" || fail "double run"
[ "$(code -X POST "$BASE/api/runs/$RUN/actions" -H 'content-type: application/json' -d '{"action":"retry"}')" = 409 ] && ok "retry while running -> 409" || fail "retry running"

for _ in $(seq 1 100); do
  S=$(curl -sf "$BASE/api/runs/$RUN" | json "d['status']"); [ "$S" = faulted ] && break; sleep 0.2
done
[ "$S" = faulted ] && ok "scripted fault reached" || fail "no fault (status $S)"
[ "$(code -X POST "$BASE/api/runs/$RUN/actions" -H 'content-type: application/json' -d '{"action":"skip"}')" = 422 ] && ok "skip without reason -> 422" || fail "skip reason"

# Two operators click Retry at the same moment: exactly one wins.
A=$(mktemp); B=$(mktemp)
code -X POST "$BASE/api/runs/$RUN/actions" -H 'content-type: application/json' -d '{"action":"retry"}' >"$A" &
code -X POST "$BASE/api/runs/$RUN/actions" -H 'content-type: application/json' -d '{"action":"retry"}' >"$B" &
wait
[ "$(sort "$A" "$B" | tr '\n' ' ')" = "200 409 " ] && ok "concurrent retry: one 200, one 409" || fail "concurrent retry: $(cat "$A" "$B")"

for _ in $(seq 1 300); do
  S=$(curl -sf "$BASE/api/runs/$RUN" | json "d['status']"); [ "$S" = complete ] && break; sleep 0.2
done
[ "$S" = complete ] && ok "run completes after retry" || fail "run did not complete ($S)"

# --- SSE replay: every step started and finished exactly once, in order ---
EVENTS=$(curl -sN --max-time 2 "$BASE/api/runs/$RUN/stream" || true)
NSTEPS=$(echo "$STEPS" | json "len(d)")
python3 - "$NSTEPS" <<PY || fail "event log"
import json, sys
n = int(sys.argv[1])
evs = [json.loads(l[6:]) for l in """$EVENTS""".splitlines() if l.startswith("data: ")]
ids = [e["id"] for e in evs]
assert ids == sorted(set(ids)), "ids not strictly increasing"
done = [e["step"] for e in evs if e["kind"] == "step_done"]
assert done == list(range(n)), f"step_done out of order or duplicated: {done[:10]}..."
assert [e["kind"] for e in evs].count("retry") == 1, "expected one retry"
assert evs[-1]["kind"] == "complete"
live = [json.loads(l[6:]) for l in open("$LIVE").read().splitlines() if l.startswith("data: ")]
assert live, "no live events captured"
assert all(type(e["id"]) is int for e in evs + live), "event ids must be integers (string ids sort wrongly)"
PY
ok "SSE live + replay: integer ids, ordered, no duplicate steps, one retry, ends complete"

# Leave the demo as a visitor would expect to find it.
curl -sf -X POST "$BASE/api/demo/reset" >/dev/null
echo "$pass checks passed"
