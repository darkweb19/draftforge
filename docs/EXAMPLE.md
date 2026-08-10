# Complete local-notes example

The committed [idea](../examples/local-notes/idea.md),
[questions](../examples/local-notes/questions.json), and
[plan](../examples/local-notes/plan.json) specify an offline Markdown index.
Product details and expected output here are illustrative placeholder data, not
customer evidence.

## Deterministic no-provider checkpoint

Initialize an empty project and copy those files into it as `idea.md`,
`questions.json`, and `plan.json`. Then run:

```bash
draftforge plan idea.md
draftforge plan --submit questions.json
draftforge plan --answer storage=JSON-file-beside-the-notes
draftforge plan --submit plan.json
draftforge plan --approve --by example-operator
draftforge status
draftforge handoff
```

This makes no model call; the checked-in responses replace two architect turns.
Documentation tests validate these transitions:

```text
planning: interview -> interview -> drafting -> approved
P01-T01: backlog -> ready
P01-T02: backlog (waiting for P01-T01)
```

For a live architect, replace each `--submit` with `draftforge plan --run`.

## Delegated run, review, and resume

Configure a workspace worker (`codex-cli` or `claude-cli`), an independent
reviewer, and Git. Before `run`, follow the
[Git initialization, ignore, and commit sequence](../README.md#shortest-working-flow)
so approved planning files are committed and generated run artifacts cannot
dirty the integration root. Then run:

```bash
draftforge doctor
draftforge run --by example-operator
draftforge status
draftforge review --by example-reviewer
```

Expected task lifecycle is `ready -> active -> review -> done`. Worker success
only reaches review; machine checks, reviewer acceptance, and integration are
required for done and for the dependent task to become ready.

After an interruption, run `draftforge resume --by example-operator`, then
review. Resume reuses the durable attempt/worktree and never claims new work.
If process termination is uncertain, it preserves work for inspection.

See [Providers](PROVIDERS.md), [Protocol](PROTOCOL.md), and
[Troubleshooting](TROUBLESHOOTING.md).
