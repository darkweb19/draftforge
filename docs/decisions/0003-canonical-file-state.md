# ADR 0003: Canonical JSON state with generated Markdown handoff

Status: accepted

## Decision

Store canonical workflow state in `.draftforge/state.json`, validate it against a versioned schema, and generate root `SESSION.md` from that state.

## Why

Markdown is easy for agents and humans but unreliable for state transitions. JSON is deterministic and portable. Keeping a generated Markdown mirror makes handoffs readable without creating two competing sources of truth.

## Consequences

Agents must update JSON first and render the handoff. A consistency check fails when `SESSION.md` is stale. Schema migrations are required when `schemaVersion` changes.
