# notewell

A command-line tool that indexes a directory of Markdown notes and answers
full-text queries against them without a database server.

## Problem

My notes live as plain `.md` files in one directory tree. Finding anything means
`grep -ri`, which is slow over a few thousand files, has no ranking, and cannot
tell a heading from body text or follow the tags I put in YAML front matter.

## What it should do

- `notewell index <dir>` walks a directory, reads every `.md` file, and builds a
  search index on disk.
- `notewell search <query>` prints matching notes ranked by relevance, newest
  first on ties, with the file path, the note title, and one matching line.
- `notewell search --tag <tag>` filters to notes whose front matter lists that
  tag.
- Re-running `index` only re-reads files whose size or mtime changed.

## Constraints

- Runs fully offline. No network calls, no server process, no external database.
- Node.js 22, TypeScript, distributed as a single npm package.
- The index is a file under a cache directory, not a service. Deleting it must
  be safe: the next `index` run rebuilds it.
- Front matter is YAML delimited by `---`. Notes without front matter are still
  indexed, just without tags.
- A note directory of ~5,000 files should index in a few seconds and answer a
  query in well under a second.

## Out of scope for the first release

- Editing, creating, or syncing notes.
- Any web UI or HTTP API.
- Embedding or vector search. Lexical ranking only.
