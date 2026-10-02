import copy
import importlib.util
import os
import stat
import tempfile
import unittest
from pathlib import Path


module_path = Path(__file__).resolve().parents[1] / "scripts" / "validate_real_laya_canary.py"
spec = importlib.util.spec_from_file_location("layaview_real_canary_validation_test", module_path)
validator = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(validator)


MODEL = "convaiinnovations/laya-typed-decisions"


def fixture(tmp):
    data = Path(tmp) / "data"
    data.mkdir(mode=0o700)
    os.chmod(data, 0o700)
    db = data / "layaview.sqlite"
    db.write_bytes(b"sqlite placeholder")
    os.chmod(db, 0o600)
    request = {
        "model": MODEL,
        "state": {"observation": "example"},
        "questions": {
            "assessment": {"type": "choice", "criteria": {"a": "A", "b": "B"}},
            "severity": {"type": "score", "criteria": ["none", "high"]},
        },
    }
    answers = {
        "assessment": {"type": "choice", "choice": "a", "probabilities": {"a": 0.6, "b": 0.4}},
        "severity": {"type": "score", "score": 0.8, "probabilities": {"0": 0.2, "1": 0.8}},
    }
    response = {
        "model": MODEL,
        "answers": answers,
        "events": {"assessment": "7:assessment", "severity": "7:severity"},
    }
    record = {
        "summary": {"id": 7, "status": 200, "answeredBy": MODEL, "elapsedMs": 12},
        "request": request,
        "response": {"model": MODEL, "answers": copy.deepcopy(answers)},
    }
    log = '{"event": "loaded", "model": "%s", "device": "cpu"}\n' % MODEL
    return request, response, record, str(db), log


class CanaryValidationTest(unittest.TestCase):
    def test_valid_record_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            request, response, record, db, log = fixture(tmp)
            result = validator.validate_canary(request, response, record, MODEL, db, log)
            self.assertTrue(result["ok"])
            self.assertEqual(result["events"]["assessment"], "7:assessment")

    def test_missing_requested_answer_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            request, response, record, db, log = fixture(tmp)
            response["answers"].pop("severity")
            response["events"].pop("severity")
            record["response"]["answers"].pop("severity")
            with self.assertRaisesRegex(validator.CanaryValidationError, "exactly match requested"):
                validator.validate_canary(request, response, record, MODEL, db, log)

    def test_malformed_event_id_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            request, response, record, db, log = fixture(tmp)
            response["events"]["severity"] = "wrong"
            with self.assertRaisesRegex(validator.CanaryValidationError, "invalid event id"):
                validator.validate_canary(request, response, record, MODEL, db, log)

    def test_non_private_persistence_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            request, response, record, db, log = fixture(tmp)
            os.chmod(db, 0o644)
            with self.assertRaisesRegex(validator.CanaryValidationError, "not private"):
                validator.validate_canary(request, response, record, MODEL, db, log)


if __name__ == "__main__":
    unittest.main()
