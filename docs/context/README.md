# Context Inbox

Dump anything here that carries project context but has no structured home
yet: client emails, call transcripts, whiteboard photos, spec fragments,
competitor notes, Slack excerpts. Any format.

The rules:

1. **Dumping is free.** No naming convention, no template. Drop the file.
2. **Every file is tracked.** `python3 .agents/scripts/forge.py context scan`
   registers new/changed files in `ledger.json` as `pending`. CI fails if the
   ledger is out of sync with the files on disk (`context scan --check`).
3. **Pending files get harvested, not read ad hoc.** An agent following
   `.agents/prompts/harvester.md` extracts decisions (as `docs/decisions/`
   records, `status: proposed` — a human confirms), proposes BRIEF /
   architecture updates, then marks the file:
   `forge.py context mark <file> --harvested --outputs <paths>`.
4. **Sources are never deleted or edited.** The inbox is the raw record;
   the harvest turns it into canonical docs. Irrelevant files get
   `--ignored` with a note, not removal.
5. Agents exploring the repo: treat `pending` entries as **unprocessed
   context** — check the ledger before assuming BRIEF/architecture/decisions
   are complete.
