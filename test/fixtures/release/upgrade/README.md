# Upgrade fixtures

`test/upgrade-command.test.ts` materializes deterministic v1, v2, current,
future, modified-schema, and in-flight project variants from the same clean
initializer. Keeping the setup in the focused test guarantees the fixture state
and installed schema templates advance together without copying credentials,
local configuration, or run artifacts into the repository.
