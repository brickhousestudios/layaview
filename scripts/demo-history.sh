#!/bin/sh
# Import the prepared demo history (demo/history-fixture.json) into a running
# Layaview viewer through the ingest API — one command once the stack is up:
#
#   scripts/run-layaview.sh        # terminal 1: local Laya adapter + viewer
#   scripts/demo-history.sh        # terminal 2: imports the fixture in order
#
# The fixture's "@<item>:<question>" trigger placeholder is resolved to the
# real event id returned by the earlier ingest, so the branch survives import.
set -eu
cd "$(dirname "$0")/.."
PORT=${LAYAVIEW_PORT:-4777}
BASE="http://127.0.0.1:$PORT"
FIXTURE=${1:-demo/history-fixture.json}
if ! curl -fs "$BASE/_/api/records?limit=1" >/dev/null 2>&1; then
  echo "No Layaview viewer is answering at $BASE." >&2
  echo "Start the local stack first:  scripts/run-layaview.sh" >&2
  echo "Then run this script again in another terminal." >&2
  exit 1
fi
node --input-type=module -e '
import { readFileSync } from "node:fs";
const base = process.argv[1], fixture = JSON.parse(readFileSync(process.argv[2], "utf8"));
const events = {};
for (const [index, item] of fixture.entries()) {
  const envelope = { ...item };
  if (typeof envelope.trigger === "string" && envelope.trigger.startsWith("@")) {
    const target = events[envelope.trigger.slice(1)];
    if (!target) { console.error(`fixture item ${index + 1}: trigger ${envelope.trigger} has no earlier event`); process.exit(1); }
    envelope.trigger = target;
  }
  const response = await fetch(`${base}/_/api/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { console.error(`fixture item ${index + 1}: ingest failed with ${response.status}: ${body.error ?? "unknown error"}`); process.exit(1); }
  for (const [question, id] of Object.entries(body.events ?? {})) events[`${index}:${question}`] = id;
  const eventIds = Object.values(body.events ?? {});
  console.log(`item ${index + 1}: call ${eventIds[0]?.split(":")[0] ?? "?"} — events ${eventIds.join(", ")}`);
}
' "$BASE" "$FIXTURE"
echo "Demo history imported. Open $BASE to explore it."
