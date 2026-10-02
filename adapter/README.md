# Laya adapter

Layaview keeps model inference outside the Node viewer. This small loopback service loads one local Laya model and exposes the System One-shaped endpoint Layaview expects.

Default model: `convaiinnovations/laya-typed-decisions`

Default endpoint: `http://127.0.0.1:4778/v1/systemone`

The adapter accepts `{ "model": "...", "state": ..., "questions": {...} }` and returns `{ "model": "...", "answers": {...} }`.

Layaview adds `events` and owns trigger/branch visualization. The adapter does not receive `Layaview-*` headers.

## Local environment

Use Python 3.10 or newer; Laya 0.3.14 will not install on the macOS system Python 3.9. A compatible local setup is:

```sh
uv venv .venv --python 3.11
uv pip install --python .venv/bin/python torch --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .venv/bin/python laya==0.3.14
```

Run directly:

```sh
HF_HOME="$HOME/BrickHouse/models/huggingface" .venv/bin/python adapter/laya_server.py
```

The service binds only to `127.0.0.1`.


## Real-model acceptance

The ordinary test suite never downloads or runs model weights. Run the explicit acceptance canary when validating the local inference path:

```sh
scripts/real-laya-canary.sh
```

The canary starts a temporary loopback Laya adapter and LayaView instance, sends a real typed-decision request through LayaView, verifies that the model identity and answers came from the loaded Laya checkpoint, reads the stored SQLite record back, checks the private `0700`/ `0600` persistence permissions, and then shuts the temporary processes down.

Set `LAYAVIEW_CANARY_KEEP=1` to keep its temporary logs/database for inspection. The model cache defaults to `$HOME/BrickHouse/models/huggingface`.
