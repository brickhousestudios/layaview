#!/bin/sh
# Start the local Laya adapter, wait for it to become healthy, then run Layaview.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
LAYA_PORT="${LAYA_PORT:-4778}"
LAYAVIEW_PORT="${LAYAVIEW_PORT:-4777}"
HF_HOME="${HF_HOME:-$HOME/BrickHouse/models/huggingface}"
export HF_HOME

if [ -n "${LAYAVIEW_PYTHON:-}" ]; then
  PYTHON="$LAYAVIEW_PYTHON"
elif [ -x "$HOME/BrickHouse/laya-test/.venv/bin/python" ]; then
  PYTHON="$HOME/BrickHouse/laya-test/.venv/bin/python"
elif [ -x "$ROOT/.venv/bin/python" ]; then
  PYTHON="$ROOT/.venv/bin/python"
else
  PYTHON="$(command -v python3 || true)"
fi

if [ -z "$PYTHON" ] || [ ! -x "$PYTHON" ]; then
  echo "Layaview: no Python runtime found. Set LAYAVIEW_PYTHON to the Laya environment." >&2
  exit 1
fi
if ! "$PYTHON" -c 'import laya' >/dev/null 2>&1; then
  echo "Layaview: $PYTHON does not have the laya package. See adapter/README.md." >&2
  exit 1
fi
LAYAVIEW_INSTANCE_TOKEN="${LAYAVIEW_INSTANCE_TOKEN:-$("$PYTHON" -c 'import secrets; print(secrets.token_hex(16))')}"
export LAYAVIEW_INSTANCE_TOKEN
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

for port in "$LAYA_PORT" "$LAYAVIEW_PORT"; do
  if ! port_free "$port"; then
    echo "Layaview: TCP port $port is already in use." >&2
    exit 1
  fi
done

LOG_DIR="${LAYAVIEW_LOG_DIR:-$HOME/.local/state/layaview}"
mkdir -p "$LOG_DIR"
"$PYTHON" "$ROOT/adapter/laya_server.py" --port "$LAYA_PORT" >"$LOG_DIR/laya-adapter.log" 2>&1 &
LAYA_PID=$!
cleanup() {
  kill "$LAYA_PID" >/dev/null 2>&1 || true
  wait "$LAYA_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM HUP

ready=0
i=0
while [ "$i" -lt 120 ]; do
  if ! kill -0 "$LAYA_PID" >/dev/null 2>&1; then
    echo "Layaview: Laya adapter exited during startup. See $LOG_DIR/laya-adapter.log" >&2
    exit 1
  fi
  if "$PYTHON" - "$LAYA_PORT" "$LAYAVIEW_INSTANCE_TOKEN" >/dev/null 2>&1 <<'PY'
import json, sys, urllib.request
with urllib.request.urlopen(f"http://127.0.0.1:{sys.argv[1]}/healthz", timeout=1) as r:
    value = json.load(r)
    if r.status != 200 or value.get("instance") != sys.argv[2]:
        raise SystemExit(1)
PY
  then ready=1; break; fi
  if ! kill -0 "$LAYA_PID" >/dev/null 2>&1; then
    echo "Layaview: Laya adapter exited during startup. See $LOG_DIR/laya-adapter.log" >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "Layaview: Laya adapter did not become healthy within 120 seconds." >&2
  exit 1
fi

echo "Layaview: Laya is healthy on 127.0.0.1:$LAYA_PORT"
"$ROOT/launch.sh" --port "$LAYAVIEW_PORT" --laya-endpoint "http://127.0.0.1:$LAYA_PORT/v1/systemone" "$@"
