# ADR 0008: Provider adapter contract and shared reliability

Status: accepted

## Decision

Every provider adapter implements one `ModelAdapter` contract: static capability
discovery plus a single `run(AdapterRequest)` call. A `createModelRunner(config)`
factory routes each `ModelRole` to its configured adapter through a typed
registry and wraps every call in shared reliability — a per-call timeout,
bounded retry of transient failures only, and secret redaction. Adapters signal
transience through `AdapterError.retryable`; authentication and contract errors
are never retried.

## Why

Codex CLI, Claude Code, OpenAI, and Anthropic share the same orchestration needs
and differ only in transport and authentication. Centralizing routing, timeouts,
retries, and redaction keeps each adapter to transport plus error
classification, lets every adapter run against one reusable contract-test suite,
and scrubs secrets on a single path instead of four.

## Consequences

Adapters depend on the shared reliability and redaction helpers and must map
transport failures to `AdapterError` with a correct `retryable` flag.
`provider-default` stays valid configuration and is resolved by the adapter, not
the core. Capability discovery performs no I/O, so `doctor` and routing can
inspect adapters without a network or process call. The registry ships
placeholder factories until P03-T02 and P03-T03 supply the real transports.
