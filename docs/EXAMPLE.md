# Worked example

This walks one project — `notewell`, a local Markdown note indexer and search
CLI — from a draft idea to an approved plan, and then explains what delegated
execution does with that plan.

The example ships in this repository:

- `examples/idea.md` — the source draft.
- `examples/planning/questions.json` — a recorded architect question batch.
- `examples/planning/plan.json` — a recorded architect plan.

The two JSON files are *recorded architect responses*. DraftForge normally gets
them from a provider, but `plan --submit` accepts a file instead, which is what
makes Part 1 below reproducible.

Part 1 needs no provider, no API key, and no network. Part 2 needs an
authenticated agent harness.

Install first if you have not: see [INSTALLATION.md](INSTALLATION.md).

## Part 1 — planning, deterministic and provider-free

Every command in this part runs offline. No model is called at any point.

### Set up the project

```bash
mkdir notewell && cd notewell
draftforge init . --name notewell
```

```text
created  .draftforge/state.json
created  .draftforge/config.json
created  .draftforge/schema/state.schema.json
created  .draftforge/schema/config.schema.json
created  .draftforge/schema/planning.schema.json
created  .draftforge/schema/execution.schema.json
created  .draftforge/tasks/.gitkeep
created  .draftforge/runs/.gitkeep
created  SESSION.md
created  AGENTS.md
created  CLAUDE.md
created  PHASES.md
created  idea.md
Initialized notewell at /path/to/notewell.
Next: describe the project in idea.md, then run `draftforge plan idea.md`.
```

`init` writes a placeholder `idea.md`. Replace it, and copy in the recorded
architect responses, from a checkout of this repository:

```bash
cp path/to/draftforge/examples/idea.md idea.md
mkdir -p planning
cp path/to/draftforge/examples/planning/*.json planning/
```

`plan --submit` resolves its argument relative to the project root, so the
responses have to live inside the project.

### Start planning

```bash
draftforge plan idea.md
```

```text
Initialized planning revision 1 from idea.md.
No provider was called. Next: `draftforge plan --prompt`.
```

This only records that revision 1 of planning is sourced from `idea.md`. It
reads the draft to prove it exists and writes `.draftforge/planning.json`.

### Print the architect prompt

```bash
draftforge plan --prompt
```

The stage is derived from planning state, never chosen by you. Planning has no
questions yet, so the requested output is `questions`:

````text
# System
You are the architect role of DraftForge, a CLI that turns a product draft into
decisions and a reviewable task graph executed by isolated worker agents.

Rules:
- Ask every material follow-up question in ONE batch. Never drip-feed questions.
- Decide naming, structure, stack, and phase boundaries unless the draft constrains them.
- State assumptions explicitly instead of asking about low-stakes details.
- Produce tasks small enough for an isolated worker with non-overlapping owned paths.
- Never write implementation code and never approve your own plan.

Reply with a single JSON object and nothing else. No prose, no explanation.
A fenced ```json block is accepted; anything else is rejected.

# User
# Project: notewell
Planning revision: 1
Requested output: questions

# Source draft (idea.md)

[the full text of idea.md]

# Revision

This is the first planning revision.

# Answered questions

None yet.

# Required output

Return the complete question batch for this revision:

[the questions JSON template and its constraints]

Mark a question `blocking` only when the plan cannot be written without it.
Every `answer` must be null; answers come from the user, not from you.
````

`--prompt` writes nothing. It exists so you can paste the prompt into any agent
and bring the answer back, which is exactly what the recorded responses are.

### Submit the recorded question batch

`examples/planning/questions.json` is what an architect returned for this draft:

```json
{
  "kind": "questions",
  "questions": {
    "revision": 1,
    "items": [
      {
        "id": "Q1",
        "prompt": "Where should the on-disk index live, and may notewell own that path exclusively?",
        "blocking": true,
        "answer": null
      },
      {
        "id": "Q2",
        "prompt": "Should ranking be term-frequency scoring over the whole note, or should headings and titles be weighted above body text?",
        "blocking": true,
        "answer": null
      },
      {
        "id": "Q3",
        "prompt": "Should `search` emit machine-readable JSON in addition to the human table?",
        "blocking": false,
        "answer": null
      }
    ]
  }
}
```

```bash
draftforge plan --submit planning/questions.json
```

```text
Recorded 3 architect question(s) for revision 1.
Next: answer them with `draftforge plan --answer <id>=<text>`.
```

The submitted JSON is parsed and validated at the boundary. A response whose
`kind` does not match the stage DraftForge is waiting for is rejected, as is a
malformed envelope; both exit `1` and change nothing.

```bash
draftforge plan --status
```

```text
Planning revision: 1
Source: idea.md
Status: interview
Questions: 0/3 answered; 2 blocking unanswered
Plan: missing
Approval: not approved
```

### Answer the blocking questions

Only blocking questions gate the plan. `Q3` can stay unanswered.

```bash
draftforge plan --answer "Q1=Use the platform user cache directory; notewell owns it exclusively."
```

```text
Recorded answers: Q1.
Blocking questions remaining: 1.
```

```bash
draftforge plan --answer "Q2=Weight titles and headings above body text."
```

```text
Recorded answers: Q2.
Blocking questions remaining: 0.
```

`--answer` is repeatable within one invocation. Each answer must be non-empty,
and the same question ID cannot be given twice in one command.

### Print the prompt again

```bash
draftforge plan --prompt
```

With no blocking questions outstanding the stage advances by itself. The system
block is identical; the user block now reads:

```text
# User
# Project: notewell
Planning revision: 1
Requested output: plan

