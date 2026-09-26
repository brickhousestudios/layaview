import importlib.util
import json
import sys
import threading
import types
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path


class FakeAgent:
    def __init__(self):
        self.calls = []

    def predict(self, state, questions):
        self.calls.append((state, questions))
        return {
            "kind": {"choice": "world_model_revision", "probabilities": {"world_model_revision": 0.7, "oracle_seeking": 0.3}},
            "severity": {"score": 2.1, "probabilities": {"0": 0.05, "1": 0.15, "2": 0.7, "3": 0.1}},
            "aligned": {"noul": 0.82},
        }


fake_agent = FakeAgent()
fake_laya = types.ModuleType("laya")
fake_laya.load = lambda model, device="cpu": fake_agent
sys.modules["laya"] = fake_laya

module_path = Path(__file__).resolve().parents[1] / "adapter" / "laya_server.py"
spec = importlib.util.spec_from_file_location("layaview_laya_adapter_test", module_path)
adapter = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(adapter)


class AdapterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), adapter.Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(self, path, method="GET", body=None, headers=None):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=2) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def test_health_is_local_model_identity(self):
        status, value = self.request("/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(value["backend"], "laya")
        self.assertEqual(value["model"], "convaiinnovations/laya-typed-decisions")

    def test_system_one_shape_and_derived_confidence(self):
        payload = json.dumps({
            "model": "laya-typed-decisions",
            "state": {"excerpt": "reviewed Mythos material"},
            "questions": {
                "kind": {"type": "choice", "criteria": {"world_model_revision": "revise", "oracle_seeking": "measure"}},
                "severity": {"type": "score", "criteria": ["none", "weak", "moderate", "strong"]},
                "aligned": {"type": "noul"},
            },
        }).encode()
        before = len(fake_agent.calls)
        status, value = self.request("/v1/systemone", "POST", payload, {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(len(fake_agent.calls), before + 1)
        self.assertEqual(value["answers"]["kind"]["choice"], "world_model_revision")
        self.assertEqual(value["answers"]["kind"]["confidence"], 0.7)
        self.assertEqual(value["answers"]["severity"]["confidence"], 0.7)
        self.assertEqual(value["answers"]["aligned"]["noul"], 0.82)
        self.assertNotIn("usage", value)

    def test_foreign_page_cannot_trigger_inference(self):
        payload = json.dumps({"state": {}, "questions": {"kind": {"type": "choice", "criteria": {"a": "A"}}}}).encode()
        before = len(fake_agent.calls)
        status, value = self.request("/v1/systemone", "POST", payload, {"Origin": "https://attacker.example", "Content-Type": "text/plain"})
        self.assertEqual(status, 403)
        self.assertIn("another site", value["error"])
        self.assertEqual(len(fake_agent.calls), before)

    def test_non_loopback_host_is_rejected(self):
        status, value = self.request("/healthz", headers={"Host": "attacker.example"})
        self.assertEqual(status, 403)
        self.assertEqual(value["error"], "host not allowed")


if __name__ == "__main__":
    unittest.main()
