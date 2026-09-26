# Laya adapter

Layaview keeps model inference outside the Node viewer. This small loopback service loads one local Laya model and exposes the System One-shaped endpoint Layaview expects.

Default model: `convaiinnovations/laya-typed-decisions`

Default endpoint: `http://127.0.0.1:4778/v1/systemone`

The adapter accepts `{ "model": "...", "state": ..., "questions": {...} }` and returns `{ "model": "...", "answers": {...} }`.

Layaview adds `events` and owns trigger/branch visualization. The adapter does not receive `Layaview-*` headers.

## Local environment

Use a Python environment that already has the CPU build of PyTorch and Laya 0.3.14. A compatible setup is:

```sh
uv venv .venv --python /usr/bin/python3
uv pip install --python .venv/bin/python torch --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .venv/bin/python laya==0.3.14
```

Run directly:

```sh
HF_HOME="$HOME/BrickHouse/models/huggingface" .venv/bin/python adapter/laya_server.py
```

The service binds only to `127.0.0.1`.
