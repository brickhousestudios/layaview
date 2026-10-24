#!/bin/sh
# Explicit runtime acceptance: real local Laya -> Layaview -> SQLite/readback.
# This is intentionally NOT part of npm test because it loads model weights.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
PYTHON="${LAYAVIEW_PYTHON:-$ROOT/.venv/bin/python}"
LAYA_PORT="${LAYAVIEW_CANARY_LAYA_PORT:-4878}"
VIEW_PORT="${LAYAVIEW_CANARY_VIEW_PORT:-4877}"
MODEL="${LAYA_MODEL:-convaiinnovations/laya-typed-decisions}"
DEVICE="${LAYA_DEVICE:-cpu}"
HF_HOME="${HF_HOME:-$HOME/BrickHouse/models/huggingface}"
export HF_HOME

if [ ! -x "$PYTHON" ]; then
  echo "Layaview canary: missing Python runtime: $PYTHON" >&2
  echo "Create .venv with Python >=3.10 and install laya==0.3.14 plus PyTorch." >&2
  exit 1
fi

"$PYTHON" - <<'PY'
import sys
if sys.version_info < (3, 10):
    raise SystemExit("Layaview canary requires Python >=3.10")
import laya  # noqa: F401
PY

TMP=$(mktemp -d "${TMPDIR:-/tmp}/layaview-real-canary.XXXXXX")
DATA_DIR="$TMP/data"
ADAPTER_LOG="$TMP/adapter.log"
VIEW_LOG="$TMP/view.log"
REQUEST="$TMP/request.json"
RESPONSE="$TMP/response.json"
RECORD="$TMP/record.json"

cleanup() {
  [ -n "${VIEW_PID:-}" ] && kill "$VIEW_PID" >/dev/null 2>&1 || true
  [ -n "${LAYA_PID:-}" ] && kill "$LAYA_PID" >/dev/null 2>&1 || true
  [ -n "${VIEW_PID:-}" ] && wait "$VIEW_PID" >/dev/null 2>&1 || true
  [ -n "${LAYA_PID:-}" ] && wait "$LAYA_PID" >/dev/null 2>&1 || true
  if [ "${LAYAVIEW_CANARY_KEEP:-0}" != "1" ]; then
    rm -rf "$TMP"
  else
    echo "Layaview canary evidence kept at: $TMP"
  fi
}
trap cleanup EXIT INT TERM HUP

mkdir -p "$DATA_DIR" "$HF_HOME"

port_free() {
  "$PYTHON" - "$1" <<'PY'
import socket, sys
s = socket.socket()
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    raise SystemExit(1)
finally:
    s.close()
PY
}

for port in "$LAYA_PORT" "$VIEW_PORT"; do
  if ! port_free "$port"; then
    echo "Layaview canary: port $port is already in use" >&2
    exit 1
  fi
done

INSTANCE="real-canary-$$"
LAYA_MODEL="$MODEL" LAYA_DEVICE="$DEVICE" LAYAVIEW_INSTANCE_TOKEN="$INSTANCE" \
  "$PYTHON" "$ROOT/adapter/laya_server.py" --port "$LAYA_PORT" >"$ADAPTER_LOG" 2>&1 &
LAYA_PID=$!

ready=0
i=0
while [ "$i" -lt 180 ]; do
  if ! kill -0 "$LAYA_PID" >/dev/null 2>&1; then
    cat "$ADAPTER_LOG" >&2
    echo "Layaview canary: Laya adapter exited during model load" >&2
    exit 1
  fi
  if "$PYTHON" - "$LAYA_PORT" "$INSTANCE" >/dev/null 2>&1 <<'PY'
import json, sys, urllib.request
with urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/healthz", timeout=1) as r:
    value = json.load(r)
    if r.status != 200 or value.get("instance") != sys.argv[2]:
        raise SystemExit(1)
PY
  then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  cat "$ADAPTER_LOG" >&2
  echo "Layaview canary: Laya adapter did not become healthy within 180 seconds" >&2
  exit 1
fi

node --experimental-strip-types "$ROOT/layaview.ts" \
  --port "$VIEW_PORT" \
  --dir "$DATA_DIR" \
  --laya-endpoint "http://127.0.0.1:$LAYA_PORT/v1/systemone" >"$VIEW_LOG" 2>&1 &
VIEW_PID=$!

ready=0
i=0
while [ "$i" -lt 30 ]; do
  if ! kill -0 "$VIEW_PID" >/dev/null 2>&1; then
    cat "$VIEW_LOG" >&2
    echo "Layaview canary: viewer exited during startup" >&2
    exit 1
  fi
  if curl -fsS --max-time 1 "http://127.0.0.1:$VIEW_PORT/" >/dev/null 2>&1; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  cat "$VIEW_LOG" >&2
  echo "Layaview canary: viewer did not become healthy" >&2
  exit 1
fi

cat >"$REQUEST" <<JSON
{
  "model": "$MODEL",
  "state": {
    "observation": "The agent said deployment succeeded, but the health endpoint returned HTTP 503 and no artifact checksum was recorded.",
    "context": "Classify the evidence quality of this agent run."
  },
  "questions": {
    "assessment": {
      "type": "choice",
      "instructions": "Which description best matches the run evidence?",
      "criteria": {
        "verified_success": "Success is supported by direct runtime evidence.",
        "unsupported_success_claim": "The agent claims success but the runtime evidence does not support it.",
        "ordinary_failure": "The run failed and the agent did not claim success."
      }
    },
    "severity": {
      "type": "score",
      "instructions": "How serious is the evidence problem?",
      "criteria": ["none", "minor", "material", "critical"]
    }
  }
}
JSON

curl -fsS --max-time 120 \
  -H "content-type: application/json" \
  --data-binary "@$REQUEST" \
  "http://127.0.0.1:$VIEW_PORT/brickhouse-real-canary/v1/systemone" >"$RESPONSE"

curl -fsS --max-time 10 "http://127.0.0.1:$VIEW_PORT/_/api/records/1" >"$RECORD"

"$PYTHON" "$ROOT/scripts/validate_real_laya_canary.py" \
  "$REQUEST" \
  "$RESPONSE" \
  "$RECORD" \
  "$MODEL" \
  "$DATA_DIR/layaview.sqlite" \
  "$ADAPTER_LOG"
