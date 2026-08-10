# Local notes index

Build a Node.js CLI that indexes Markdown notes from one local directory and
supports case-insensitive keyword search.

The first release works offline, stores its index beside the notes, skips hidden
directories, and never modifies a note. It needs `index <directory>` and
`search <query>` plus tests for indexing, searching, and a missing directory.

No web UI, cloud sync, database server, watcher, or binary attachments.
