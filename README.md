# Layaview

Layaview is a local-first live visualizer for **Laya** decision-model calls. It is a BrickHouse fork of [Jeview](https://github.com/andududu/jeview), preserving Jeview's event graph, local SQLite history, search, labels, and trigger-chain visualization while replacing TypeSafe Jev with a local Laya backend.

```text
your code
    ↓
Layaview 127.0.0.1:4777
    ↓
local Laya adapter 127.0.0.1:4778
    ↓
Laya typed-decisions model
```

The fork started from Jeview commit `495a4e43e9d67e495a66ab0d9e55ac1c5c4040d6`. The original MIT license and attribution are preserved. See [UPSTREAM.md](UPSTREAM.md).

## What Layaview does

A client sends a System One-shaped body `{ model, state, questions }`. Layaview forwards the exact body to the configured Laya adapter, returns Laya's answer, adds one event id per answer, stores the call in a local SQLite database, and draws the decisions live.

Laya inference remains a separate process. Layaview owns visualization, history, event ids, labels, search, and trigger relationships; the Python adapter owns model loading and inference.

## Run it

Layaview needs Node 24 or later. The included adapter needs a Python environment with Laya and a CPU-compatible PyTorch install. See [adapter/README.md](adapter/README.md).

On the Lenovo BrickHouse node, the launcher can reuse the existing Laya environment:

```sh
./scripts/run-layaview.sh
```

This starts:

- Laya adapter: `http://127.0.0.1:4778/v1/systemone`
- Layaview: `http://127.0.0.1:4777/`

The launcher waits for `/healthz` before starting Layaview and stops the adapter when Layaview exits.

To run only the viewer against an already-running adapter:

```sh
./launch.sh --laya-endpoint http://127.0.0.1:4778/v1/systemone
```

## Send decisions through it

POST to `http://127.0.0.1:4777/v1/systemone`. Group calls into a run by putting a label before the path, for example `http://127.0.0.1:4777/mythos-5/v1/systemone`.

Every answer comes back with an event id in `events`. When a later call follows from one answer, send that event id with `Layaview-Trigger: <event id>`. The new call then grows from that answer in the live map.

`Layaview-Display` can select a display field from structured choice criteria. Legacy `Jeview-Trigger` and `Jeview-Display` headers remain accepted for upstream compatibility, but neither spelling is forwarded to Laya.

Agents and scripts can read `http://127.0.0.1:4777/llms.txt` for the live contract.

## Local-only security model

Layaview and the included adapter bind to `127.0.0.1` only by default. Layaview keeps Jeview's Host and Origin protections and strips caller authorization, cookies, origins, and its own control headers before forwarding a request.

Calls are stored in `layaview.sqlite` under the selected data directory. The data directory is mode `0700` and the database is mode `0600`.

There is no TypeSafe API-key requirement and no TypeSafe dollar-cost estimate. Layaview may display local input-token metadata if an adapter returns it, but it does not price local inference.

Do not expose Layaview or the adapter on a public interface. Recorded calls may contain private state.

## Options

- `--port 4777`
- `--dir ~/.local/share/layaview`
- `--laya-endpoint http://127.0.0.1:4778/v1/systemone`

`--jev-endpoint` remains a compatibility alias for `--laya-endpoint`; do not use both at once.

## Development

The Node viewer keeps Jeview's zero-runtime-dependency design.

```sh
npm install
npm run typecheck
npm run check:pages
npm test
python3 -m py_compile adapter/laya_server.py
git diff --check
```

When `llmsText` changes, run `npm run llms`.

The ordinary Node test suite uses a stand-in Laya endpoint and never downloads or calls a model. Actual model acceptance is a separate runtime test against local Laya.

## License

MIT. Layaview is derived from Jeview; upstream provenance is documented in [UPSTREAM.md](UPSTREAM.md).
