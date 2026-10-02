# Working on Layaview

Layaview is a local-first visualizer for Laya decision models, derived from Jeview. It receives System One-shaped requests, forwards them to a configured local Laya adapter, stores complete calls in SQLite, and draws answer/event relationships live.

## Repository map

- `src/jeview.ts`: inherited server/store implementation. The filename and exported `createJeview` / `Jeview*` names intentionally remain for upstream-diff compatibility.
- `layaview.ts`: primary CLI.
- `jeview.ts`: compatibility launcher.
- `launch.sh`: Node launcher.
- `adapter/laya_server.py`: loopback Python Laya inference adapter.
- `scripts/run-layaview.sh`: full-stack local launcher.
- `ui/`: viewer, plain JavaScript with no build step.
- `demo/`: sample clients that drive the running viewer.
- `test/jeview.test.ts`: server contract tests against a stand-in Laya endpoint.
- `llms.txt`: generated agent-facing runtime contract.
- `UPSTREAM.md`: fork provenance and sync boundary.

## Check your work

```sh
npm install
npm run typecheck
npm run check:pages
npm test
python3 -m py_compile adapter/laya_server.py
git diff --check
```

Run `npm run llms` after changing `llmsText`; a test compares the generated file with the repository copy.

Ordinary tests must not call TypeSafe or download a model. Real Laya inference is an explicit runtime acceptance step.

## Rules of the house

- **No Node runtime dependencies.** Node 24 and its standard library are all the viewer needs.
- **Node runs TypeScript directly** by stripping types. Use erasable TypeScript only: no enums, namespaces, or parameter properties.
- **Keep inference separate.** Do not embed PyTorch or Laya inside the Node viewer. The viewer and Python adapter remain separate processes.
- **The body goes to the configured Laya endpoint byte for byte.** Layaview adds `events` only on the response side.
- **Layaview control headers never reach Laya.** Strip both `Layaview-*` and legacy `Jeview-*`.
- **No TypeSafe key gate or injected authorization.** Caller authorization is stripped before forwarding.
- **Loopback only by default.** Keep the viewer and included adapter on `127.0.0.1`; a change that broadens this trust boundary requires explicit review.
- **No telemetry or third-party browser resources.** The viewer CSP remains self-contained.
- **Recorded data is untrusted.** Build UI from DOM nodes/text rather than HTML strings.
- **Keep local data private.** The SQLite directory stays `0700`; the database stays `0600`.
- **Do not fake local cost.** Local Laya input-token metadata may be retained, but TypeSafe pricing must not be applied.
- **Preserve event semantics.** Event ids remain `<call>:<question>`; a later `Layaview-Trigger` grows a branch from that exact answer.
- **Preserve compatibility deliberately.** Legacy Jeview trigger/display headers and `--jev-endpoint` remain aliases unless a later migration explicitly removes them.
- **Preserve upstream lineage.** Do not rewrite or squash away the Jeview baseline tag or remove MIT attribution.

## Writing and commits

Keep changes focused. Comments explain non-obvious behavior and compatibility boundaries. Stage only intended files. Commit messages should describe what changed for the person using Layaview, with upstream provenance preserved.
