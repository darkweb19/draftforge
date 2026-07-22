# ADR 0004: DAG tasks, isolated workers, independent review

Status: accepted

## Decision

Represent implementation as a dependency graph of bounded task contracts. Execute non-conflicting ready tasks in isolated Git worktrees. Require a separate reviewer decision before completion.

## Why

The lead model must manage rather than implement. Explicit dependencies and path ownership make delegation predictable, while independent review prevents workers from self-certifying incomplete output.

## Consequences

The scheduler must detect cycles and path conflicts. Parallel work has a configurable cap. Failed tasks keep their evidence and can enter a bounded repair loop or become blocked.
