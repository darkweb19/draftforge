# Changelog

Notable changes are recorded here. The project uses Semantic Versioning for
public releases.

## 0.1.0

Initial CLI version for public distribution. No release date is recorded here;
use the
[npm package](https://www.npmjs.com/package/@draftforge-dev/draftforge) and
[GitHub releases](https://github.com/darkweb19/draftforge/releases) for current
publication records.

### Added

- Architecture interview, approval, task graph, isolated worker execution,
  durable resume, machine-first review, bounded repair, and integration.
- Codex CLI, Claude Code, OpenAI API, and Anthropic API routing.
- Deterministic npm tarball smoke testing and explicit backed-up project
  upgrades.
- Installation, provider, example, upgrade, troubleshooting, and security docs.

### Security

- Scope enforcement, locator-only secret findings, error redaction, guarded Git
  inspection, and fail-closed upgrade path checks.

The canonical package identity is `@draftforge-dev/draftforge` on npmjs. The
unscoped npm package `draftforge` belongs to an unrelated project. Release
automation targets GitHub Packages as a mirror of the exact tested tarball.
