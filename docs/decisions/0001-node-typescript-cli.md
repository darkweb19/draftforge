# ADR 0001: Node.js and strict TypeScript

Status: accepted

## Decision

Build DraftForge as an ESM Node.js CLI in strict TypeScript, developed with npm. Support Node.js 22 and newer.

## Why

The ecosystem fits local CLI process control, JSON Schema, provider SDKs, and Sujan's primary stack. A single-language codebase keeps contribution and generated templates simple. npm is available in the current environment and avoids requiring another package manager.

## Consequences

Use Node cross-platform APIs and argument arrays rather than shell command strings. Keep runtime dependencies minimal. Compile distributable JavaScript before publishing.
