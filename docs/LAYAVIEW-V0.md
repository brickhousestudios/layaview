# LayaView v0 product contract

## Purpose

LayaView is a local visual inspection tool for structured decisions.

It is **not** another chatbot and it is not a training system. Laya is the analysis engine; LayaView is the graph, history, provenance, and branch-inspection layer around those decisions.

## Origin

The project began from Jeview's useful local event-graph/viewer pattern. BrickHouse decided not to depend on Jev / TypeSafe as the core decision engine and instead preserve the visual model while replacing the remote decision dependency with a local Laya typed-decisions model.

The upstream Jeview baseline and MIT attribution remain preserved. See `UPSTREAM.md`.

## v0 architecture

```text
transcript / agent history / live caller
                |
                v
             LayaView
       local request boundary
                |
                v
        local Laya adapter
                |
                v
     Laya typed-decisions model
                |
                v
 decision events + alternatives + scores
                |
                v
  graph / history / search / provenance
```

### Ownership

- **Laya model**: produces structured decisions.
- **Python adapter**: owns model loading and inference translation.
- **LayaView Node server**: owns local ingress, persistence, event identity, trigger relations, history, search, and safe read APIs.
- **Viewer**: owns visualization only. It does not create decision truth.
- **SQLite**: local durable history for calls/events.

## Non-negotiables

- Local-first and loopback-first.
- No telemetry.
- No public bind by default.
- Keep inference separate from the viewer.
- Preserve full source/event provenance.
- Never fabricate a branch, probability, confidence, or model result.
- The viewer must distinguish observed model output from derived visualization metadata.
- Do not collapse the project into a chat UI.
- Preserve Jeview lineage instead of rewriting history.

## v0 outcome

A user can point a live decision stream or an imported transcript/history at LayaView, have local Laya produce structured decision records, and inspect a graph showing:

- the decision that was made,
- the options considered when available,
- scores/probabilities when supplied by the model,
- the event or prior decision that triggered the next branch,
- the original source text/event that the decision came from,
- the chronological history of the run.

## Work sequence

1. Freeze a stable Laya decision/event schema.
2. Add transcript/history ingestion alongside the current live proxy flow.
3. Normalize Laya adapter output into that schema.
4. Render chosen path and alternative branches distinctly.
5. Add click-through provenance from graph node to original source event/text.
6. Add confidence/option-distribution rendering only when provided by Laya; never infer fake probabilities.
7. Prove one real local Laya model end to end.
8. Package a one-command local demo.

## Current implementation checkpoint

The `feature/laya-native` branch already contains:

- Laya-native naming and runtime contract.
- local Python adapter,
- loopback launcher,
- credential/control-header stripping,
- SQLite persistence,
- trigger-chain/event graph behavior,
- local history/search,
- Jeview compatibility aliases,
- upstream provenance.

This document is the durable continuation point if chat context is lost.
