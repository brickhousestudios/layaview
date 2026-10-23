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

## Frozen decision/event schema — 2026-10-03

New records expose `layaview.decision-event.v1` under each summary's `events` array. The boundary is deliberate:

- `model.observed` contains only fields actually returned by Laya: typed result (`choice`, `score`, or `noul`), exact `probabilities`, and `confidence` only when present.
- `derived` contains LayaView work: landing/nearest-level selection, selected probability, event identity relationships, and uncertainty labels.
- `provenance` identifies the source, request hash, state hash, run label, and time.
- `derived.uncertainty.confidence` is `reported` or `missing`; missing confidence is never reconstructed from a probability.
- `derived.uncertainty.calibration` is `warning` only when the adapter captured a concrete runtime calibration warning, otherwise `unspecified`. `unspecified` never means calibrated.
- Probability values are kept at the precision Laya returned; the summary layer does not round them.

The older compact `questions` fields remain for viewer/backward compatibility, but they follow the same truth rule: `confidence` is absent unless Laya supplied it and `p` is explicitly viewer-derived from an observed distribution or binary `noul` value.

### Transcript/history ingestion

`POST /_/api/ingest` accepts one structured history item:

```json
{
  "source": { "kind": "transcript", "id": "turn-17", "at": "...", "text": "...", "uri": "..." },
  "label": "optional-run-label",
  "trigger": "optional-prior-event-id",
  "request": { "model": "...", "state": {}, "questions": {} }
}
```

`source.kind` is `transcript` or `history`. LayaView sends only `request` through the same configured Laya adapter used by live calls and persists the source provenance beside the resulting record. It does **not** invent questions from transcript text, synthesize answers, or infer missing confidence. Imported source text is searchable through the existing local search API.

The endpoint imports structured items only. It does **not** automatically turn arbitrary transcripts into questions: the caller supplies each item's typed questions explicitly in `request.questions`, and LayaView never derives questions from `source.text`.

In the graph, solid/filled outcomes are chosen paths. Hollow dashed outcomes appear only when a model distribution supplied an alternative; viewer-derived binary complements use a different dotted treatment. Clicking either resolves back to the recorded call and, for imports, its original source provenance.

## Real local Laya acceptance — 2026-10-02

The first real-model canary passed on M4 with:

- Python 3.11
- `laya==0.3.14`
- CPU PyTorch
- model `convaiinnovations/laya-typed-decisions`
- adapter on loopback `127.0.0.1:4778`
- LayaView on loopback `127.0.0.1:4777`

The representative request described an agent claiming deployment success while the health endpoint returned HTTP 503 and no artifact checksum existed. Two typed questions were sent through LayaView: one `choice` assessment and one severity `score`.

The real model returned structured answers with option distributions. For the assessment it selected `verified_success` with probability `0.51`, while `unsupported_success_claim` was `0.2376` and `ordinary_failure` was `0.2524`. The model-reported confidence was low (`0.0603`). This is **not** treated as a correctness pass for the model. It is evidence that LayaView preserves and exposes the model's actual decision rather than rewriting an inconvenient result.

Laya 0.3.14 also warned that this checkpoint contains at least one out-of-range temperature entry which it clamps; confidence for the affected bucket must therefore be treated as uncalibrated. LayaView must preserve that uncertainty rather than presenting confidence as stronger than the model/runtime supports.

The end-to-end path was proven:

```text
real input
  -> LayaView
  -> local Laya adapter
  -> convaiinnovations/laya-typed-decisions
  -> structured choice + score distributions
  -> LayaView event IDs
  -> private SQLite persistence
  -> /_/api/records readback
  -> viewer root 200
```

The persisted record retained the exact source request and the raw model response. The data directory was mode `0700` and the SQLite file was `0600`.

Re-run this explicit acceptance without adding model inference to the ordinary unit suite:

```sh
npm run acceptance:laya
```

The canary validates the local inference/persistence/readback plumbing. It does not certify Laya's semantic accuracy on the example.

### Acceptance addendum — 2026-10-23 (through ingestion)

The same example was re-run through `POST /_/api/ingest` (transcript source `canary-2026-10-02`) against the real local model on CPU, in an isolated data directory (dir `0700`, SQLite `0600`). Plumbing passed end to end: the persisted `layaview.decision-event.v1` events carried the model's exact observed output, the source provenance, and the runtime warning verbatim; readback matched the ingest.

The model's judgment failed the same way again: it selected `verified_success` (probability `0.4362`, reported confidence `0.0208`) for the HTTP-503 observation, with severity score `1.8698`. As before, this is recorded as a model judgment failure, not corrected or rewritten.

One truth-labeling fix came out of this run: the adapter's calibration classifier had been written against a paraphrase of Laya's warning ("clamp"/"range"), so the real warning text — "invalid temperatures or values outside [0.5, 5] ... Treat confidence from the affected entries as uncalibrated" — was classified `unspecified` even though the warning itself was preserved. The classifier now recognizes the warning's actual vocabulary (including an explicit `uncalibrated` statement), and the re-run records `derived.uncertainty.calibration: "warning"` for both events, with a regression test using the verbatim warning.
