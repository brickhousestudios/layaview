#!/usr/bin/env python3
"""Validate one explicit real-Laya acceptance record without running inference."""

import json
import os
import stat
import sys


class CanaryValidationError(ValueError):
    pass


def fail(message):
    raise CanaryValidationError(message)


def loaded_model(log, model):
    for line in log.splitlines():
        try:
            value = json.loads(line)
        except Exception:
            continue
        if isinstance(value, dict) and value.get("event") == "loaded" and value.get("model") == model:
            return True
    return False


def validate_canary(request, response, record, model, db_path, adapter_log):
    if response.get("model") != model:
        fail("wrong response model: %r" % (response.get("model"),))

    questions = request.get("questions")
    if not isinstance(questions, dict) or not questions:
        fail("canary request has no question object")
    question_ids = set(questions)

    answers = response.get("answers")
    if not isinstance(answers, dict) or not answers:
        fail("real Laya response has no answer object")
    if set(answers) != question_ids:
        fail("real Laya answer ids do not exactly match requested question ids")

    events = response.get("events")
    if not isinstance(events, dict) or set(events) != question_ids:
        fail("Layaview did not add one event id per requested question")

    if not loaded_model(adapter_log, model):
        fail("adapter log does not prove that the requested real model loaded")

    persisted_request = record.get("request")
    persisted_response = record.get("response")
    if persisted_request != request:
        fail("persisted request does not match the exact canary input")
    if not isinstance(persisted_response, dict) or persisted_response.get("model") != model:
        fail("persisted response is missing the real model identity")
    if persisted_response.get("answers") != answers:
        fail("persisted answers differ from the real model answers")

    summary = record.get("summary") or {}
    record_id = summary.get("id")
    if not isinstance(record_id, int) or record_id < 1:
        fail("persisted record has no valid positive integer id")
    if summary.get("answeredBy") != model or summary.get("status") != 200:
        fail("record summary does not identify successful real-model inference")

    for question_id in question_ids:
        expected = "%s:%s" % (record_id, question_id)
        if events.get(question_id) != expected:
            fail("invalid event id for %s: expected %r, got %r" % (
                question_id, expected, events.get(question_id)
            ))

    mode = stat.S_IMODE(os.stat(db_path).st_mode)
    dir_mode = stat.S_IMODE(os.stat(os.path.dirname(db_path)).st_mode)
    if mode != 0o600 or dir_mode != 0o700:
        fail("persistence permissions are not private: dir=%s db=%s" % (
            oct(dir_mode), oct(mode)
        ))

    return {
        "ok": True,
        "model": model,
        "record_id": record_id,
        "elapsed_ms": summary.get("elapsedMs"),
        "events": events,
        "answers": answers,
        "database_mode": oct(mode),
        "directory_mode": oct(dir_mode),
    }


def main(argv):
    if len(argv) != 7:
        raise SystemExit(
            "usage: validate_real_laya_canary.py REQUEST RESPONSE RECORD MODEL DB ADAPTER_LOG"
        )
    request_path, response_path, record_path, model, db_path, adapter_log_path = argv[1:]
    with open(request_path) as f:
        request = json.load(f)
    with open(response_path) as f:
        response = json.load(f)
    with open(record_path) as f:
        record = json.load(f)
    with open(adapter_log_path, errors="replace") as f:
        adapter_log = f.read()
    result = validate_canary(request, response, record, model, db_path, adapter_log)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main(sys.argv)
