#!/usr/bin/env python3
"""Loopback System One-compatible adapter for a local Laya decision model."""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import re
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from numbers import Number
from typing import Any

import laya

MODEL_NAME = os.environ.get("LAYA_MODEL", "convaiinnovations/laya-typed-decisions")
DEVICE = os.environ.get("LAYA_DEVICE", "cpu")
INSTANCE_TOKEN = os.environ.get("LAYAVIEW_INSTANCE_TOKEN", "")
BODY_LIMIT = 16 * 1024 * 1024
PREDICT_LOCK = threading.Lock()
LOOPBACK_HOST = re.compile(r"^(127\.0\.0\.1|\[::1\]|([a-z0-9-]+\.)*localhost)(:\d+)?$", re.IGNORECASE)

print(json.dumps({"event": "loading", "model": MODEL_NAME, "device": DEVICE}), flush=True)
with warnings.catch_warnings(record=True) as captured_load_warnings:
    warnings.simplefilter("always")
    AGENT = laya.load(MODEL_NAME, device=DEVICE)
LOAD_WARNINGS = [str(item.message) for item in captured_load_warnings]
for message in LOAD_WARNINGS:
    print(json.dumps({"event": "runtime_warning", "phase": "load", "message": message}), file=sys.stderr, flush=True)
print(json.dumps({"event": "loaded", "model": MODEL_NAME, "device": DEVICE}), flush=True)


def jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, Number):
        return value.item() if hasattr(value, "item") else float(value)
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if hasattr(value, "model_dump"):
        return jsonable(value.model_dump())
    if hasattr(value, "dict"):
        return jsonable(value.dict())
    if hasattr(value, "item"):
        return jsonable(value.item())
    if hasattr(value, "__dict__"):
        return jsonable(vars(value))
    raise TypeError(f"cannot encode {type(value).__name__}")


def normalize_answer(answer: Any) -> Any:
    """Make Laya output JSON-safe without inventing model fields."""
    return jsonable(answer)


def is_calibration_warning(message: str) -> bool:
    """A captured warning is a calibration warning when it says model confidences cannot be trusted:
    either it calls them uncalibrated outright, or it reports temperature entries being adjusted
    (clamped, out of range, outside their bounds, invalid). Matches the real Laya 0.3.14 wording:
    "invalid temperatures or values outside [0.5, 5] ... Treat confidence ... as uncalibrated." """
    text = message.lower()
    if "uncalibrated" in text:
        return True
    return "temperature" in text and any(word in text for word in ("clamp", "range", "outside", "invalid"))


def runtime_metadata(messages: list[str]) -> dict[str, Any]:
    calibration_warning = any(is_calibration_warning(message) for message in messages)
    return {
        "calibration": "warning" if calibration_warning else "unspecified",
        "warnings": messages,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "LayaviewLaya/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def send_json(self, status: int, value: Any) -> None:
        payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def allowed_request(self) -> bool:
        host = self.headers.get("host", "")
        if not LOOPBACK_HOST.match(host):
            self.send_json(403, {"error": "host not allowed"})
            return False
        origin = self.headers.get("origin")
        if origin is not None:
            origin_host = re.sub(r"^https?://", "", origin, flags=re.IGNORECASE)
            if not LOOPBACK_HOST.match(origin_host):
                self.send_json(403, {"error": "requests cannot come from a page on another site"})
                return False
        return True

    def do_GET(self) -> None:
        if not self.allowed_request():
            return
        if self.path == "/healthz":
            self.send_json(200, {"ok": True, "backend": "laya", "model": MODEL_NAME, "device": DEVICE, "instance": INSTANCE_TOKEN, "runtime": runtime_metadata(LOAD_WARNINGS)})
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if not self.allowed_request():
            return
        if self.path != "/v1/systemone":
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self.send_json(400, {"error": "invalid content-length"})
            return
        if length <= 0:
            self.send_json(400, {"error": "request body required"})
            return
        if length > BODY_LIMIT:
            self.send_json(413, {"error": f"request body exceeds {BODY_LIMIT} bytes"})
            return
        try:
            request = json.loads(self.rfile.read(length))
        except Exception as exc:
            self.send_json(400, {"error": f"invalid JSON: {exc}"})
            return
        if not isinstance(request, dict) or "state" not in request or not isinstance(request.get("questions"), dict):
            self.send_json(400, {"error": "send { model, state, questions } with questions as an object"})
            return

        questions = request["questions"]
        try:
            with PREDICT_LOCK, warnings.catch_warnings(record=True) as captured_predict_warnings:
                warnings.simplefilter("always")
                raw = AGENT.predict(request["state"], questions)
            predict_warnings = [str(item.message) for item in captured_predict_warnings]
            for message in predict_warnings:
                print(json.dumps({"event": "runtime_warning", "phase": "predict", "message": message}), file=sys.stderr, flush=True)
            normalized = jsonable(raw)
            answers = normalized.get("answers") if isinstance(normalized, dict) and isinstance(normalized.get("answers"), dict) else normalized
            if isinstance(answers, dict):
                answers = {str(qid): normalize_answer(answer) for qid, answer in answers.items()}
            if not isinstance(answers, dict):
                raise TypeError("Laya returned a non-object answer set")
            missing = [qid for qid in questions if qid not in answers]
            if missing:
                raise ValueError("Laya omitted answer(s): " + ", ".join(missing))
            self.send_json(200, {"model": MODEL_NAME, "answers": answers, "runtime": runtime_metadata(LOAD_WARNINGS + predict_warnings)})
        except Exception as exc:
            self.send_json(500, {"error": f"Laya inference failed: {type(exc).__name__}: {exc}"})


def main() -> None:
    parser = argparse.ArgumentParser(description="Local Laya adapter for Layaview")
    parser.add_argument("--port", type=int, default=int(os.environ.get("LAYA_PORT", "4778")))
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        raise SystemExit("port must be between 1 and 65535")

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(json.dumps({
        "event": "listening",
        "address": f"http://127.0.0.1:{args.port}",
        "system_one": f"http://127.0.0.1:{args.port}/v1/systemone",
        "health": f"http://127.0.0.1:{args.port}/healthz",
        "model": MODEL_NAME,
        "device": DEVICE,
    }), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
