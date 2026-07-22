# ADR 0002: Provider port and role-based routing

Status: accepted

## Decision

Define one model-runner port and separate adapters for Codex CLI, Claude Code, OpenAI API, and Anthropic API. Configuration routes architect, worker, and reviewer roles independently.

## Why

Subscriptions are available through authenticated local harnesses, while API keys use usage-based provider APIs. These are different transports and authentication systems. Role routing preserves quality and cost choices without embedding volatile model IDs.

## Consequences

Provider-specific flags, output parsing, and authentication checks stay inside adapters. `provider-default` is valid configuration. Adding a provider does not change orchestration logic.