# Source draft (idea.md)

[the full text of idea.md]

# Revision

This is the first planning revision.

# Answered questions

- Q1: Where should the on-disk index live, and may notewell own that path exclusively?
  Answer: Use the platform user cache directory; notewell owns it exclusively.
- Q2: Should ranking be term-frequency scoring over the whole note, or should headings and titles be weighted above body text?
  Answer: Weight titles and headings above body text.

# Required output

Return the full plan for this revision:

[the plan JSON template]

Constraints enforced on ingest:
- Phase IDs match `phase-NN`; task IDs match `PNN-TNN` and share their phase number.
- `dependsOn` references existing task IDs, is not self-referential, and is acyclic.
- `adrFile`, `ownedPaths`, `requiredContext`, and `relevantAdrs` are project-relative
  paths without `..`; ADR files live under `docs/decisions/` and end in `.md`.
- The first phase is the active phase and must contain at least one task with no
  dependencies.
```

The recorded answers are carried into the prompt, so an architect writing the
plan sees the decisions you already made.

### Submit the recorded plan

`examples/planning/plan.json` declares two ADRs, two phases, four tasks, and two
risks. Its task DAG is `P01-T01 -> P01-T02 -> P02-T01 -> P02-T02`. The first
task owns the npm and strict-TypeScript scaffold (`package.json`, lockfile,
`tsconfig.json`, and `.gitignore`) plus `src/parse/` and `test/parse/`. Each later
task owns only its matching source and test trees: `src/index/` + `test/index/`,
`src/query/` + `test/query/`, then `src/cli/` + `test/cli/`. No owned paths
overlap.

```bash
draftforge plan --submit planning/plan.json
```

```text
Recorded a draft plan for revision 1.
Next: `draftforge plan --approve --by <actor>`.
```

The plan is validated on ingest against the constraints printed above. Nothing
is materialized yet — a draft plan is not consent.

### Approve

```bash
draftforge plan --approve --by sujan
```

```text
Approved planning revision 1. Ready tasks: P01-T01.
```

Approval is the gate. It records who approved, then writes the generated
project files and the runnable state:

```text
PHASES.md                                        (rewritten from the plan)
docs/decisions/0001-single-file-inverted-index.md
docs/decisions/0002-field-weighted-ranking.md
.draftforge/tasks/P01-T01.md
.draftforge/tasks/P01-T02.md
.draftforge/tasks/P02-T01.md
.draftforge/tasks/P02-T02.md
SESSION.md                                       (re-rendered)
```

Only `P01-T01` is ready: it is the one task in the active phase with no
dependencies. The other three stay `backlog` until their predecessors are
accepted.

`P01-T01` deliberately creates the project scaffold before any verification can
run: it owns and creates `package.json`, `package-lock.json`, `tsconfig.json`,
`.gitignore`, `src/parse/`, and `test/parse/`. Its package scripts provide
`npm test`, `npm run typecheck`, and the build; its strict TypeScript
configuration covers the parser it implements; and its owned parser tests make
both declared verification commands meaningful in the freshly initialized
project. Successors inherit that accepted scaffold. Each successor creates its
source and tests only in its own matching pair of non-overlapping directories.

`--approve` refuses to clobber a file it did not generate. If, say, you already
had a hand-written `docs/decisions/0001-single-file-inverted-index.md`, approval
aborts before writing anything.

### Where you end up

```bash
draftforge status
```

```text
notewell: phase-01 / implementation / in_progress
Current task: none
Next task: P01-T01
[PASS] state: .draftforge/state.json is valid
[PASS] config: configuration is valid
[PASS] handoff: SESSION.md matches canonical state
```

```bash
draftforge plan --status
```

```text
Planning revision: 1
Source: idea.md
Status: approved
Questions: 2/3 answered; 0 blocking unanswered
Plan: present
Approval: approved by sujan
```

That is the whole deterministic path. Every command above exits `0`.

Planning is now closed for revision 1: a further `--prompt` or `--submit` is
refused until you open a recorded revision with
`draftforge plan --revise --reason <text> --by <actor>`.

## Part 2 — delegated execution, requires an authenticated harness

Everything below calls a real agent. It is not part of the deterministic path.

### Prerequisites

- **A workspace-capable worker route.** `run` and `resume` dispatch a worker
  into a Git worktree, so the worker must be able to read and write files.
  `codex-cli` and `claude-cli` are the only workspace-capable adapters. An
  API-backed worker route is text-only and is refused **before any task state
  changes**:

  ```text
  The configured worker route is text-only or does not declare workspace access. Select a workspace-capable codex-cli or claude-cli worker before claiming a task.
  ```

  That refusal exits `2`. Set `roles.worker.adapter` in `.draftforge/config.json`
  to `codex-cli` or `claude-cli`; see [PROVIDERS.md](PROVIDERS.md). The architect
  and reviewer roles may use API adapters — only the worker needs a workspace.
- **A Git repository with at least one commit** at the project root. Worktree
  creation fails otherwise and the attempt is recorded as blocked with
  `Worker workspace setup failed.`
- **A clean project root** before `review` integrates. A dirty root aborts the
  merge.

### Run

```bash
draftforge run --by sujan
```

`run` reconciles first, then claims ready work up to `roles.worker.maxConcurrency`
and dispatches each task into its own worktree at
`.draftforge/runs/<run-id>/worktrees/<task-id>`. It reports every outcome class
on its own line: dispatched, resumed, reconciled, deferred (with a reason per
task), review-ready, blocked, orphan attempts, and no-work.

For this plan, the first `run` can only claim `P01-T01`; `P01-T02` defers with
reason `dependency`, and the phase-02 tasks are not ready at all.

Transitions:

```text
ready -> active            when the attempt is claimed and dispatched
active -> review           when the worker returns a valid, in-scope result
active -> blocked          on failure, timeout, or a scope violation
```

**`run` never marks a task `done`.** A worker result advances a task only as far
as `review`. A successor stays blocked while its predecessor is `active` or
`review`; only an accepted `done` predecessor releases it.

### Resume

```bash
draftforge resume --by sujan
```

`resume` continues interrupted attempts and claims no new work. It reuses the
same attempt identity and the same worktree — it never opens a second attempt
for the same interrupted work. If a valid result was already persisted but the
task is still `active`, resume finalizes it to `review` or `blocked` **without
another model call**. Reconciliation is idempotent.

`resume` never marks a task `done` either. Some states are deliberately
unresolvable — a result event with no result artifact, or a worker process that
may still be alive — and resume refuses them rather than guessing, preserving
the attempt and its worktree for inspection. See the safe-resume table in
[PROTOCOL.md](PROTOCOL.md).

### Review

```bash
draftforge review --by sujan
```

`review` is the only command that can complete a task. It is machine-first: for
each task awaiting review it runs the contract's allowlisted verification, the
authoritative scope check, and a secret scan *before* a reviewer verdict is
used, then re-checks scope and secrets before accepting.

Transitions:

```text
review -> active           a bounded repair attempt, keeping the rejected worktree
review -> done             accepted, after the attempt branch is merged
review -> blocked          terminal for automation
```

Only `verification-failure` and `review-rejection` can repair, and the repair
counter is durable and bounded by `limits.maxRepairAttempts`. A secret
detection, scope violation, contract violation, timeout, or integration conflict
is terminal — the task stays blocked until a human reopens it. Rollback is
always manual: DraftForge records a rollback point but never resets or reverts
on its own.

After `P01-T01` is accepted, `P01-T02` becomes ready and the next `run` claims
it. Repeat run/review through the DAG.

### Exit codes

These are the same for `run`, `resume`, and `review`:

| Code | Meaning |
| --- | --- |
| `0` | Nothing failed. A deferred or no-work invocation is still `0`. |
| `1` | A task is blocked, or an attempt needs manual inspection. |
| `2` | Refused before touching task state: bad options, an unapproved plan, or a non-workspace-capable worker route. |

Exit `2` is the safe one: nothing changed. Exit `1` means state moved and you
should read the attempt artifacts under `.draftforge/runs/` before doing
anything else.

## If something goes wrong

`draftforge status` and `draftforge doctor` are the first two commands to run.
See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for authentication failures,
dirty-root refusals, retained worktrees, lock recovery, and blocked tasks; and
[../README.md](../README.md) for the command surface.
