# ADR 0006: Architect response contract and manual planning loop

Status: accepted

## Decision

The architect returns exactly one JSON envelope per turn — `{"kind":"questions",…}`
or `{"kind":"plan",…}` — and the expected kind is derived from planning state, not
chosen by the caller. Raw model text is parsed in `src/application/`, validated
against the domain contract, and only then applied through the existing
`submitQuestionBatch` and `submitPlan` guards.

The model-runner port lives in `src/application/ports.ts`. Until Phase 3 adapters
exist, the same seam is driven by hand: `plan --prompt` prints the prompt,
`plan --submit <file.json>` applies a recorded response, and
`plan --answer <id>=<text>` records interview answers.

## Why

A single-kind envelope makes a malformed or off-stage response a rejection rather
than a partial write. Deriving the stage from state stops a caller from asking for
a plan while blocking questions are open. A file-based checkpoint keeps the whole
planning loop exercisable and testable before any provider or authentication
exists, and it is the same input a Phase 3 adapter will produce.

## Consequences

Prompt text is deterministic, so prompt changes are diffable and testable. An
approved plan cannot be replaced through `--submit`; changing it requires the
recorded revision flow in P02-T03. Adding an adapter later changes no orchestration
code — it only supplies `ModelRunner`.
