# Delivery phases

Phases for {{projectName}} have not been planned yet.

Describe the project in `idea.md`, then run:

```bash
draftforge plan idea.md
```

Planning replaces this file with the approved phase list. Until then the project sits in
`phase-00 — Intake` with no runnable tasks.

Rules that apply once phases exist:

- Only one phase is active at a time.
- A phase closes only when its exit gate passes.
- Closing a phase updates `.draftforge/state.json` and regenerates `SESSION.md`.
